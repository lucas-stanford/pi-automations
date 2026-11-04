---
name: fm
description: Check, arm, run, schedule and debug Agent Automations with fm, the host that runs them, and make a run report its steps, decisions, notes and message. Use when testing, running or debugging an automation, or when the user mentions fm, /automations, arming or consent, a run's record or log, a watch check, the watcher, a node or step handed to another agent, or a run's notes or message.
license: MIT
compatibility: fm 0.1 or later on PATH (or FM_BIN). In pi, the pi-automations package adds /automations.
---

# fm

For the file format and how to write an automation, load the `agent-automations` skill. This skill
covers fm, the host that runs automations: how to check, arm, run and schedule one, how a run
reports, and where things live.

In pi, `/automations` opens fm's screen (what needs the person, what is running, what comes next;
`q` comes back), and `/automations <verb> <name>` runs one fm command: `/automations check daily`.
In a shell it is `fm <verb>`.

## Check, arm, run, schedule

1. Write the folder with `on: { manual: true }` first. `fm validate <folder>` checks the file alone;
   it prints `<name>: valid` or the first refusal, `<field>: <what is wrong> — <what fixes it>`.
2. `fm check <name>` checks it on this machine (scripts runnable, agent and model, each node's
   agent) and prints its consent preview: the exact agent command, each node, the hooks and the
   files consent is pinned to. The state must be `off` (not armed). `invalid` comes with one line
   saying why.
3. Arming is the person's decision. Show them the preview, and run `fm arm <name> --yes` only when
   they say yes. Never arm on your own. In pi, `/automations arm <name>` shows the preview and asks.
4. `fm run <name>` runs it now and shows it as it goes (`--detach` starts it in the background;
   `/automations run` always does). Exit `0` ok, `10` skipped, `20` failed, `30` aborted, `2`
   refused (not found, invalid, disabled, not armed, already running).
5. Read what happened with `fm log <name> [-n N]`: each run's outcome, what it said, its notes and
   its message. `--json` gives the whole record, with its `history`: every step, decision and update.
6. Add the schedule or watch and keep `manual: true`. That changes the file, so it is `off` again
   until the person arms it again.
7. Schedules and watches need the watcher: `fm watcher start` once (an OS job that ticks every
   minute), `fm watcher status` to see it. `fm watch pause|resume <name>` pauses a watch's checks.

## Consent

- Every automation is `off` until a person arms it. Consent is pinned to a hash of `AUTOMATION.md`,
  every script it can run and every local module those import: changing any of them turns it `off`.
- Consent to a repository automation lasts 30 days (`consent-expiry`); to a user one, until it
  changes. `fm disarm <name>` withdraws it. `fm enable|disable <name>` flips `enabled:` in a user
  automation and keeps its consent.

## Reporting from inside a run

The body, its hooks and everything they start get `AUTOMATION_RUN`, `AUTOMATION_STATE_DIR` and, on a
tracked run, `AUTOMATION_NODE`, with fm first on `PATH`. fm tells the agent how to report at run
time, so a body can ask in plain words; these are the commands:

| Command | Does |
|---|---|
| `fm next <to> --from <step> -m "<why>"` | Finish a step and start the next, along the chart: a decision, and why. |
| `fm say "<text>" [--node <step>]` | An update on a step: what it found or did. |
| `fm step <step> [--status active\|waiting\|done\|failed\|skipped] [-m text]` | Set one step. |
| `fm note "<text>" --link "label=https://…"` | What the run published, with its links. |
| `fm message "<text>" --link "label=https://…"` | The run's one message for its reader; the last one wins. |
| `fm status [--json \| --format markdown]` | Where the run is. `--json` has the `history`; `--format markdown` is the run as a page for an issue or pull request: its flowchart coloured by status, each step with its time, every update and decision. |
| `fm node <step> -m "<handoff>" [--cwd dir]` | Hand a step listed in `nodes:` to its own agent and print its answer. |

With `flow: strict`, `fm next` must follow an arrow of the chart (`NOT_AN_EDGE` otherwise). A
section that says "go to `fix`" means `fm next fix --from <this step> -m "<why>"`. If `fm` fails
inside a run, carry on.

## Steps on their own agent

`nodes:` hands steps of a strict chart to another agent CLI or model:

```yaml
nodes:
  build: { agent: claude, model: anthropic/claude-opus-4-5:high, timeout: 90m }
  review: codex
```

fm checks each node can run here and lists it in the consent preview. It tells the body which steps
are nodes; the body hands each over with `fm node <step> -m "…"` and goes on from the answer. The
node's agent gets its step's section, the text before the first `##` and the run's input. Agents fm
runs: `pi`, `copilot`, `claude`, `codex`, `gemini`, `opencode` (`fm agent list` shows the ones
installed). `fm agent default <cli>` picks the one every automation's body uses.

## Where things live

- Automations: `~/.agents/automations/<name>/` (user) and `<repo>/.agents/automations/<name>/`
  (repository).
- fm's state (consent, run records, progress, transcripts, `config.toml`): `FM_HOME`, else
  `~/Library/Application Support/agent-automations` on macOS, `$XDG_STATE_HOME/agent-automations`
  (or `~/.local/state/agent-automations`) on Linux, `%LOCALAPPDATA%\agent-automations` on Windows.
  Never inside a repository.
- `config.toml` holds the defaults (`default-timeout` 30m, `max-timeout` 4h, `hook-timeout` 5m,
  `grace` 5m, `consent-expiry` 30d), `default-agent`, and per-CLI settings under `[agents.<cli>]`:
  `path`, `extra-args`, `allow-all-tools`, `default-model`.
- Scheduled runs do not read the shell profile: log in to the agent (`pi` → `/login`) and to tools
  (`gh auth login`) with their own logins.
