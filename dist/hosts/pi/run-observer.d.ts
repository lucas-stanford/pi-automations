import type { RunRegistry } from "../../ui/registry.js";
export interface RunObserverOptions {
    readonly registry: RunRegistry;
    /** Repaint the footer. Called on every change and on the footer's own tick. */
    paintFooter(): void;
    /** Repaint the strip above the editor; `tick` advances its animation. */
    paintWidget(tick: number): void;
    /** Re-read what the observed runs are doing. Failures here are never fatal. */
    poll(): void;
    /** Injected only so a test can drive time without waiting for it. */
    readonly clock?: {
        setInterval: (fn: () => void, ms: number) => {
            unref?: () => void;
        };
        clearInterval: (handle: unknown) => void;
    };
}
export interface RunObserver {
    /** Subscribe and bring the timers into line with what is running. */
    start(): void;
    /** Bring the timers into line after something changed outside the subscription. */
    sync(): void;
    /** Which timers are armed. For tests, and for asserting that disposal left none. */
    readonly armed: {
        footer: boolean;
        widget: boolean;
        poll: boolean;
    };
    readonly subscribed: boolean;
    /** Stop observing. Idempotent, and it touches no run. */
    dispose(): void;
}
export declare function createRunObserver(options: RunObserverOptions): RunObserver;
