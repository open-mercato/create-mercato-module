# Changelog

## Unreleased

- GitHub installs accept npm-style version selectors such as `owner/repo@1.2.3` and `owner/repo@1.2.3-beta.1`. An existing exact ref wins; when it is missing, installation tries the conventional `v`-prefixed release tag and pins the resolved commit. Explicit `#ref` and `--ref` selectors keep exact-ref behavior.

## 0.4.0

### Linking and packaging

- Link a module from a GitHub repository or npm package without looking up its module ID or npm name first; custom local checkout names are supported.
- Install and enable a module from the same npm and GitHub locators, delegating registration, optional ejection, module selection, and generation to Open Mercato's CLI.
- `install` reads the `requires` list from the installed module's metadata and warns when a required module is not enabled in `src/modules.ts`. A failed GitHub install now says that the package was added but not enabled.
- Keep the legacy `link <module_id>` form for existing local modules and saved links. Ambiguous bare repository names must be written as `owner/repository`.
- Store custom checkouts in development-link metadata format 2 while continuing to read the original fixed-path format 1.
- Translate supported server-side host module-presence checks to the consuming app's runtime module registry.

### Safety and verification

- `link` checks GitHub before changing anything and prints the `publish` command when the module is not in its repository yet.
- `MERCATO_NPM_REGISTRY` points publication at a test registry and accepts only addresses on this machine.
- CI runs lint, typecheck, build, the full framework integration suite, and a secret-free local release rehearsal that creates, publishes, links, installs, and starts a module against throwaway services.

## 0.3.0

### Breaking

- Publishing asks you to retype the package name; `y` no longer approves it.
- A noninteractive `publish` without `--yes` exits with an error instead of reporting a cancellation as success.
- Warnings need their own approval and are never covered by `--yes`: `--allow-public-repo`, `--overwrite-repo`, `--allow-branch`, `--allow-install-scripts`.
- The first export to an existing dedicated repository after upgrading shows the `--overwrite-repo` warning once, until a release commit carries the `Mercato-Source:` trailer.

### Safety

- Warn before pushing a restricted package's source to a public GitHub repository.
- Warn before an app export replaces repository commits it did not release, and stop when the repository changes after approval.
- Warn before releasing a linked module from a non-default branch or with install lifecycle scripts; reject local/Git dependency locators in its `package.json`.
- Restore the local module when `link` cannot save its metadata, and keep the shared `node_modules` symlink out of the module repository.
- Keep npm commands on the npm registry for scoped packages.
- Detect more credential formats and files; allow `.env.example`.
- Generated workflow: actions pinned to commits, manual runs limited to the default branch, and without a lockfile only the pinned compiler is installed.
- Captured commands have a timeout; stale exports under `.mercato/module-publish/` are removed.
