# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## Unreleased

First public release (0.1.0, not yet published).

### Added

- A fourth template in the agent-automations skill, `watch-pr-review`: a watch on pull requests that
  ask for my review, a pre hook that picks one, three review angles posted as one review, and a strict
  chart with a shortcut that posts a review an earlier run saved.
- Discovery of `AUTOMATION.md` files in `~/.agents/automations`, `~/.pi/agent/automations` and
  repository `.agents/automations` / `.pi/automations` folders, implementing Agent Automations
  Draft 0.2 with strict validation of the eight frontmatter fields.
- Triggers: cron schedules with time zones, a grace period, stagger and `catch-up`; manual runs; and
  `on.watch`, a script that starts a run only when it finds new work.
- Script and prompt hooks before and after the body, with pre-hook output passed as data.
- Consent for every automation, pinned to a hash of the file and its scripts: nothing runs until a
  person has seen its preview and armed it.
- Background runs and the watcher (`pa watcher start|stop|status`) on Windows (Task Scheduler),
  macOS (launchd) and Linux (systemd user timer or cron), plus `pa serve` for containers.
- Run records with the outcome, error kind, hook results, the body's answer and what the run
  published. File locks keep an automation from running twice at once. A person can stop a run,
  and the run records `aborted` itself.
- Progress and notes for every run (`pa step|next|say|note|status`). A run is tracked on a Mermaid
  flowchart when `AUTOMATION.md` has one.
- The `/automations` page in pi, with automation, check, runs and run pages, a compact running strip
  and footer, transcript entries, and an HTML report. An open `/automations` page re-reads every 10
  seconds, so it keeps up with runs the watcher fires.
- The `pa` command line (also installed as `pi-automations`), with the same verbs and an exit code
  for each outcome.
- A plugin API (observers, actions, flowchart renderers, host services), loaded only from the
  person's own config, and the bundled Automation Manager plugin.
- Optional flowchart drawing with `fm render`.
- The [Agent Automations Draft 0.2 specification and site](https://github.com/lucas-stanford/agent-automations)
  live in their own repository, with a Markdown copy of every page and `llms.txt`.
- The `agent-automations` Agent Skill in `skills/`, shipped in the package and declared in the `pi`
  manifest: how to choose a trigger, write the file, gather facts in hooks, write watch scripts and
  ask a run for receipts, with references, three templates and a review checklist. It names no host,
  so it works with any host of the format. The spec site renders it as pages and offers the folder
  and a zip of it for download.
- The `pi-automations` Agent Skill beside it: checking, arming, running and scheduling with `pa`,
  this host's defaults and limits, and reporting with `pa note` and `pa message`. It ships in the
  package only.
- `pa message "…" --link "label=https://…"`: one message per run for its reader, the last one wins.
  It is kept on the run record and given to plugins as a `message` event. The `/automations` page
  shows it under the selected automation with its links first, and it leads the Automation
  Manager's run page and its new History page (every automation's runs, newest first, filterable).
- `flow: strict`, the eighth field (Draft 0.2): the body's flowchart sets its sections. Each step
  has one `## <label> {#id}` section in the flowchart's order, and a step that branches names where
  it goes. `pa check` lists every mismatch with its line. In a strict run, `pa next` must follow an
  arrow of the flowchart (`NOT_AN_EDGE` otherwise). `flow: loose`, the default, changes nothing.
  Flowcharts, `flow` and strict flow are one optional section of the specification; a host that
  skips it still accepts `flow: loose` and refuses `flow: strict`.

### Changed

- A run's steps are listed in the order the run goes through them: each step after every step
  with an arrow into it, loops kept together. A shortcut such as `body --> post` no longer lists
  `post` second, ahead of the steps on the longer path.
- The `/automations` page draws each section heading in a soft colour of its own (deeper shades
  on light themes). Terminals without colour, and `NO_COLOR`, keep plain bold headings.
- User automations (`~/.agents/automations`, `~/.pi/agent/automations`) are no longer armed when
  they are found. Anything that can write to your home directory (an agent, a sync tool, an
  installer) could otherwise start a schedule with your credentials. They now stay `off` until you
  arm them, like repository automations, and editing the file or a script turns them off again. Their consent does not expire; `consentExpiry` applies to repository automations only.
  After updating, arm each one you want running: `pa arm <name>` shows the consent preview, and
  `pa arm <name> --yes` accepts it (or press `a` on the `/automations` page). `pa disable` and `pa enable` keep
  the consent an automation already had. Older `trust.json` files load unchanged.
- A run's `timeout` now stops a pre-hook script that is still running when it expires, as the
  specification says, instead of waiting for the hook's own 60-second limit. A pre hook cut off by
  the timeout or by a stop records the run as `failed` with `timeout`, or `aborted`, rather than as a
  hook failure.
- The specification page is shorter. Each rule is stated in one place, and the refusal examples moved
  to a new Validation messages page that lists every refusal by field. It now states the validation order in
  full, the state order, that hook scripts are bounded and post hooks run outside `timeout`, and
  that a refused manual request leaves no record; it calls the second scope "repository" throughout.
- Arming, disarming and the sweep can no longer be undone by another process. The tick, a pi
  session or a run used to write back its whole copy of `trust.json`, loaded seconds earlier, when
  it saved the times it last saw each automation, so a `pa arm` in between was lost without a word
  and the automation stayed `off`. Every change now re-reads `trust.json` under a lock and writes
  only its own change; a sighting only moves `lastSeenAt` forward and never brings a record back.
  JSON state files are also written through a temporary file of the writer's own.
- The listing, the HTML report and command output call the second scope "repository" too, and
  `pa <verb> repository/<name>` picks a repository automation. The watcher's commands are
  `pa watcher start|stop|status`. Messages and the `/automations` page use the specification's
  words: `aborted` for a stopped run, disable and enable for `enabled:`, and "unknown key" in
  refusals for a key inside `on.schedule`, `on.watch`, `hooks` or `config.json`.

### Publishing checklist (TODO)

- Set `repository`, `homepage` and `bugs` in `package.json`.
- Add a `pi.image` gallery preview to `package.json`.
- Fill in the security and conduct contacts.
- Link the fm repository from the README and `docs/FLOWS.md`.
