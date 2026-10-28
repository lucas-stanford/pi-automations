/**
 * The plugin API, version 1 (types only). A plugin is a module named in the person's own
 * `config.json` (`"plugins": [...]`), never in a repository. It default-exports `{ name, setup(api)
 * }` (or just `setup`), called once per process that loads it (`host`, `worker` or `cli`). Every
 * call into a plugin is bounded; a plugin that throws or hangs is reported and otherwise ignored.
 * Import these types with `import type` only.
 */
export {};
//# sourceMappingURL=types.js.map