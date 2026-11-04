# Contributing

Bug reports and pull requests are welcome.

## Setup and checks

You need Node.js 22.19 or newer, and fm for trying the extension in pi.

```sh
npm install
npm run typecheck
npm test
```

The tests drive the extension through a fake pi API and a fake `fm` that records how it was called;
they never touch your fm state or automations. To try a working copy in pi:
`pi -e ./extensions/automations.ts`.

## Where things belong

- What an automation means, and how it runs, is fm's (https://github.com/lucas-stanford/fm) and
  the specification's (https://github.com/lucas-stanford/agent-automations). This package only shows
  and drives fm from pi.
- `skills/agent-automations` is a copy of the specification repository's skill. Change it there,
  then copy it here.

## Pull requests

- Keep each pull request to one change, with tests for behaviour you change.
- Update `README.md` and the `Unreleased` section of `CHANGELOG.md` when what a person sees changes.
