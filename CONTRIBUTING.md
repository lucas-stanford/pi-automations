# Contributing

Thanks for helping. This file covers setup, the checks a change has to pass, and how to write
commits.

GitHub Actions workflows are omitted from this copy. Run the checks below locally.

> TODO before publishing: set `repository`, `homepage` and `bugs` in `package.json` (they point at
> `https://github.com/OWNER/pi-automations`), the `pi.image` gallery preview, and the contacts in
> [SECURITY.md](SECURITY.md) and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## Setup

You need Node.js 22.19 or newer and git.

```
git clone https://github.com/OWNER/pi-automations
cd pi-automations
npm ci
```

pi itself is a dev dependency, so the tests run without a global pi. To try the extension in a real
pi, install your working copy: `pi install ./` (or `pi install git:<your fork>`).

## The root package

```
npm run build       # tsc -> dist/
npm run typecheck   # build, then check extensions/ and the example runtime
npm test            # vitest
```

`dist/` is committed, because pi installs git packages with `npm install --omit=dev` and cannot
build them. Rebuild before committing a change under `src/`; `test/dist.test.ts` fails if `dist/`
is not exactly what `tsc` emits. Check that a rebuild leaves `git status` clean.

Tests must never touch your real automations or pi state: use the helpers in `test/helpers/`
(temporary state directories, explicit discovery roots, fake pi hosts). `test/isolation.test.ts`
guards this.

`npm run verify:sdk-lifecycle` installs several pi versions into a temporary directory and records
how the extension behaves across session replacement; it needs network access and is not part of
`npm test`. Update `docs/pi-sdk-lifecycle-matrix.json` with its output when you add a version.

## The spec site (`site/`)

`site/content/*.md` is the Agent Automations specification site. Pages in the `pi-automations`
group (`group: pi-automations`) are about this host; every other page stays host-neutral, with no
`pa`, `/automations` or pi-automations details beyond a link into that group (`test/site.test.ts`
checks). `npm run site` rebuilds `site/dist/`,
which is committed so it opens straight from disk. `npm run site:check` (also part of `npm test`)
parses every example on the site and in the agent skill with the real parser, checks every link,
and fails if `site/dist/` is not what a fresh build produces.

Two agent skills ship in the package. `skills/agent-automations` is host-neutral: it never names
`pa`, pi or pi-automations (`test/skills.test.ts` checks). The site build renders its SKILL.md and
references as pages under "Agent skill", copies the folder unchanged into `site/dist/skills/` and
zips it beside the copy. Edit the skill, not the pages. `skills/pi-automations` covers this host
(`pa`, consent, defaults, reporting); it is not published on the site, and every `pa` verb it
names must exist.

## The Automation Manager (`packages/manager`)

The bundled plugin is a separate package with its own lockfile. Its build output
(`packages/manager/dist` and `packages/manager/plugin`) is committed for the same reason as the root
`dist/`.

```
cd packages/manager
npm ci
npm run build       # typecheck, app build, plugin build
npm test            # vitest (jsdom)
npx playwright install chromium
npm run test:e2e    # playwright against a mock server
```

The e2e tests use Playwright's bundled Chromium. To use an installed browser channel instead, set
`PW_CHANNEL` (for example `PW_CHANNEL=msedge npm run test:e2e`).

The Automation Manager's server tests import the root `dist/`, so build the root package first.

## Pull requests

- Keep changes focused, with tests for behaviour changes.
- Run `npm run typecheck` and `npm test` (and the manager checks if you touched it) before pushing.
- Update the docs and `CHANGELOG.md` (under "Unreleased") when behaviour a user can see changes.
- Comments explain why, not what, and stay short.
- Prose, UI text, messages and comments use the terms in [docs/GLOSSARY.md](docs/GLOSSARY.md).

## Commit messages

Plain English, imperative mood, a short summary line (about 72 characters or fewer), then a body
that explains what changed and why when it is not obvious. One logical change per commit; no
prefixes are required.
