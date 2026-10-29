# Backward compatibility

Surfaces other people and their stored data depend on. A breaking change to any of them needs the path listed, a note in the release notes, and a version bump (minor while the tool is `0.x`, major afterwards).

| Surface | Where | Breaking change | Required path |
|---|---|---|---|
| CLI commands and flags | `src/cli.ts`, `docs/guide.md` | Removing or renaming a command or flag, changing a default, changing an exit code scripts rely on | Keep the old spelling working for one release with a warning, or document the break in the release notes and bump the version |
| Saved settings | `.mercato/module-tool.json`, legacy `mercato-modules.json` (`src/config.ts`) | Renaming or retyping a field, rejecting a file an earlier version wrote | New fields are optional; old files keep loading. A format change needs a new `version` and a migration on read |
| Development link metadata | `development` in saved settings (`src/development.ts`) | Changing `formatVersion: 1` paths or meaning | New `formatVersion` with the old one still accepted |
| Published package layout | `src/package.ts`, `src/build.ts` | Changing `exports`, the `src`/`dist`/`types` layout, the `mercatoModule` marker, or peer-dependency rules | Apps install these packages; keep existing import paths resolving. `mercatoModule.formatVersion` changes only with a consumer-side plan |
| Dedicated repository contents | `src/publish.ts`, `src/workflow.ts` | Changing owned paths, the `Release <package>@<version>` commit subject, or the `Mercato-Source:` trailer | Old repositories must stay publishable; new checks treat missing markers as "unknown", not as an error |
| Generated workflow | `src/workflow.ts` | Changing triggers, required secrets, or the trusted-publishing contract | Existing repositories keep their workflow; document what users must update |
| Catalog metadata | `src/package.ts` keywords, `src/publish.ts` repository topics | Removing or renaming the `open-mercato` or `open-mercato-module` keyword or topic | Open Mercato Modules and npm search find modules by them; add new keywords next to them |
| `describe` output | `src/describe.ts` | Renaming or removing a field, or printing YAML the catalog's descriptor schema rejects | The catalog takes this YAML as a descriptor; `test/describe.test.cjs` checks it against a copy of `descriptor-1.json` |
| Runtime requirement | `package.json` `engines` | Raising the minimum Node version | Release notes and a version bump |

`dist/` module exports are not a supported programmatic API; only the CLI is.
