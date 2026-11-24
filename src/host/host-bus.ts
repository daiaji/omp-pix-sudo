/**
 * host-bus.ts — the shape of the host's shared event bus (`pi.events`).
 *
 * omp 19.1.1 does NOT re-export the `EventBus` class from the package root
 * (`src/index.ts` barrel has no `utils/event-bus` re-export), so an extension
 * that wants to type `pi.events` must declare its structural type. These are
 * the bound-arrow methods omp's EventBus exposes; anything we don't call is
 * omitted on purpose — narrower types keep the stub in tests honest.
 */

export interface HostEventBus {
	/** Subscribe; returns an unsubscribe function. */
	on(channel: string, handler: (data: unknown) => void): () => unknown;
	/** Dispatch to all handlers registered for the channel, in registration order. */
	emit(channel: string, data: unknown): void;
	/** Whether the channel has at least one listener. */
	hasListeners(channel: string): boolean;
}
