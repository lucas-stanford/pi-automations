/** Observation ownership. */

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { createRunObserver } from "../src/hosts/pi/run-observer.js";
import { RunRegistry } from "../src/ui/registry.js";

/** A clock that records, so a test never waits and a leaked timer is visible. */
function fakeClock() {
  const armed = new Map<number, { fn: () => void; ms: number; unrefs: number }>();
  let next = 1;
  return {
    armed,
    cleared: [] as number[],
    clock: {
      setInterval: (fn: () => void, ms: number) => {
        const id = next++;
        const entry = { fn, ms, unrefs: 0 };
        armed.set(id, entry);
        return {
          id,
          unref: () => {
            entry.unrefs++;
          },
        } as { unref?: () => void };
      },
      clearInterval: function (h: unknown) {
        const id = (h as { id: number }).id;
        armed.delete(id);
        (this as unknown as { cleared: number[] }).cleared?.push(id);
      },
    },
  };
}

/** A registry with nothing real behind it: no locks, no flows, no discovery. */
function registryWith(running: number): RunRegistry {
  const r = new RunRegistry({
    readRunLock: () => undefined,
    statePaths: () => ({ locks: "" }) as never,
    now: () => new Date("2026-09-17T14:00:00.000Z"),
  } as never);

  for (let i = 0; i < running; i++) {
    r.addAttached({
      located: {
        automation: {
          name: `a${i}`,
          description: "d",
          enabled: true,
          on: { manual: true },
          hooks: { pre: [], post: [] },
          body: "b",
        },
        dir: "/a",
        file: "/a/AUTOMATION.md",
        root: { path: "/a", scope: "user", kind: "agents" },
        key: `user:/a:a${i}`,
      } as never,
      trigger: "manual",
      timeoutMs: 60_000,
    });
  }
  return r;
}

function observerOn(registry: RunRegistry) {
  const c = fakeClock();
  const painted = { footer: 0, widget: 0, polls: 0, ticks: [] as number[] };
  const observer = createRunObserver({
    registry,
    paintFooter: () => painted.footer++,
    paintWidget: (tick) => {
      painted.widget++;
      painted.ticks.push(tick);
    },
    poll: () => painted.polls++,
    clock: c.clock,
  });
  return { observer, painted, clock: c };
}

describe("an observer owns its timers", () => {
  it("arms nothing while nothing is running", () => {
    const { observer } = observerOn(registryWith(0));
    observer.start();
    expect(observer.armed).toEqual({ footer: false, widget: false, poll: false });
  });

  it("arms all three once something is", () => {
    const { observer } = observerOn(registryWith(1));
    observer.start();
    expect(observer.armed).toEqual({ footer: true, widget: true, poll: true });
  });

  it("unrefs every timer, so a pending repaint cannot hold the process open", () => {
    const { observer, clock } = observerOn(registryWith(1));
    observer.start();
    for (const entry of clock.armed.values()) expect(entry.unrefs).toBe(1);
  });

  it("gives the widget its own faster cadence", () => {
    const { observer, clock } = observerOn(registryWith(1));
    observer.start();
    const periods = [...clock.armed.values()].map((e) => e.ms).sort((a, b) => a - b);
    // The widget animates, so it ticks faster than the things that only change.
    expect(periods[0]).toBeLessThan(periods[1] as number);
    expect(new Set(periods).size).toBeGreaterThan(1);
  });

  it("advances the widget's tick, so the animation moves", () => {
    const { observer, painted, clock } = observerOn(registryWith(1));
    observer.start();
    const widget = [...clock.armed.values()].find((e) => e.ms < 500);
    widget?.fn();
    widget?.fn();
    expect(painted.ticks.slice(-2)).toEqual([1, 2]);
  });

  it("never lets a failing poll escape", () => {
    const registry = registryWith(1);
    const c = fakeClock();
    const observer = createRunObserver({
      registry,
      paintFooter: () => {},
      paintWidget: () => {},
      poll: () => {
        throw new Error("the lock vanished");
      },
      clock: c.clock,
    });
    observer.start();
    const poll = [...c.armed.values()].find((e) => e.ms >= 500 && e.fn.length === 0);
    // A poll that throws would otherwise reach an interval callback, where there is nobody to catch
    // it and the session goes down with it.
    expect(() => {
      for (const e of c.armed.values()) e.fn();
    }).not.toThrow();
    expect(poll).toBeTruthy();
  });
});

describe("disposal stops observing, and only that", () => {
  it("leaves no timer armed", () => {
    const { observer } = observerOn(registryWith(2));
    observer.start();
    expect(observer.armed.footer).toBe(true);

    observer.dispose();
    expect(observer.armed).toEqual({ footer: false, widget: false, poll: false });
  });

  it("releases the subscription, so a reloaded session is not shadowed by the old one", () => {
    const registry = registryWith(1);
    const { observer, painted } = observerOn(registry);
    observer.start();
    expect(observer.subscribed).toBe(true);

    observer.dispose();
    expect(observer.subscribed).toBe(false);

    const before = painted.footer;
    registry.dismissFinished();
    registry.clear();
    expect(painted.footer).toBe(before);
  });

  it("is harmless twice", () => {
    const { observer } = observerOn(registryWith(1));
    observer.start();
    observer.dispose();
    expect(() => observer.dispose()).not.toThrow();
    expect(observer.armed).toEqual({ footer: false, widget: false, poll: false });
  });

  it("refuses to re-arm after disposal", () => {
    const registry = registryWith(1);
    const { observer } = observerOn(registry);
    observer.start();
    observer.dispose();

    observer.sync();
    observer.start();
    // A late `sync` from a queued callback must not bring a disposed observer back to life.
    expect(observer.armed).toEqual({ footer: false, widget: false, poll: false });
  });

  it("leaves every run in the registry exactly where it was", () => {
    const registry = registryWith(2);
    const { observer } = observerOn(registry);
    observer.start();

    const before = registry.all().map((e) => ({ id: e.id, outcome: e.view.outcome }));
    observer.dispose();
    const after = registry.all().map((e) => ({ id: e.id, outcome: e.view.outcome }));

    // Not cancelled, not marked, not dismissed. Disposal is about the watcher, not the watched.
    expect(after).toEqual(before);
    expect(registry.running()).toHaveLength(2);
  });

  it("asks for nothing while disposing", () => {
    const registry = registryWith(1);
    let polled = 0;
    const c = fakeClock();
    const observer = createRunObserver({
      registry,
      paintFooter: () => {},
      paintWidget: () => {},
      poll: () => polled++,
      clock: c.clock,
    });
    observer.start();
    const atStart = polled;

    observer.dispose();
    // No final sweep, no last poll, no "one more refresh before we go" — each of which would be a
    // read against a run that may be mid-write.
    expect(polled).toBe(atStart);
  });
});

describe("the observer contains no way to stop a run", () => {
  it("exposes only start, sync, dispose and its two readables", () => {
    const { observer } = observerOn(registryWith(1));
    const keys = Object.keys(observer).sort();
    expect(keys).toEqual(["armed", "dispose", "start", "subscribed", "sync"]);
  });

  it("names nothing that could signal, cancel or relaunch a worker", () => {
    const src = readFileSync(
      path.join(import.meta.dirname, "..", "src", "hosts", "pi", "run-observer.ts"),
      "utf8",
    );
    // Cancellation is the cooperative run-ID file the run itself checks; relaunching is the
    // transport's business and it has no such method either. Neither belongs to a watcher.
    for (const forbidden of ["kill(", "requestCancel", "spawn(", "launchWorker", "process.kill"]) {
      expect(src).not.toContain(forbidden);
    }
  });
});
