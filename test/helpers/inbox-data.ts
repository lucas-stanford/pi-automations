// The shared mockup data for the `/automations` page (the B design), as real statuses,
// records and a run: six automations, one failed, one running, one off, at Thu Oct 22 13:50 local.

import { listingModel } from "../../src/listing.js";
import type { RunRecord, Status } from "../../src/types.js";
import type { ListData } from "../../src/ui/list.js";
import type { RunView } from "../../src/ui/run-view.js";

export const NOW = new Date(2026, 9, 22, 13, 50, 0);
export const HOME = "/home/me";
const ROOT = `${HOME}/.agents/automations`;

/** Local time on a day in October 2026. */
export const at = (day: number, h: number, m: number, s = 0): Date => new Date(2026, 9, day, h, m, s);
const iso = (d: Date): string => d.toISOString();
const plus = (d: Date, ms: number): Date => new Date(d.getTime() + ms);
const MIN = 60_000;

type On = NonNullable<Status["automation"]>["on"];

export const DESCRIPTIONS: Record<string, string> = {
  "my-pr-review":
    "Works through review comments on my PRs, fixes real defects with right-sized agents, declines cosmetic nits, replies with receipts, and notifies my group chat when a run fails, is blocked or needs my judgment.",
  "my-team-review":
    "Reviews one teammate's pull request per run. It maps the change, has three reviewers read it, and posts one review with an overview that links every comment.",
  "my-pr-digest":
    "Every morning, publishes a digest of our PR work to HTML Canvas and records every run, so the team starts the day knowing what moved and what is waiting.",
  "my-issue-verify": "Verifies the next in-scope GitHub issue, builds a dossier, tries a safe repro and drafts a verdict.",
  "nightly-report": "Posts last night's build health to #builds.",
  "old-cleanup": "Deletes stale branches older than 90 days.",
};

export function keyOf(name: string): string {
  return `user:${ROOT}:${name}`;
}

export function status(name: string, on: On, over: Partial<Status> = {}): Status {
  return {
    key: keyOf(name),
    name,
    scope: "user",
    root: { path: ROOT, scope: "user", kind: "agents" },
    dir: `${ROOT}/${name}`,
    state: "armed",
    effectiveTimeoutMs: 3_600_000,
    staggerSec: 0,
    automation: { name, description: DESCRIPTIONS[name] ?? `${name} does one thing.`, enabled: true, on, hooks: { pre: [], post: [] }, body: "b" },
    ...over,
  } as Status;
}

export function record(name: string, id: string, start: Date, tookMs: number, outcome: RunRecord["outcome"], over: Partial<RunRecord> = {}): RunRecord {
  const end = plus(start, tookMs);
  return {
    id,
    key: keyOf(name),
    name,
    scope: "user",
    root: ROOT,
    trigger: "schedule",
    late: false,
    recordedAt: iso(end),
    startedAt: iso(start),
    endedAt: iso(end),
    outcome,
    ...over,
  };
}

const DIGEST_NOTES = [
  { ts: iso(at(22, 8, 0, 50)), text: "Digest published", links: [{ label: "Canvas digest", url: "https://canvas.example/d/2026-10-22" }] },
  { ts: iso(at(22, 8, 0, 55)), text: "Posted to the team chat", links: [{ label: "Group message", url: "https://group.example/m/123" }] },
];

/** my-pr-digest's runs, oldest first. */
export const DIGEST_RUNS: RunRecord[] = [
  record("my-pr-digest", "d16", at(16, 8, 0), MIN, "ok"),
  record("my-pr-digest", "d17", at(17, 8, 0), 0, "skipped", { reason: "weekend" }),
  record("my-pr-digest", "d18", at(18, 8, 0), MIN, "ok"),
  record("my-pr-digest", "d19", at(19, 8, 0), 2 * MIN, "ok"),
  record("my-pr-digest", "d20", at(20, 8, 0), 22_000, "failed", { error: { kind: "hook", message: "gather.js exited 1: Search fetch timed out" } }),
  record("my-pr-digest", "d21", at(21, 8, 0), MIN, "ok", { output: { text: "PR digest 2026-10-21: 2 reviews waiting on you" } }),
  record("my-pr-digest", "d22", at(22, 8, 0), MIN, "ok", {
    output: { text: "PR digest 2026-10-22: nothing needs you this morning; two renderer changes merged." },
    notes: DIGEST_NOTES,
  }),
];

const NIGHTLY_ERROR = "gh: HTTP 502 while posting the report to #builds";
export const NIGHTLY_RUNS: RunRecord[] = [
  ...[16, 17, 18, 19, 20, 21].map((day) =>
    record("nightly-report", `n${day}`, at(day, 22, 0), 45_000, day === 18 ? "failed" : "ok", day === 18 ? { error: { kind: "body", message: "gh: HTTP 401" } } : { output: { text: "Build health posted." } }),
  ),
  record("nightly-report", "n22", at(22, 10, 51, 20), 40_000, "failed", { trigger: "manual", error: { kind: "body", message: NIGHTLY_ERROR } }),
];

export const TEAM_RUNS: RunRecord[] = [
  record("my-team-review", "t1", at(22, 11, 0), 9 * MIN, "ok", { trigger: "watch" }),
  record("my-team-review", "t2", at(22, 12, 0), 7 * MIN, "ok", { trigger: "watch" }),
  record("my-team-review", "t3", at(22, 12, 30), 7 * MIN, "ok", { trigger: "watch" }),
  record("my-team-review", "t4", at(22, 13, 32), 5 * MIN, "ok", {
    trigger: "watch",
    output: { text: "acme/webapp#11479 feat(plugins): publish shared skills as Agent Plugins: COMMENT" },
  }),
];

const REVIEW_RUNS: RunRecord[] = [
  record("my-pr-review", "r1", at(10, 21, 9), 10 * MIN, "ok", {
    trigger: "watch",
    output: { text: "acme/tools#9850 fix: restore plugin detail focus: 1 fixed, 0 nits declined" },
  }),
];
const VERIFY_RUNS: RunRecord[] = [record("my-issue-verify", "v1", at(19, 7, 0), 0, "skipped", { reason: "no issue in scope" })];

const watch = (every: string): On => ({ manual: true, watch: { script: "scripts/watch.js", every } });
const daily = (cron: string): On => ({ manual: true, schedule: { cron, catchUp: "skip" } });

export const PR_REVIEW = status("my-pr-review", watch("5m"), {
  nextCheck: iso(plus(NOW, MIN)),
  last: { outcome: "ok", at: REVIEW_RUNS[0]?.endedAt as string },
});
export const TEAM_REVIEW = status("my-team-review", watch("15m"), {
  nextCheck: iso(plus(NOW, 12 * MIN)),
  last: { outcome: "ok", at: TEAM_RUNS[3]?.endedAt as string },
  running: { pid: 4242, runId: "run-team", key: keyOf("my-team-review"), startedAt: iso(at(22, 13, 47)), timeoutMs: 3_600_000, postHooks: 0, trigger: "watch" },
});
export const PR_DIGEST = status("my-pr-digest", daily("0 8 * * *"), {
  nextFire: iso(at(23, 8, 0)),
  last: { outcome: "ok", at: DIGEST_RUNS[6]?.endedAt as string },
});
export const ISSUE_VERIFY = status("my-issue-verify", daily("0 7 * * 1"), {
  nextFire: iso(at(26, 7, 0)),
  last: { outcome: "skipped", at: VERIFY_RUNS[0]?.endedAt as string, reason: "no issue in scope" },
});
export const NIGHTLY = status("nightly-report", daily("0 22 * * *"), {
  nextFire: iso(at(22, 22, 0)),
  last: { outcome: "failed", at: NIGHTLY_RUNS[6]?.endedAt as string, reason: NIGHTLY_ERROR },
});
export const OLD_CLEANUP = status("old-cleanup", { manual: true }, { state: "disabled" });

export const ALL = [PR_REVIEW, TEAM_REVIEW, PR_DIGEST, ISSUE_VERIFY, NIGHTLY, OLD_CLEANUP];
export const ALL_GOOD = [PR_REVIEW, PR_DIGEST, ISSUE_VERIFY, OLD_CLEANUP];

const RECORDS: Record<string, RunRecord[]> = {
  "my-pr-review": REVIEW_RUNS,
  "my-team-review": TEAM_RUNS,
  "my-pr-digest": DIGEST_RUNS,
  "my-issue-verify": VERIFY_RUNS,
  "nightly-report": NIGHTLY_RUNS,
  "old-cleanup": [],
};

export function recordsFor(name: string): RunRecord[] {
  return RECORDS[name] ?? [];
}

export function inboxData(statuses: Status[] = ALL, over: Partial<ListData> = {}): ListData {
  const counts = { armed: 0, off: 0, disabled: 0, invalid: 0 };
  for (const s of statuses) counts[s.state]++;
  const details: NonNullable<ListData["details"]> = {};
  for (const s of statuses) {
    const records = recordsFor(s.name);
    details[s.key] = { records, ...(records.at(-1) ? { lastRecord: records.at(-1) as RunRecord } : {}) };
  }
  return {
    model: listingModel(statuses, {
      home: HOME,
      projectRoots: [...new Set(statuses.filter((s) => s.scope === "repository").map((s) => s.root.path.replace(/\/\.agents\/automations$/, "")))],
      now: NOW,
    }),
    facts: { counts, running: statuses.filter((s) => s.running).length, watcher: { state: "on", lastTickAt: iso(plus(NOW, -20_000)) } },
    details,
    now: NOW,
    ...over,
  };
}

/** my-team-review's run, three minutes in, on its chart. */
export function teamRunView(): RunView {
  return {
    key: keyOf("my-team-review"),
    name: "my-team-review",
    trigger: "watch",
    source: "observed",
    pid: 4242,
    runId: "run-team",
    startedAt: iso(at(22, 13, 47)),
    timeoutMs: 3_600_000,
    phase: "running",
    flow: { run: "run-team" },
    steps: [
      { id: "pre0", label: "Pick a PR", state: "done" },
      { id: "body", label: "Review it", state: "active" },
      { id: "map", label: "Map the change", state: "done", extra: true },
      { id: "read", label: "Three reviewers read", state: "active", note: "2 of 3 reviewers done", extra: true },
      { id: "post", label: "Post the review", state: "pending", extra: true },
    ],
    notes: [{ ts: iso(at(22, 13, 48)), text: "Picked acme/webapp#11911", links: [{ label: "PR", url: "https://github.com/example/repo/pull/11911" }] }],
    stderrTail: [],
  };
}
