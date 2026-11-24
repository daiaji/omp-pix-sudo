/**
 * Registration test — the model-independent check that the plugin registers
 * `sudo_run` with a parseable parameter schema.
 *
 * This loads `src/index.ts` through a stub `pi` (no omp binary, no terminal),
 * so it runs under `bun test` deterministically and pins the actual contract:
 * name, the { command, reason? } parameter schema, and the renderer hooks the
 * host needs. Print-mode load checks (N2) are flaky under sandboxed HOMEs —
 * this test is the stable one.
 */

import { describe, expect, test } from "bun:test";

import registerSudoTool from "../src/index.ts";
import { createStubPi } from "./stubs/pi-coding-agent.ts";

describe("sudo_run registration", () => {
	test("registers a tool named sudo_run", () => {
		const pi = createStubPi();
		registerSudoTool(pi as never);
		expect(pi.definition).not.toBeNull();
		expect(pi.definition?.name).toBe("sudo_run");
	});

	test("parameter schema parses { command } and makes reason optional", () => {
		const pi = createStubPi();
		registerSudoTool(pi as never);
		const params = pi.definition?.parameters as unknown as { parse(input: unknown): unknown };

		const ok = params.parse({ command: "id" }) as Record<string, unknown>;
		expect(ok.command).toBe("id");

		const withReason = params.parse({ command: "id", reason: "why" }) as Record<string, unknown>;
		expect(withReason.reason).toBe("why");

		// schema must reject a call without the required field
		let threw = false;
		try {
			params.parse({ reason: "no command" });
		} catch {
			threw = true;
		}
		expect(threw).toBeTrue();
	});

	test("keeps the renderer hooks and execute the host needs", () => {
		const pi = createStubPi();
		registerSudoTool(pi as never);
		const def = pi.definition as Record<string, unknown> | null;
		expect(typeof def?.execute).toBe("function");
		expect(typeof def?.renderCall).toBe("function");
		expect(typeof def?.renderResult).toBe("function");
		expect(def?.label).toBe("Run as root");
	});
});
