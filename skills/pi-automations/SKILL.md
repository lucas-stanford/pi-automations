---
name: pi-automations
description: Check, arm, run, schedule and debug Agent Automations in pi with the pi-automations package, and make runs leave notes and a message. Use when writing, testing or debugging an automation in pi, or when the user mentions `pa`, `/automations`, arming or consent, a run's records, a watch check, the watcher, notes or a run's message, or the Automation Manager.
license: MIT
compatibility: pi-automations in pi 0.84.4 or later, with Node.js 22.19 or later. The `pa` command ships with the package.
---

# pi-automations

For the file format and how to write an automation, load the `agent-automations` skill. This skill covers the pi-automations host: how to check, arm, run and schedule an automation, its defaults, and how a run reports.

`pa` is the shell command (also installed as `pi-automations`). Inside pi, the `/automations` page shows the same things, and `/automations <verb> <name>` runs one verb: `/automations check hello-world`.

## Check, arm, run, schedule

1. Write the folder with `on: { manual: true }` first.
2. `pa check <name>`: the state must be `off`, waiting for consent. `invalid` is followed by one line saying what is wrong and how to fix it. With `flow: strict`, every mismatch is listed with its line.
3. Arming is the user's decision. `pa arm <name>` prints the preview, changes nothing and exits `2`. Show it to the user, and run `pa arm <name> --yes` only when they say yes. Never arm on your own.
4. `pa run <name>` runs it now and waits. Exit `0` ok, `10` skipped, `20` failed, `30` aborted, `2` refused (not found, invalid, disabled, no manual trigger). An automation that is not armed does not run: `pa run` prints the consent preview instead.
5. Read the result with `pa runs <name> [n]`: the last runs with their outcome, what each said, its notes and its message.
6. For a watch, `pa watch <name>` runs one watch check now and says whether a tick would start a run. It starts and records nothing. Exit `0` would start a run, `10` would not, `20` could not check. `pa watch` lists every watch; `pa watch pause <name>` and `pa watch resume <name>` pause and resume its watch checks.
7. Add the schedule or watch and keep `manual: true`. That edits the file, so it is `off` again: show the user the new `pa arm <name>` preview and arm it again only on their yes. `pa check <name>` then lists the next runs.
8. Schedules and watches need the watcher, which fires schedules and runs watch checks: `pa watcher start` once, and `pa watcher status` to see it. In a container, `pa serve` ticks in the foreground.

## Consent

- Every automation, in `~/.agents/automations` or in a repository, is `off` until a person arms it.
- Consent is pinned to a hash of `AUTOMATION.md`, every script it can run, and the local modules those scripts import (`./` and `../` imports in `.mjs`, `.js` and `.cjs` files). Any edit to one of them turns it `off`, naming the file: `changed since armed: scripts/x.mjs`.
- Consent to a repository automation expires after 30 days (`consentExpiry`). Consent to a user automation lasts until its files change or `pa disarm <name>`.
- `pa enable <name>` and `pa disable <name>` flip `enabled:` in a user automation and keep the consent it had. For a repository automation, edit and commit the file; `pa disarm <name>` keeps it off on this machine.

## Defaults and limits

All set in `~/.pi/agent/pi-automations/config.json`; every key is optional.

| Key | Default | Means |
|---|---|---|
| `defaultTimeout` | `20m` | A run's timeout when the file sets none. |
| `maxTimeout` | `4h` | A larger `timeout` makes the automation invalid. |
| `hookTimeout` | `60s` | Per hook. Watch scripts get at most `2m`. |
| `hookMaxOutputBytes` | 1 MiB | Per hook. |
| `grace` | `10m` | How late a tick may be and still count as on time. |
| `catchUpWindow` | `7d` | How far back `catch-up: once` looks. |
| `consentExpiry` | `30d` | Repository automations only. |

- A watch check counts as due up to 30 seconds early, so tick jitter does not add a minute.
- Besides `~/.agents/automations` and `<repo>/.agents/automations`, pi-automations also reads `~/.pi/agent/automations` and `<repo>/.pi/automations`.
- Scheduled runs do not read the shell profile. Log in to the model with `pi /login`, and to tools with their own login (`gh auth login`).
- Consent, run records, locks and logs live in `~/.pi/agent/pi-automations/`, never in a repository.

## Reporting from a run

The body, every hook and anything they start get `AUTOMATION_RUN` and `AUTOMATION_STATE_DIR`, and `pa` first on `PATH`. The host adds a short `<notes>` block to every run's prompt (a `<progress>` block when the run is tracked) that tells the agent to record what it publishes with `pa note` and to finish with one `pa message`. So a body can ask for receipts in plain words, as the `agent-automations` skill says. Naming `pa` in a body is optional and works only in pi-automations; if you do, add "If `pa` fails, carry on."

| Command | Does |
|---|---|
| `pa note "text" --link "label=https://…"` | Records what the run published, with its links. |
| `pa message "text" --link "label=https://…"` | The run's one message for the reader. A later one replaces it. |
| `pa step <node>` · `pa next <to> --from <node>` · `pa say "text"` | Moves and updates on a tracked run. |
| `pa status [--json]` | Where the run is, its notes and its message. |

With `flow: strict`, `pa next` must follow an arrow of the chart, or it is refused with `NOT_AN_EDGE`. A section that says "go to `fix`" means `pa next fix --from <this step>`. Every flag, exit code and the JSON output are in [references/reporting.md](references/reporting.md).

## Where results show

- The `/automations` page: Needs you at the top (failed runs, automations waiting for consent), then Running now, Coming up, Watching, and Off and disabled. The selected automation's last message shows under the list; `enter` opens its automation page.
- `pa runs <name> [n]`, and `pa running` for runs in flight.
- `pa report [--open]`: a self-contained HTML report.
- The Automation Manager, when `"plugins": ["manager"]` is in the config: `pa edit <name>` opens it in a browser, with each run drawn on its chart and every run's message in History.
