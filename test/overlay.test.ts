/**
 * Gate-overlay interaction tests.
 *
 * The wrong-password path is pure UI state, so it is driven here exactly as the
 * host drives it: build the component through `ui.custom`, feed keystrokes
 * through `handleInput`, and assert on the rendered lines. Pins the behaviors a
 * user depends on:
 *
 *   1. a rejected password keeps the modal open and shows the attempt counter;
 *   2. submitting an empty field says so instead of doing nothing (a silent
 *      no-op reads as "the overlay is stuck");
 *   3. the attempts cap ends the modal with `passwordAttemptsExhausted`.
 *
 * Async validation is gated by test-owned deferreds and woken with microtask
 * flushes — no wall-clock sleeps, so the suite cannot flake under load.
 */

import { describe, expect, test } from "bun:test";

import { showOverlay } from "../src/pix-pretty/gate-overlay.ts";

const theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

const timers = {
	setInterval: () => 1,
	clearTimer: () => {},
};

type Component = { render(w: number): string[]; handleInput(d: string): void };

interface Harness {
	text(width?: number): string;
	done: Promise<unknown>;
	type(text: string): void;
	enter(): void;
}

function mount(config: Parameters<typeof showOverlay>[1]): Harness {
	const completion = Promise.withResolvers<unknown>();
	let component: Component | undefined;

	const ui = {
		custom(cb: (...args: never[]) => never): Promise<unknown> {
			const tui = { requestRender: () => {}, terminal: { rows: 40 } };
			component = cb(tui as never, theme as never, {} as never, completion.resolve as never) as never;
			return completion.promise;
		},
	};

	void showOverlay(ui as never, config as never, timers as never);
	if (!component) throw new Error("ui.custom was not called");
	const comp = component;

	return {
		text: (width = 80) => comp.render(width).join("\n"),
		done: completion.promise,
		type(text: string) {
			for (const ch of text) comp.handleInput(ch);
		},
		enter() {
			comp.handleInput("\r");
		},
	};
}

const sudoConfig = (validate: (pw: string) => Promise<boolean>, maxPasswordAttempts = 3) =>
	({
		mode: "sudo" as const,
		title: "Root Command Request",
		body: ["Command: id"],
		validatePassword: validate,
		maxPasswordAttempts,
	});

/** Let the async submit continuation run: it was queued before this flush. */
const flush = async (): Promise<void> => {
	await Promise.resolve();
	await Promise.resolve();
};

describe("password stage", () => {
	test("a rejected password keeps the modal open with an attempt counter", async () => {
		const gate = Promise.withResolvers<boolean>();
		const h = mount(sudoConfig(() => gate.promise));

		h.enter(); // select stage → password stage
		h.type("wrong");
		h.enter();
		expect(h.text()).toContain("Checking password…");

		gate.resolve(false);
		await flush();
		expect(h.text()).toContain("Incorrect password — attempt 1 of 3");
		// Still interactive: the field cleared and accepts a retry, masked.
		h.type("again");
		expect(h.text()).toContain("Sudo password:");
		expect(h.text()).toContain("●●●●●");
	});

	test("empty submit gives feedback instead of doing nothing", () => {
		const h = mount(sudoConfig(async () => false));
		h.enter(); // password stage
		h.enter(); // submit with an empty field
		const frame = h.text();
		expect(frame).toContain("Password required");
		// Stays on the password stage: the modal did not close or advance.
		expect(frame).toContain("Sudo password:");
	});

	test("the attempts cap closes with passwordAttemptsExhausted", async () => {
		const gates = [Promise.withResolvers<boolean>(), Promise.withResolvers<boolean>()];
		let call = 0;
		const h = mount(sudoConfig(() => gates[call++]!.promise, 2));

		h.enter();
		h.type("bad1");
		h.enter();
		gates[0]!.resolve(false);
		await flush();

		h.type("bad2");
		h.enter();
		gates[1]!.resolve(false);

		const result = (await h.done) as { action: string; passwordAttemptsExhausted?: boolean };
		expect(result.action).toBe("approved");
		expect(result.passwordAttemptsExhausted).toBeTrue();
	});

	test("a correct password approves once with the typed value", async () => {
		const h = mount(sudoConfig(async () => true));
		h.enter();
		h.type("good");
		h.enter();

		const result = (await h.done) as { action: string; password?: string };
		expect(result.action).toBe("approved");
		expect(result.password).toBe("good");
	});
});
