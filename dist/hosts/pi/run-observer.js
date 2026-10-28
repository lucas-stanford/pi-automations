// Watching runs: the registry subscription and repaint timers, behind one dispose.
const DEFAULTS = { footerMs: 1000, widgetMs: 80, pollMs: 1000 };
export function createRunObserver(options) {
    const timings = DEFAULTS;
    const clock = options.clock ?? {
        setInterval: (fn, ms) => setInterval(fn, ms),
        clearInterval: (h) => clearInterval(h),
    };
    let footer;
    let widget;
    let poll;
    let unsubscribe;
    let widgetTick = 0;
    let disposed = false;
    const arm = (current, wanted, fn, ms) => {
        if (wanted && !current) {
            const handle = clock.setInterval(fn, ms);
            handle.unref?.();
            return handle;
        }
        if (!wanted && current) {
            clock.clearInterval(current);
            return undefined;
        }
        return current;
    };
    function sync() {
        if (disposed)
            return;
        const running = options.registry.running().length > 0;
        footer = arm(footer, running, () => options.paintFooter(), timings.footerMs);
        widget = arm(widget, running, () => {
            widgetTick++;
            options.paintWidget(widgetTick);
        }, timings.widgetMs);
        poll = arm(poll, running, () => {
            try {
                options.poll();
            }
            catch {
                // A poll that fails must never take the session down.
            }
        }, timings.pollMs);
    }
    return {
        start() {
            if (disposed || unsubscribe)
                return;
            unsubscribe = options.registry.subscribe(() => {
                sync();
                options.paintFooter();
                options.paintWidget(widgetTick);
            });
            sync();
        },
        sync,
        get armed() {
            return { footer: footer !== undefined, widget: widget !== undefined, poll: poll !== undefined };
        },
        get subscribed() {
            return unsubscribe !== undefined;
        },
        dispose() {
            disposed = true;
            for (const handle of [footer, widget, poll]) {
                if (handle !== undefined)
                    clock.clearInterval(handle);
            }
            footer = undefined;
            widget = undefined;
            poll = undefined;
            unsubscribe?.();
            unsubscribe = undefined;
        },
    };
}
//# sourceMappingURL=run-observer.js.map