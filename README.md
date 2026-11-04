# pi-automations

[Agent Automations](https://github.com/lucas-stanford/agent-automations) in the
[pi](https://pi.dev) coding agent, run by [fm](https://github.com/lucas-stanford/fm).

An automation is a folder with an `AUTOMATION.md`: YAML frontmatter that says when an agent runs
(a schedule, a watch script that finds new work, or by hand) and a Markdown body that is the prompt.
fm finds them, asks before anything runs, fires schedules and watches with or without pi open, runs
each step through its agent, and keeps every run's record. This package brings fm into pi.

## What it adds to pi

- **`/automations`** (or **ctrl+alt+a**) opens fm's screen over pi's: what needs you, what is
  running, what comes next, each automation and each run with its flowchart, live output, notes and
  message. Arm, run, stop, pause a watch or edit (`e`) from there; `q` brings you back to pi.
- **`/automations <verb> …`** runs one fm command: `list`, `check`, `arm`, `disarm`, `run`, `stop`,
  `log`, `enable`, `disable`, `watch`, `agent`, `watcher`, `validate`. `arm` shows fm's consent
  preview in pi and asks first; `run` starts the run in the background. `/automations help` lists
  them.
- **`/automations new [what]`** puts a prompt in the editor for pi to write a new automation with
  the `agent-automations` skill; finish it and send.
- **The footer** shows what is running and on which step (`◐ gamegen-issue-fix · Implement the fix ·
  12m`), or how many are armed. A notification says how each run ended, with its message.
- **Two skills**: `agent-automations`, the format and how to write one, and `fm`, how to check, arm,
  run, debug and report from a run.

## Install

1. Install fm and choose the agent CLI that runs your automations:

   ```sh
   cargo install --locked --git https://github.com/lucas-stanford/fm flow-manager
   fm agent default pi
   ```

   If fm is not on pi's `PATH`, set `FM_BIN` to it.

2. Install the package:

   ```sh
   pi install git:github.com/lucas-stanford/pi-automations
   ```

3. In pi, `/automations` opens fm's screen. Start the watcher once, so schedules and watches fire
   while pi is closed: `/automations watcher start`.

## Development

```sh
npm install
npm run typecheck
npm test
```

The extension is one file, `extensions/automations.ts`, which pi loads as TypeScript. Try a
working copy with `pi -e ./extensions/automations.ts`.

`skills/agent-automations` is a copy of the skill in the
[agent-automations](https://github.com/lucas-stanford/agent-automations) repository; copy it again
when that changes.

## License

MIT
