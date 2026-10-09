# Changelog

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
- `MERCATO_NPM_REGISTRY` points publication at a test registry and accepts only addresses on this machine.
- Captured commands have a timeout; stale exports under `.mercato/module-publish/` are removed.

### Development

- CI runs lint, typecheck, and build, and a secret-free job that publishes a fixture to a throwaway registry and local Git repositories, then installs it into fresh apps. See `test/release-e2e/README.md`.
