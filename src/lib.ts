/**
 * Pure / side-effect-free helpers extracted from index.ts so they can be
 * unit-tested without spawning real sudo or loading the Pi extension host.
 */

import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	truncateHead,
} from "@oh-my-pi/pi-coding-agent";
import { spawnTool } from "./pix-runtime/exec.ts";

// Pi's own tool-output limits (50KB / 2000 lines), so every tool caps the same way.
export const MAX_OUTPUT_BYTES = DEFAULT_MAX_BYTES;
export const MAX_OUTPUT_LINES = DEFAULT_MAX_LINES;

// ── Output truncation ────────────────────────────────────────────────────────

export function truncate(
	text: string,
	maxLines = MAX_OUTPUT_LINES,
	maxBytes = MAX_OUTPUT_BYTES,
): { text: string; truncated: boolean } {
	const r = truncateHead(text, { maxLines, maxBytes });
	// omp 19.1.1 的 TruncationResult.truncated 是可选的（pi-tui streaming-output.ts:133，
	// 无截断时省略），用 `=== true` 收敛成 boolean。
	if (!r.firstLineExceedsLimit) return { text: r.content, truncated: r.truncated === true };
	// One line over the byte cap (minified JSON, a base64 blob): truncateHead keeps
	// nothing. Keep its first maxBytes instead, cut on a UTF-8 boundary.
	const head = Buffer.from(text, "utf8").subarray(0, maxBytes).toString("utf8");
	return { text: head.replace(/\uFFFD$/, ""), truncated: true };
}

// ── sudo stderr filter ───────────────────────────────────────────────────────

/**
 * Strip sudo's password prompt from stderr.
 *
 * The prompt is localized ("[sudo] password for u: ", "[sudo] u 的密码："), so
 * this matches the `[sudo] …:` prefix rather than English words — matching the
 * English text leaked the prompt into error output and, worse, made a localized
 * "sorry, try again" look like a fatal sudo error.
 */
export function filterSudoPrompt(raw: string): string {
	return raw
		// ASCII ":" (C/en locale) and full-width "：" (zh/ja translations).
		.replace(/\[sudo\][^\n:：]*[:：]\s?/g, "")
		.split("\n")
		.map((line) => line.trimEnd())
		.filter((line) => line.length > 0)
		.join("\n");
}

// ── Auth-failure detection ───────────────────────────────────────────────────

export function detectAuthFailure(code: number, stderr: string): boolean {
	if (code === 0) return false;
	const lower = stderr.toLowerCase();
	return (
		lower.includes("incorrect password") ||
		lower.includes("authentication failure") ||
		lower.includes("sorry,") ||
		stderr.includes("3 incorrect password attempts")
	);
}

// ── sudo runner ──────────────────────────────────────────────────────────────

export interface SudoResult {
	stdout: string;
	stderr: string;
	code: number;
}

/**
 * Validate a sudo password with a minimal command and refresh the PAM ticket.
 * This keeps password checking separate from the requested command, so the UI
 * does not display "Checking password…" for the command's full runtime.
 */
export function validateSudoPassword(password: string, signal?: AbortSignal): Promise<SudoResult> {
	// Force the C locale for the probe: sudo and PAM localize their diagnostics,
	// and this call's stderr is parsed (retry vs. structural failure) and shown
	// to the user. The requested command keeps the user's locale.
	return spawnSudo(["-S", "-v"], password, signal, { LC_ALL: "C", LANG: "C" });
}

/**
 * True when sudo has a valid cached PAM ticket — `sudo -n true` exits 0
 * without prompting. Lets the caller skip the password stage on repeat calls
 * within the system sudoers timeout (default ~15 min).
 */
export function hasValidTicket(): Promise<boolean> {
	// `sudo -n true` can hang under LDAP/SSSD-backed sudoers: the non-interactive
	// path still consults the auth backend. 5 s is generous for a ticket check
	// (local PAM answers in ms) and turns a hung probe into "no ticket", which
	// routes the caller through the password overlay instead of blocking the
	// card forever. The timer never rejects — it just resolves false.
	const probe = Promise.withResolvers<boolean>();
	try {
		const proc = spawnTool("sudo", ["-n", "true"], { stdio: ["ignore", "ignore", "ignore"] });
		proc.on("error", () => probe.resolve(false));
		proc.on("close", (code) => probe.resolve(code === 0));
	} catch {
		// sudo missing: no ticket; runWithSudo reports the hint
		probe.resolve(false);
	}
	const timeout = Promise.withResolvers<boolean>();
	setTimeout(() => timeout.resolve(false), 5_000);
	return Promise.race([probe.promise, timeout.promise]);
}

/**
 * Run `command` via `sudo -S -- sh -c <command>`, piping `password` to stdin.
 * Drops `-k` so sudo's PAM timestamp cache persists across calls — a valid
 * ticket means an empty `password` still succeeds without a prompt. Returns
 * stdout, stderr (prompt lines stripped), and exit code.
 */
export function runWithSudo(
	command: string,
	password: string,
	signal?: AbortSignal,
): Promise<SudoResult> {
	return spawnSudo(["-S", "--", "sh", "-c", command], password, signal);
}

function spawnSudo(
	args: string[],
	password: string,
	signal?: AbortSignal,
	extraEnv?: NodeJS.ProcessEnv,
): Promise<SudoResult> {
	return new Promise((resolve, reject) => {
		const proc = spawnTool("sudo", args, {
			stdio: ["pipe", "pipe", "pipe"],
			...(extraEnv ? { env: { ...process.env, ...extraEnv } } : {}),
		});

		let stdout = "";
		// Keep stderr raw until the process ends: the prompt filter is line-based,
		// and filtering per chunk can split a prompt across two chunks and leak it
		// (or glue it onto the following diagnostic).
		const stderrChunks: string[] = [];

		// `once` only fires the listener when the abort actually happens. On the
		// normal path the listener would otherwise stay attached to the caller's
		// signal holding this closure — and the child-process handle — for the
		// rest of the session. Detach it as soon as the promise settles.
		const onAbort = (): void => {
			proc.kill("SIGTERM");
			reject(new Error("Cancelled"));
		};
		if (signal?.aborted) {
			onAbort();
			return;
		}
		signal?.addEventListener("abort", onAbort, { once: true });
		const settle = <T>(fn: (value: T) => void) =>
			(value: T): void => {
				signal?.removeEventListener("abort", onAbort);
				fn(value);
			};

		proc.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});

		proc.stderr.on("data", (chunk: Buffer) => {
			stderrChunks.push(chunk.toString());
		});

		proc.on("error", settle(reject));
		proc.on("close", settle((code: number | null) =>
			resolve({ stdout, stderr: filterSudoPrompt(stderrChunks.join("")), code: code ?? 1 }),
		));

		proc.stdin.write(`${password}\n`);
		proc.stdin.end();
	});
}
