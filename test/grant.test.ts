/**
 * Session-grant unit tests.
 *
 * The grant is the one knob that widens the per-command approval, so its
 * boundary gets pinned by tests rather than trusted to reading:
 *   - a fresh process has no grant (the plugin must not start out permissive);
 *   - the window is exactly SESSION_GRANT_MS and expires at the boundary;
 *   - rolling use extends it;
 *   - revoke (session shutdown) closes it immediately.
 */

import { beforeEach, describe, expect, test } from "bun:test";

import {
	grantActive,
	grantRemainingMs,
	extendGrant,
	revokeGrant,
	syncGrantToTicket,
	SESSION_GRANT_MS,
} from "../src/grant.ts";

const T0 = 1_700_000_000_000;

describe("session grant", () => {
	beforeEach(() => {
		revokeGrant();
	});

	test("starts closed", () => {
		expect(grantActive(T0)).toBeFalse();
		expect(grantRemainingMs(T0)).toBe(0);
	});

	test("window is SESSION_GRANT_MS and expires at the boundary", () => {
		extendGrant(T0);
		expect(grantActive(T0)).toBeTrue();
		expect(grantActive(T0 + SESSION_GRANT_MS - 1)).toBeTrue();
		// Exactly at the deadline the grant is over: `now < until` is strict.
		expect(grantActive(T0 + SESSION_GRANT_MS)).toBeFalse();
		expect(grantRemainingMs(T0 + SESSION_GRANT_MS)).toBe(0);
	});

	test("rolling use extends the window from the latest use", () => {
		extendGrant(T0);
		const later = T0 + SESSION_GRANT_MS - 1_000;
		extendGrant(later);
		// Would have expired on the original deadline; the roll moved it.
		expect(grantActive(T0 + SESSION_GRANT_MS + 1)).toBeTrue();
		expect(grantActive(later + SESSION_GRANT_MS - 1)).toBeTrue();
		expect(grantActive(later + SESSION_GRANT_MS)).toBeFalse();
	});

	test("a lost sudo ticket revokes the grant (sudo -K = full revoke)", () => {
		extendGrant(T0);
		// Ticket probe failed: the grant must not survive authentication.
		expect(syncGrantToTicket(false, T0 + 1_000)).toBeFalse();
		expect(grantActive(T0 + 1_000)).toBeFalse();
	});

	test("a valid ticket keeps the grant live", () => {
		extendGrant(T0);
		expect(syncGrantToTicket(true, T0 + 1_000)).toBeTrue();
		expect(grantRemainingMs(T0 + 1_000)).toBe(SESSION_GRANT_MS - 1_000);
	});

	test("ticket loss on a fresh process stays closed", () => {
		expect(syncGrantToTicket(false, T0)).toBeFalse();
		expect(syncGrantToTicket(true, T0)).toBeFalse();
	});

	test("revoke closes an active window", () => {
		extendGrant(T0);
		revokeGrant();
		expect(grantActive(T0)).toBeFalse();
		expect(grantRemainingMs(T0)).toBe(0);
	});
});
