/**
 * fff-node.ts — structural stand-ins for the optional `@ff-labs/fff-node` peer.
 *
 * `@ff-labs/fff-node` is an optionalDependency of the upstream pix packages; the
 * plugin never imports it at runtime (fffState.module is assigned externally and
 * only in a full pix install), but the vendored fff.ts/types.ts still name its
 * types. omp installs don't ship the package, so we declare the minimal shapes
 * actually used by this repo instead of failing `tsc`.
 *
 * If fff support is ever wired up for real, replace these with the package's
 * real types (add it as an optional devDependency and let its own .d.ts win).
 */

/** One grep hit, in the fields `fffFormatGrepText` reads. */
export interface GrepMatch {
	relativePath: string;
	lineNumber: number;
	lineContent: string;
	contextBefore?: string[];
	contextAfter?: string[];
}

/**
 * Opaque pagination cursor. The plugin only stores and retrieves cursors
 * (CursorStore) — it never inspects fields, so `unknown` keeps the seam honest.
 */
export type GrepCursor = unknown;

/** Lifecycle surface the plugin reads on a created finder. */
export interface FffFinder {
	readonly isDestroyed: boolean;
	waitForScan(timeoutMs: number): Promise<{ ok: boolean; value: boolean }>;
	destroy(): void;
	/** pix-pretty/commands/fff.ts `/fff-health`. */
	healthCheck(): {
		ok: boolean;
		value?: {
			version: string;
			git: { repositoryFound: boolean; workdir?: string };
			filePicker: { initialized: boolean; indexedFiles?: number };
			frecency: { initialized: boolean };
			queryTracker: { initialized: boolean };
		};
		error?: string;
	};
	/** pix-pretty/commands/fff.ts `/fff-health` progress line. */
	getScanProgress(): {
		ok: boolean;
		value?: { isScanning: boolean; scannedFilesCount: number };
		error?: string;
	};
	/** pix-pretty/commands/fff.ts `/fff-rescan`. */
	scanFiles(): { ok: boolean; value?: unknown; error?: string };
}

/** The optional module shape (`fffState.module`), factory-only. */
export interface FffModule {
	FileFinder: {
		create(options: {
			basePath: string;
			frecencyDbPath: string;
			historyDbPath: string;
			aiMode: boolean;
		}): { ok: boolean; value: FffFinder; error?: string };
	};
}
