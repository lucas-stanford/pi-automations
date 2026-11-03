# Design

This file records the decisions that shape pi-automations and the reasons for them. It is for
contributors; users should start with the [README](../README.md).

## What it is

A host for [Agent Automations](https://agentautomations.io) Draft 0.2 inside the pi coding agent.
It discovers `.agents/automations/<name>/AUTOMATION.md`, decides whether each one may run, fires
them on cron schedules or when a watch script finds work, and keeps a durable record of every run.

The code is split into a portable core (`src/core/index.ts`: discovery, consent, schedules, locks,
hooks, records, progress, pure line builders) and a pi host (`src/hosts/pi/*`, the pi runtime
provider, the OS schedulers, desktop notifications). The core never imports pi or fm and
does nothing at import time; `test/architecture.test.ts` checks this in a child process. Another
host composes its own runtime, script executor, worker transport and notifier; see
[PROVIDERS.md](PROVIDERS.md).

## The file format is closed

Draft 0.2 has eight frontmatter fields, and the parser refuses any other field by name. A host that
ignored an unknown field would arm something the author did not write. Every error is one line:
`<field path>: <what is wrong> — <what fixes it>`.

- YAML is parsed as 1.2 so `on:` stays a key (YAML 1.1 reads it as `true`), with duplicate keys
  refused.
- Cron is validated against the Draft 0.2 cron grammar before croner sees it. croner accepts much
  more (`@daily`, `L`, `#`, six fields), so it only does the date arithmetic.
- `on.watch` is the one extension. The specification reserves `on:` for new trigger types and
  requires a host to refuse a trigger type it does not implement, so another host refuses a file
  with `on.watch` instead of running it without its watch.
- Model ids may contain colons (`amazon.nova-2-lite-v1:0`); whether a trailing `:x` is a thinking
  level is decided against the known levels, not the regex.
- `flow: strict` (`src/strict-flow.ts`) binds the body's `##` sections to the flowchart's steps by
  `{#id}`. It is the one check that reports every problem instead of the first. The flowchart and the
  text tend to disagree in several places at once, and fixing them one save at a time would be slow. The checker is pure and
  numbers lines from the file, so `pa check`, the check page and the Automation Manager show each
  problem on its own line. At run time a strict run refuses a `pa next` with no arrow
  (`NOT_AN_EDGE`); moves between hooks and the body are the host's own and are not checked.

## Consent: every automation is off until armed

Every automation, user (`~/.agents/automations`, `~/.pi/agent/automations`) or repository, is
listed but does nothing until the person has seen the consent preview and pressed `y`. The preview
shows the schedule, model, timeout, hooks and the exact command each script will run. Any other
key means no. User scope gets no
exception: agents, sync tools and installers write into the home directory too, and a file there
would otherwise run on a schedule with the person's credentials without anyone reading it.
`pa enable` and `pa disable` re-pin consent that held just before their one-line edit, so disabling
an automation and enabling it again does not disarm it. Any other edit does.

Consent is pinned to a SHA-256 over `AUTOMATION.md` and every script it can run (watch script
first, then hooks), with each relative path hashed beside its bytes. The local modules those scripts
import come next, sorted. A module is any file named by a `./` or `../` path in `import … from`,
`import(…)`, `export … from` or `require(…)` in a `.mjs`, `.js` or `.cjs` file, followed through
any number of files. Packages, and files outside the automation folder, are not pinned. aat hashes
the same bytes, and an automation that imports nothing local keeps the digest it always had.
Editing any of them returns
the automation to `off`, and the notice names the file that changed (per-file hashes are stored at
arm time). Consent to a repository automation also expires (`consentExpiry`, 30 days); consent to a
user automation does not, so a user automation's schedule keeps running until its bytes change or
it is disarmed. Interpreters are resolved to absolute paths when it is armed, because the watcher
does not inherit the shell's PATH.

Credential-shaped variables (`*_API_KEY`, `*_TOKEN`, `*_SECRET`, `*_PASSWORD`, `*_CREDENTIAL(S)`)
never reach a hook, a watch script or the watcher's job file. The job file's environment is an
allow-list.

## Plugins come from your config only

Plugins are named in `~/.pi/agent/pi-automations/config.json` (`"plugins": ["manager", "~/x.mjs"]`)
and nowhere else. A plugin runs with the person's permissions in every pi session, every run and
every `pa` command; a repository that could name one would run code nobody consented to. Relative
paths are refused because "relative to what" would be a guess.

A plugin is handed the host (`api.host`: discovery, parsing, compose and save with an on-disk
revision check, run records, live progress, models) and imports only this package's types, so it
always runs against the pi-automations that loaded it and never carries a copy of its rules. Every
call into a plugin is bounded (5 s) and caught: a load failure is a warning, an observer failure is
`pluginProblems` on the run record, and nothing a plugin returns can change a run. The Automation
Manager in `packages/manager` is the one bundled plugin.

## One run at a time, by file locks

- The tick lock lets one tick evaluate schedules at a time. A lock whose owner is dead, or older
  than five minutes, is replaced, so a reboot cannot stop ticking for ever.
- Each automation has one run lock, taken with `O_EXCL` (one atomic create). Nothing queues behind a
  held lock: the tick records `skipped: still running` and moves on.
- Short write locks guard check-then-write sequences (progress events, state). An abandoned lock is
  broken under a second "breaker" lock, and only if the lock is still the same file, so two writers
  cannot both decide it was abandoned.
- The tick sweeps stale run locks (dead pid, or older than the timeout plus hook budgets plus slack)
  and writes `aborted: host stopped`, the only trace such a run leaves.
- Stopping a run is a request. `x` writes a stop file naming the run id; the run polls for it, aborts
  its body, runs its post hooks and records `aborted` itself. No signal is sent, because on Windows a
  signal kills the child outright and strands the lock.

## Scheduling and claims

The tick runs every minute from the watcher (an OS job: Task Scheduler, launchd, systemd timer or
crontab) or from `pa serve`. Nothing ticks without one of them. `decideTick` is pure, so sleep, wake, grace,
catch-up and stagger are table tests.

- `state.json` records the last scheduled instant claimed per automation. The claim is written before
  the run is spawned, so a crash in between costs at most one run, never a duplicate.
- Any run that starts (scheduled, manual or watch) claims the instant it covers, so a manual 09:00
  run stops catch-up from repeating the missed 07:00. A refused run claims nothing.
- Each automation has a deterministic stagger (a hash of its key), capped at half its shortest
  period so a per-minute schedule still fires.
- A launch is either confirmed started, confirmed failed (one terminal record, claim kept) or
  uncertain (no record, claim kept, reason printed by the tick). An uncertain launch never gets an
  invented outcome, because the worker may be running.
- The tick and commands share `state.json`; each side writes only the fields it owns and commands
  re-read before writing, so neither undoes the other.

## Run records

`runs/<slug>.jsonl` holds one JSON line per terminal outcome: `ok`, `skipped`, `failed`, `missed`
(collapsed per tick) or `aborted`, with the error kind, hook results, a bounded excerpt of the
answer, its notes and message, and, for a tracked run, its flowchart, steps and arrows taken. The
record is what a run is for: post hooks always run, every integration failure after the record is a diagnostic
in the fire log rather than a second record, and a missing pi becomes an ordinary record naming the
fix. A torn last line (a process killed mid-append) is skipped on read and repaired before the next
append.

Each run is its own worker process (`bin/fire.js`), attached or in the background. Its stdout is
NDJSON events, the last being the record. A background run appends them to a per-automation fire
log, from which other processes rebuild an observed run's view.

## Progress and notes live in core

Progress used to be kept by an external flow tool. It now belongs to the run: one append-only file
per run (`progress/<runId>.jsonl`), folded into the record at the end and then removed.

- Any process given `AUTOMATION_RUN` (the body, a hook, a subagent several levels down) reports
  with `pa step|next|say|note|message`. Writes take a short lock and check preconditions inside
  it, so concurrent writers converge; repeating a move changes nothing; `--request-id` makes `say`,
  `note` and `message` exactly-once.
- Every run can leave notes (what it published, with http(s) links) and one message for its reader
  (`pa message`, the last one wins). Notes are the log; the message is what a person reads first.
  Every surface shows the message, else the notes, else the answer. Only a tracked run (a Mermaid
  flowchart in `AUTOMATION.md`, or `config.flowTracking`) has nodes.
- A node still running at the end is recorded as `interrupted`, never as `done`. A `.closed`
  tombstone tells a late subagent `RUN_CLOSED`.
- fm, if installed, only draws (`fm render`); without it the flowchart is a step list. A flowchart
  that does not fit is never clipped.

## The `/automations` page

`/automations` opens one full-screen page whose first line says whether anything needs the person:
`✓ Nothing needs you.` or a Needs you card. A card says what happened, why, and the one key that
deals with it, plus "or leave it: it runs again …" when doing nothing is fine. Running runs are
cards too. Everything else is a quiet agenda with no colour except one green ✓: Coming up
(scheduled, by next run), Watching (by name, with how often it checks) and Off and disabled.

Rows never jump: the order is computed when the page opens and on real changes (a run starts or
ends, a reload, an action), never on the clock, and the cursor follows the automation, not the row.
Colour marks state and outcome only, every time is local, and every action re-reads state first, so
nothing acts on a stale row. Inside pi the pages are pure line builders over a structural
`Component`; outside a terminal (`pi -p`, RPC, `pa`) the same commands print plain lines.

Run output is published to the transcript with `appendEntry`, never `sendMessage`, so it never
enters the model's context of an unrelated conversation.

## Running outside pi

`bin/fire.js` and `bin/tick.js` are plain node processes, where pi's loader aliases do not exist and
pi is not installed beside the package. `pi-module.ts` finds the SDK from, in order, the path handed
down by the parent, `piModule` in config, ordinary resolution, the `pi` on PATH and the npm global
root. It accepts only a directory whose `package.json` names the pi package. Nothing under `src/` imports a
pi value at module scope; the one lazy loader is the pi runtime provider.

`dist/` is committed because pi installs git packages with `npm install --omit=dev`, which cannot
build. `test/dist.test.ts` fails if it is not exactly what `tsc` emits from `src/`. The extension
entry imports only `dist/index.js` and reports clearly when a reloaded extension meets an older
cached dist.

## The pi SDK window

The package declares pi as a host-provided peer (`"*"`), and a script measures compatibility:
`npm run verify:sdk-lifecycle` drives the SDK's real session replacement and extension loading at
several versions and records the event counts in `docs/pi-sdk-lifecycle-matrix.json` (currently
0.84.4, 0.85.1, 0.99.2 and 1.2.0: three factory calls, two replacements, no start on a disposed
instance, three shutdowns). The minimum supported pi is 0.84.4.
