# Verified release scenarios

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

## npm registry installation: pending

Private npm fixture publication requires the account's interactive publishing approval. Registry installation is not recorded as passed until the exact version is available and the `npm` lane completes with real downloads into a fresh app without Git.

## Scope of HTTP verification

The HTTP test uses an isolated Next smoke directory importing the installed module's page and API. It verifies package bundling and execution. It does not run the full host app's protected routes, authenticate a browser, apply database migrations, or establish browser hot reload behavior.

See [the harness instructions](README.md) for repeatable commands and prerequisites. A green unit-test run alone does not replace these release installation checks.
