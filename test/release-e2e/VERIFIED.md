# Verified release scenarios

## Local release checks: passed (2026-10-25)

`npm run test:release:local` ran once against the throwaway Verdaccio registry and Postgres from [the harness instructions](README.md), with `--create-app create-mercato-app@0.9.0` and `--database-url`, after the fixture got a description (`init --description`) and a license (`publish --license MIT`).

| Input | Version |
| --- | --- |
| Node | 24.21.0 |
| npm | 12.1.0 |
| Yarn in the fresh apps | 4.18.1 (`packageManager` pinned by the harness) |
| Clean app scaffold | `create-mercato-app@0.9.0`, `@open-mercato/core` 0.9.0 |
| Tool | create-mercato-module 0.5.1 with the unreleased description and license changes |

All 20 local stages and all 37 consumer stages passed:

- Releases 0.0.1 and 0.0.2 printed no warning, so the harness's no-warning assertion holds with the description and no-license warnings in place. The summaries showed `⚖️ License:    MIT`.
- The run without approval published nothing; the npm-linked checkout released 0.0.3 with the repository's MIT license.
- The npm lane installed `@mercato-e2e/release-checks@0.0.3` with `--preapprove-package` after the age gate refused it; the package carried its `LICENSE`. The GitHub lane installed `mercato-e2e/release-checks@0.0.3` from the local Git stand-in with github.com blocked for Yarn.
- Both consumer apps served the module page and API through Next.js, and the full app initialized against the database and answered the signed-in admin (`GET /api/release_checks/status 200`).

Recorded on 2026-10-09 against the current tool implementation. This records actual executions; it does not imply unexecuted release lanes passed.

| Input | Version |
| --- | --- |
| Node | 24.21.0 |
| Yarn | 4.17.1 |
| Clean app scaffold | `create-mercato-app@0.8.1-develop.7297.1.67605e74f9`, empty preset |
| Module fixture | Private dedicated GitHub repository, package version `0.1.1` |
| Fixture origin | Published from a module linked into the original development app |

## Private GitHub installation: passed

Executed the `github` lane with a fresh scaffold and complete real dependency installation. The harness resolved the published fixture ref to an immutable full commit before installing through Yarn's GitHub locator.

Verified:

- A new module initializes in an app with its own Git repository and generates successfully.
- An existing local module builds and packs through `publish --dry-run`, retaining its app source.
- The private GitHub package installs through real Yarn; Mercato enables it with `--allow-third-party`.
- Generators discover its backend page, API route, and entity.
- The compiled React hook page renders using the consumer app's React instance.
- The compiled API handler executes; the entity imports with decorator metadata for `updatedAt` preserved.
- Translation JSON, runtime assets, source, compiled files, and migration snapshot survive packaging.
- Source aliases retained in the dedicated development repository become portable relative imports in the exported package.
- The consumer app's actual Next.js serves the installed page and API over HTTP, both returning status 200.
- The application Git remote remains unchanged.

The complete command logs and stage report were retained locally in `/tmp/mercato-module-release-github-v011-node24-r2-20261009/`. Private test repositories and credentials are not required by the reusable scripts; use fixture inputs you control.

## npm registry installation: blocked by account capability

The account successfully authenticated and approved the private fixture publication, but npm rejected it with `E402: You must sign up for private packages`. The account used for this run cannot publish private npm packages without an eligible plan. No private fixture version became available in the registry, so the real npm installation lane could not start.

The npm lane remains unverified. Complete it with an npm scope that permits private publication, or with explicit approval to publish the synthetic fixture publicly. The harness still requires the exact registry version before creating its fresh app without Git; it does not substitute a local archive for this check.

## Scope of HTTP verification

The HTTP test uses an isolated Next smoke directory importing the installed module's page and API. It verifies package bundling and execution. It does not run the full host app's protected routes, authenticate a browser, apply database migrations, or establish browser hot reload behavior.

See [the harness instructions](README.md) for repeatable commands and prerequisites. A green unit-test run alone does not replace these release installation checks.
