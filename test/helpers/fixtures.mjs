// Builds test/fixtures/: a user root, a project root (with a .git marker) and one invalid
// automation per error line in the Draft 0.2 error table.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/** name -> { file contents, hook scripts } */
const USER = {
  "daily-briefing": {
    file: `---
name: daily-briefing
description: Summarise what happened overnight and what needs attention today.
model: anthropic/claude-sonnet-4-5:low
timeout: 10m
on:
  schedule:
    cron: "0 7 * * MON-FRI"
    timezone: America/Los_Angeles
    catch-up: once
  manual: true
hooks:
  pre:
    - script: scripts/overnight_counts.js
  post:
    - script: scripts/mark_run.js
---

# Daily briefing

Read the counts above and write a short briefing.
`,
    scripts: {
      "scripts/overnight_counts.js": "console.log('12 new, 3 urgent');\n",
      "scripts/mark_run.js": "process.stdin.resume();\n",
    },
  },

  "weekly-report": {
    file: `---
name: weekly-report
description: Assemble the weekly report from this week's activity.
on:
  schedule: "0 9 * * MON"
---

Write the weekly report.
`,
    scripts: {},
  },

  "manual-only": {
    file: `---
name: manual-only
description: Runs only when asked.
on:
  manual: true
---

Do the thing.
`,
    scripts: {},
  },

  "standup-notes": {
    file: `---
name: standup-notes
description: Turn yesterday's commits into standup notes.
enabled: false
on:
  schedule: "0 8 * * MON-FRI"
hooks:
  pre:
    - prompt: Only continue if there were commits yesterday, otherwise answer skip.
---

Draft the standup notes.
`,
    scripts: {},
  },
};

const PROJECT = {
  "stale-pr-nudge": {
    file: `---
name: stale-pr-nudge
description: Nudge authors of pull requests idle for three days or more.
model: anthropic/claude-sonnet-4-5:low
on:
  schedule:
    cron: "0 */4 * * MON-FRI"
    timezone: America/Los_Angeles
  manual: true
hooks:
  pre:
    - script: scripts/list_stale.js
    - prompt: If the list is empty answer skip, otherwise continue.
  post:
    - script: scripts/post_summary.js
    - prompt: Summarise what was posted in one line.
---

Nudge the authors listed above.
`,
    scripts: {
      "scripts/list_stale.js": "console.log('#1 idle 4 days');\n",
      "scripts/post_summary.js": "process.stdin.resume();\n",
    },
  },

  "docs-drift": {
    file: `---
name: docs-drift
description: Find documentation that no longer matches the code.
on:
  schedule: "0 9 * * MON"
hooks:
  pre:
    - script: scripts/changed_files.js
---

Report documentation drift.
`,
    scripts: { "scripts/changed_files.js": "console.log('README.md');\n" },
  },

  "release-notes": {
    file: `---
name: release-notes
description: Draft release notes for the current milestone.
on:
  manual: true
---

Draft the release notes.
`,
    scripts: {},
  },
};

/**
 * One directory per error line. `dir` is the directory name, which matters because the name check
 * compares against it. `expect` is the EXACT one-line error the parser must produce.
 */
export const INVALID = [
  {
    dir: "unknown-field",
    expect:
      "budget: unknown field — Draft 0.2 has name, description, enabled, model, timeout, on, hooks, flow",
    file: `---
name: unknown-field
description: Uses a field Draft 0.2 does not define.
budget: 10
on:
  manual: true
---

Body.
`,
  },
  {
    dir: "unknown-fields",
    expect:
      "budget, retries: unknown fields — Draft 0.2 has name, description, enabled, model, timeout, on, hooks, flow",
    file: `---
name: unknown-fields
description: Uses two fields Draft 0.2 does not define.
retries: 3
budget: 10
on:
  manual: true
---

Body.
`,
  },
  {
    dir: "unknown-trigger",
    expect: "on.webhook: this host implements schedule, manual, watch",
    file: `---
name: unknown-trigger
description: Uses a trigger type this host does not implement.
on:
  webhook: true
---

Body.
`,
  },
  {
    dir: "bad-cron",
    expect: 'on.schedule.cron: "0 7 * * MON-FRI *" is not a 5-field cron expression',
    file: `---
name: bad-cron
description: Has a six-field cron expression.
on:
  schedule:
    cron: "0 7 * * MON-FRI *"
---

Body.
`,
  },
  {
    dir: "bad-tz",
    expect: 'on.schedule.timezone: "PST" is not an IANA zone — try America/Los_Angeles',
    file: `---
name: bad-tz
description: Uses an abbreviation instead of an IANA zone.
on:
  schedule:
    cron: "0 7 * * *"
    timezone: PST
---

Body.
`,
  },
  {
    dir: "bad-timeout",
    expect: 'timeout: "ten minutes" is not a duration — use 90s, 10m, 1h',
    file: `---
name: bad-timeout
description: Spells the timeout out in words.
timeout: ten minutes
on:
  manual: true
---

Body.
`,
  },
  {
    dir: "bad-hook-item",
    expect: "hooks.pre[1]: must be { script: <path> } or { prompt: <text> }",
    file: `---
name: bad-hook-item
description: Has a hook item that is neither a script nor a prompt.
on:
  manual: true
hooks:
  pre:
    - script: scripts/ok.js
    - command: ls
---

Body.
`,
    scripts: { "scripts/ok.js": "console.log('ok');\n" },
  },
  {
    dir: "bad-catch-up",
    expect: 'on.schedule.catch-up: "later" is not skip or once',
    file: `---
name: bad-catch-up
description: Uses a catch-up value outside the two the spec defines.
on:
  schedule:
    cron: "0 7 * * *"
    catch-up: later
---

Body.
`,
  },
  {
    dir: "bad-schedule-key",
    expect: "on.schedule.retries: unknown key — on.schedule has cron, timezone, catch-up",
    file: `---
name: bad-schedule-key
description: Adds a key to on.schedule that the spec does not define.
on:
  schedule:
    cron: "0 7 * * *"
    retries: 2
---

Body.
`,
  },
  {
    dir: "name-mismatch",
    expect:
      'name: "daily-brief" does not match the directory name "name-mismatch" — they must be the same',
    file: `---
name: daily-brief
description: The name does not equal the directory name.
on:
  manual: true
---

Body.
`,
  },
  {
    dir: "bad-name",
    expect:
      'name: "Daily_Briefing" is not a valid name — use lowercase letters, digits and single hyphens',
    file: `---
name: Daily_Briefing
description: The name uses characters the grammar does not allow.
on:
  manual: true
---

Body.
`,
  },
  {
    dir: "bad-enabled",
    expect: 'enabled: "yes" is not true or false — enabled is a boolean',
    file: `---
name: bad-enabled
description: Uses a string where a boolean belongs.
enabled: "yes"
on:
  manual: true
---

Body.
`,
  },
  {
    dir: "bad-model",
    expect:
      'model: "claude-sonnet-4-5" is not <provider>/<id>[:<thinking>] — for example anthropic/claude-sonnet-4-5:low',
    file: `---
name: bad-model
description: Names a model without its provider.
model: claude-sonnet-4-5
on:
  manual: true
---

Body.
`,
  },
  {
    dir: "no-trigger",
    expect: "on: needs at least one trigger — schedule, manual, watch",
    file: `---
name: no-trigger
description: Declares an empty trigger block.
on: {}
---

Body.
`,
  },
  {
    dir: "missing-on",
    expect: "on: required — at least one trigger (schedule, manual, watch)",
    file: `---
name: missing-on
description: Has no trigger block at all.
---

Body.
`,
  },
  {
    dir: "missing-description",
    expect: "description: required — ≤1024 chars saying what this automation does",
    file: `---
name: missing-description
on:
  manual: true
---

Body.
`,
  },
  {
    dir: "no-frontmatter",
    expect:
      "frontmatter: missing — AUTOMATION.md starts with a --- line, then YAML, then another --- line",
    file: `# No frontmatter

Just a body.
`,
  },
  {
    dir: "empty-body",
    expect:
      "body: missing — the Markdown body after the frontmatter is the prompt for each run",
    file: `---
name: empty-body
description: Has frontmatter but no body.
on:
  manual: true
---

`,
  },
  {
    dir: "absolute-script",
    expect:
      'hooks.pre[0].script: "/etc/cron-helper.sh" is absolute — use a path relative to the automation directory',
    file: `---
name: absolute-script
description: Points a hook at an absolute path.
on:
  manual: true
hooks:
  pre:
    - script: /etc/cron-helper.sh
---

Body.
`,
  },
  {
    dir: "escaping-script",
    expect:
      'hooks.pre[0].script: "../../evil.js" leaves the automation directory — scripts must live inside it',
    file: `---
name: escaping-script
description: Points a hook outside its own directory.
on:
  manual: true
hooks:
  pre:
    - script: ../../evil.js
---

Body.
`,
  },
  {
    dir: "unquoted-cron",
    expect: null, // asserted with a matcher: the YAML alias hint
    file: `---
name: unquoted-cron
description: Leaves a cron expression unquoted so YAML reads it as an alias.
on:
  schedule:
    cron: */15 * * * *
---

Body.
`,
  },
  {
    dir: "duplicate-key",
    expect: null, // asserted with a matcher: uniqueKeys
    file: `---
name: duplicate-key
description: First description.
description: Second description.
on:
  manual: true
---

Body.
`,
  },
  {
    dir: "bad-hooks-key",
    expect: "hooks.during: unknown key — hooks has pre, post",
    file: `---
name: bad-hooks-key
description: Adds a hook phase that does not exist.
on:
  manual: true
hooks:
  during:
    - prompt: nope
---

Body.
`,
  },
  {
    dir: "bad-manual",
    expect:
      'on.manual: false is not true — write "manual: true", or remove it to disallow manual runs',
    file: `---
name: bad-manual
description: Writes manual false instead of removing it.
on:
  schedule: "0 7 * * *"
  manual: false
---

Body.
`,
  },
  // on.watch — this host's one addition to the trigger table.
  {
    dir: "watch-not-a-map",
    expect:
      "on.watch: must be { script: <path>, every: <duration> } — for example script: scripts/watch.js and every: 5m",
    file: `---
name: watch-not-a-map
description: Gives the watch a bare script path.
on:
  watch: scripts/watch.js
---

Body.
`,
  },
  {
    dir: "bad-watch-key",
    expect: "on.watch.interval: unknown key — on.watch has script, every",
    file: `---
name: bad-watch-key
description: Spells the interval key its own way.
on:
  watch:
    script: scripts/watch.js
    interval: 5m
---

Body.
`,
  },
  {
    dir: "watch-missing-script",
    expect:
      "on.watch.script: required — the script that looks for work, relative to the automation directory",
    file: `---
name: watch-missing-script
description: Has an interval and nothing to run.
on:
  watch:
    every: 5m
---

Body.
`,
  },
  {
    dir: "escaping-watch-script",
    expect:
      'on.watch.script: "../watch.js" leaves the automation directory — scripts must live inside it',
    file: `---
name: escaping-watch-script
description: Points the watch outside its own directory.
on:
  watch:
    script: ../watch.js
    every: 5m
---

Body.
`,
  },
  {
    dir: "watch-missing-every",
    expect: "on.watch.every: required — how often to run the script, for example 5m",
    file: `---
name: watch-missing-every
description: Has a script and no interval.
on:
  watch:
    script: scripts/watch.js
---

Body.
`,
  },
  {
    dir: "bad-watch-every",
    expect: 'on.watch.every: "5 minutes" is not a duration — use 1m, 5m, 1h',
    file: `---
name: bad-watch-every
description: Writes the interval in words.
on:
  watch:
    script: scripts/watch.js
    every: 5 minutes
---

Body.
`,
  },
  {
    dir: "watch-too-often",
    expect:
      "on.watch.every: 30s is shorter than a minute — use 1m or more",
    file: `---
name: watch-too-often
description: Asks for a check more often than anything ticks.
on:
  watch:
    script: scripts/watch.js
    every: 30s
---

Body.
`,
  },
  {
    dir: "watch-too-rare",
    expect: "on.watch.every: 25h is longer than 24h — use on.schedule for anything rarer",
    file: `---
name: watch-too-rare
description: Asks for a check less than once a day.
on:
  watch:
    script: scripts/watch.js
    every: 25h
---

Body.
`,
  },
];

function writeAutomation(dir, name, spec) {
  const target = path.join(dir, name);
  mkdirSync(target, { recursive: true });
  writeFileSync(path.join(target, "AUTOMATION.md"), spec.file);
  for (const [rel, body] of Object.entries(spec.scripts ?? {})) {
    const p = path.join(target, rel);
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, body);
  }
}

/** Build the fixture tree under `dest`. */
export function buildFixtures(dest) {
  rmSync(dest, { recursive: true, force: true });

  const userRoot = path.join(dest, "user", ".agents", "automations");
  for (const [name, spec] of Object.entries(USER)) writeAutomation(userRoot, name, spec);

  const projectRoot = path.join(dest, "project");
  mkdirSync(path.join(projectRoot, ".git"), { recursive: true });
  const projectAutomations = path.join(projectRoot, ".agents", "automations");
  for (const [name, spec] of Object.entries(PROJECT)) writeAutomation(projectAutomations, name, spec);

  const invalidRoot = path.join(dest, "invalid", ".agents", "automations");
  for (const spec of INVALID) writeAutomation(invalidRoot, spec.dir, spec);

  return { root: dest, userRoot, projectRoot, projectAutomations, invalidRoot };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const p = buildFixtures(path.join(here, "..", "fixtures"));
  console.log("fixtures written to", p.root);
}
