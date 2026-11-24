/**
 * stderr handling for sudo output.
 *
 * Regression cover for the localized-output bug: sudo and PAM translate their
 * messages, so anything that matched English words broke on a zh_CN host —
 * the prompt leaked into the error card and a wrong password was classified as
 * a fatal sudo error (one attempt, no retry). The filter now matches the
 * `[sudo] …:` prefix, and the validation probe runs under LC_ALL=C so the
 * remaining text is stable for the post-run checks.
 */

import { describe, expect, test } from "bun:test";

import { detectAuthFailure, filterSudoPrompt } from "../src/lib.ts";

// Real output, en_US and zh_CN, of `printf 'bad\n' | sudo -S -v`.
const EN =
	"[sudo] password for daiaji: Sorry, try again.\n[sudo] password for daiaji: \nsudo: no password was provided\nsudo: 1 incorrect password attempt\n";
const ZH =
	"[sudo] daiaji 的密码：对不起，请重试。\n[sudo] daiaji 的密码：\nsudo: 未提供密码\nsudo: 1 次错误密码尝试\n";

describe("filterSudoPrompt", () => {
	test("strips the prompt but keeps the diagnostic on the same line", () => {
		const out = filterSudoPrompt(EN);
		expect(out).toContain("Sorry, try again.");
		expect(out).not.toContain("[sudo]");
	});

	test("works for localized prompts (zh_CN)", () => {
		const out = filterSudoPrompt(ZH);
		expect(out).toContain("对不起，请重试。");
		expect(out).not.toContain("[sudo]");
	});

	test("drops prompt-only lines and blank lines", () => {
		const out = filterSudoPrompt("[sudo] password for u: \n\n[sudo] u 的密码：\n");
		expect(out).toBe("");
	});
});

describe("detectAuthFailure", () => {
	test("recognises the C-locale wrong-password diagnostics", () => {
		expect(detectAuthFailure(1, filterSudoPrompt(EN))).toBeTrue();
	});

	test("a successful run is never an auth failure", () => {
		expect(detectAuthFailure(0, filterSudoPrompt(EN))).toBeFalse();
	});

	test("unrelated failures are not auth failures", () => {
		expect(detectAuthFailure(1, "sudo: unknown user: nope")).toBeFalse();
	});
});
