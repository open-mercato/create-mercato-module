# Real release installation checks

These checks install actual registry and GitHub packages into two **fresh `create-mercato-app` apps**. They do not replace Yarn, framework packages, or the generated module with stubs. They never publish packages, create GitHub repositories, initialize a database, or modify a working application.

Run these checks before releasing the tool. Ordinary unit tests are fast and remain separate.

## Prerequisites

- Node 24 or newer; Yarn 4 matching the scaffolded app; npm; Git; authenticated GitHub CLI for a private fixture repository.
- A published fixture package and corresponding Git commit/tag. Use the fixture source below so assertions cover real behavior.
- For private npm packages, set `NPM_TOKEN` or `NODE_AUTH_TOKEN`, or log in with `npm login`. The harness reads the registry token from the active npm user config in memory when no token environment variable exists. It never prints or writes the token. Generated app Yarn config contains an environment placeholder and is restored afterward.
- Available disk space for two complete apps and the Yarn package cache (approximately 8 GB). Dependencies are installed independently into each app.

Run from this tool repository after `npm install` and `npm run build`:

```bash
node test/release-e2e/run.mts \
  --package @your-scope/mercato-module-release-checks \
  --version 0.0.1 \
  --repo your-org/mercato-module-release-checks \
  --ref v0.0.1 \
  --results /tmp/mercato-module-release-0.0.1
```

Use a new results directory for every run. Apps and sanitized command logs remain there, including after a failure. `results.json` lists every command, outcome, and duration. No credential value is included in results.

The default scaffold is `create-mercato-app@develop`, the same release channel used by the sandbox. Pin it for repeatable release evidence:

```bash
node test/release-e2e/run.mts \
  --package @your-scope/mercato-module-release-checks \
  --version 0.0.1 \
  --repo your-org/mercato-module-release-checks \
  --ref <commit-sha> \
  --create-app create-mercato-app@<exact-version> \
  --lanes npm
```

`--lanes npm,github` is the default. `--lanes github` tests GitHub alone. GitHub refs are resolved to a full immutable commit SHA before Yarn installation; Yarn does not accept abbreviated commit hashes directly. `--reuse-app /absolute/path` accepts an already scaffolded, clean app for one lane; its module directories must not contain harness modules. This is useful for investigating a failed scaffold or install without changing framework dependencies. The harness does not delete or overwrite existing application directories.

For a different Node or Yarn executable, set `RELEASE_E2E_NODE`, `RELEASE_E2E_YARN`, or `RELEASE_E2E_NPX` to an executable path. To run all spawned commands on Node 24, start the harness with Node 24 and put the same Node installation first on `PATH`.

## What the two lanes verify

| Check | npm lane | GitHub lane |
| --- | --- | --- |
| Fresh empty app from real `create-mercato-app` | Yes | Yes |
| Actual complete Yarn install | Yes | Yes |
| App starts without/with its own Git | Without Git | Own local Git |
| New local module initialized and generated | Yes | Yes |
| Existing local module packed with `--dry-run` | Yes | Yes |
| Remote module installation | `mercato module add name@version --allow-third-party` | `yarn add name@github:owner/repo#ref`, then `mercato module enable name --allow-third-party` |
| Page/API/entity auto-discovery and generation | Yes | Yes |
| Compiled React page renders using app React | Yes | Yes |
| Compiled API handler executes | Yes | Yes |
| Entity imports, decorator `design:type` metadata | Yes | Yes |
| Actual Next HTTP render and module API response | Yes | Yes |
| Localized JSON and runtime asset available | Yes | Yes |
| Source, compiled code, migration snapshot present | Yes | Yes |
| Local source remains; app remote unchanged | Yes | Yes |

Newly published fixture packages are allowlisted by exact package name against the scaffold's npm package age gate. This does not disable the age gate for other packages.

These tests run generators, execute the installed module's runtime entry points, and start the consumer app's actual Next.js in an isolated smoke directory that imports the installed page and API. They check HTML and JSON over HTTP. They do **not** authenticate a browser, start the full host app's protected routes, or apply database migrations. A green result verifies package installation/discovery/runtime portability and Next bundling, not a database-backed CRUD flow or browser HMR.

## Preparing a fixture for the next release

Fixture publication is deliberately separate from installation checks. Use a private npm package and private GitHub repository when testing publishing credentials; do not create public throwaway repositories.

```bash
npx create-mercato-app@develop /tmp/mercato-fixture-source \
  --preset empty --agents none --no-init-git
cd /tmp/mercato-fixture-source
yarn install

# From this tool checkout:
node test/release-e2e/fixture.mts /tmp/mercato-fixture-source
```

The writer creates `src/modules/release_checks` and refuses to overwrite an existing directory. It includes a React hook page, authenticated API handler, relative import, MikroORM entity, translations, runtime asset, and migration snapshot. It does not register or migrate the entity. The publishing tool exports the existing module directly.

Publish that module using the version of this tool under review, with an npm scope where you have private publication access. Save the exact package version and matching Git commit. Pass those values to `run.mts`. Consumer apps should use the same pinned framework version as the source app because generated packages intentionally use exact framework peers.

If the registry is still processing a new publication, wait until `npm view <package>@<version> version` returns that exact version. Do not overwrite or republish the same immutable version.

For a private GitHub fixture, configure Git's GitHub credential helper through `gh auth setup-git` before running. The harness checks `gh auth status` and leaves your global Git configuration unchanged.
