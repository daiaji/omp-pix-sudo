/**
 * Stub `pi` host for importing `src/index.ts` outside an omp process.
 *
 * The extension entry point uses exactly one surface of the injected API:
 * `pi.zod` (schema builder) and `pi.registerTool` (definition capture). A stub
 * only has to provide those two — but it must NOT fake the rest of the
 * `ExtensionAPI`, because the point of the registration test is to assert what
 * the plugin actually passes to the real registration surface.
 *
 * `@oh-my-pi/omptype/zod` is the same module omp injects as `pi.zod`
 * (extensions/types.ts:1920 `zod: typeof zod` where zod is omptype's namespace),
 * so using it keeps the schema-builder behavior identical to the host's.
 */

import * as omptypeZod from "@oh-my-pi/omptype/zod";

import type { ToolDefinition } from "@oh-my-pi/pi-coding-agent";

export interface StubTool {
	definition: ToolDefinition<never, never> | null;
	zod: typeof omptypeZod.z;
	registerTool(tool: unknown): void;
}

/** A minimal `pi` recording every registerTool call. */
export function createStubPi(): StubTool {
	const stub: StubTool = {
		definition: null,
		zod: omptypeZod.z,
		registerTool(tool: unknown) {
			stub.definition = tool as ToolDefinition<never, never>;
		},
	};
	return stub;
}
