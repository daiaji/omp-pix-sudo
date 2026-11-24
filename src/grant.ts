/**
 * Session-scoped root approval grant.
 *
 * The per-command Allow overlay is the security boundary, but operating a
 * machine means dozens of `sudo_run` calls in a row. The grant lets the human
 * widen that boundary *at the moment they click*: picking "Allow for 15 min"
 * in the overlay approves root commands for a rolling 15-minute window, so the
 * agent can keep working without a click per command.
 *
 * Scope, deliberately narrow:
 *   - in-memory only, one omp process; nothing on disk, nothing inheritable;
 *   - gone on `session_shutdown` (see index.ts) and on process exit;
 *   - **never** bypasses authentication: the sudo ticket is still checked on
 *     every call, so `sudo -K` (or the 15-minute sudo ticket timeout) puts the
 *     password prompt back even while the grant is live;
 *   - rolling: each use extends the window by {@link SESSION_GRANT_MS}.
 *
 * The clock is injectable so the expiry boundary is testable without sleeping.
 */

/** Grant window; matches sudo's default `timestamp_timeout`. */
export const SESSION_GRANT_MS = 15 * 60_000;

/** Choice value the overlay uses for "allow and grant the window". */
export const SESSION_GRANT_CHOICE = "session";

let grantedUntil = 0;

/** Milliseconds left in the current grant, 0 when none is active. */
export function grantRemainingMs(now: number = Date.now()): number {
	return Math.max(0, grantedUntil - now);
}

/** True while a grant is live. */
export function grantActive(now: number = Date.now()): boolean {
	return now < grantedUntil;
}

/** Start or roll the window: `now + SESSION_GRANT_MS`. */
export function extendGrant(now: number = Date.now()): void {
	grantedUntil = now + SESSION_GRANT_MS;
}

/** Drop the grant immediately (session shutdown, or explicit revoke). */
export function revokeGrant(): void {
	grantedUntil = 0;
}
