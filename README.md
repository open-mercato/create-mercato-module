# create-mercato-module

Create and publish a single custom module from an existing **create-mercato-app** application. Works inside Open Mercato sandboxes and on your own computer. No sandbox image changes or Open Mercato modifications are required.

Requires Node.js 24+, npm, and an installed Open Mercato app. Run commands from the application directory or one of its subdirectories.

## Two commands

```sh
npx create-mercato-module init visits
# Build your feature in src/modules/visits.
npx create-mercato-module publish visits
```

`init` creates a module, registers it in `src/modules.ts`, and runs `yarn generate`. Open `/backend/visits` to see its translated starter page. Use `--no-generate` to run generation yourself. The starter contains no database entities; add your feature using the app's module development conventions.

`publish` asks for an npm package name, version, and optional dedicated GitHub repository. It builds a `.tgz`, displays exactly what will be published, then asks for confirmation. Publication settings are remembered per module in `mercato-modules.json`. The next successful stable release defaults to an incremented patch version.

Already have a module? Run `publish` directly. The application can be in Git, have a remote containing the entire app, or have no Git repository at all.

Before publishing, authenticate once:

```sh
npm login
gh auth login # only when exporting to a GitHub repository
```

Use your own npm scope and a new or empty dedicated GitHub repository. The tool can create that repository. Public npm access also creates a public repository; `--access restricted` creates a private repository and requires npm private-package permissions.

## Preview without publishing

```sh
npx create-mercato-module publish visits \
  --package @your-name/mercato-visits \
  --repo your-name/mercato-visits \
  --dry-run
```

No login or network publication is needed. The resulting archive is under `.mercato/module-publish/`; the command prints its exact path and integrity. Inspect it with `tar -tzf <archive.tgz>`.

## Publish with explicit settings

```sh
npx create-mercato-module publish visits \
  --package @your-name/mercato-visits \
  --repo your-name/mercato-visits \
  --version 0.1.0 \
  --yes
```

Omit `--repo` to publish only to npm. Use `--repo -` to clear a previously saved repository. Without `--yes`, interactive publication requires confirmation; a noninteractive invocation builds the archive and cancels publication.

Install the module in another app:

```sh
yarn mercato module add @your-name/mercato-visits --allow-third-party
```

For local testing, use the package name with a file locator:

```sh
yarn mercato module add @your-name/mercato-visits@file:/absolute/path/to/module.tgz --allow-third-party
```

## What is exported

Only `src/modules/<id>` is exported, with TypeScript sources and individually compiled ESM files, translations, migrations, snapshots, and other runtime assets. Client directives, React JSX runtime, and legacy decorator metadata are preserved. Tests and mock directories are excluded. Imported installed dependencies are recorded; framework packages, React, Next.js, and MikroORM are exact-version peers to match the source application. The license follows the application's `license` field, or defaults to `UNLICENSED`; set that field before publishing if you want to grant reuse rights.

Imports within the module are rewritten to portable relative paths. App-only aliases, imports of another local module, local/Git dependency locators, CommonJS `require()` / `import = require`, symlinks, credential files, and recognizable embedded tokens stop publication with an actionable error. Move shared code into the selected module or publish it separately. The build checks transpilation; run your application's typecheck and feature tests before publishing.

The source app remains the place where you develop. Publishing never commits, pushes, or changes its Git origin. GitHub publication uses an isolated checkout and pushes a normal commit. Later releases replace the generated module snapshot in that dedicated repository. Repositories containing a different package or lacking the tool's ownership marker are rejected. GitHub is updated before npm publication; if npm fails, correct the login/version problem and retry. Existing npm versions cannot be overwritten.

Keep `.mercato/` ignored by your app's Git configuration; create-mercato-app sandboxes already exclude it. `mercato-modules.json` contains package settings, never authentication tokens, and may be committed with your app.

## Run this checkout before npm publication

The short `npx create-mercato-module` commands become available after this tool is published to npm. Until then:

```sh
cd /path/to/create-mercato-module
npm ci
```

From inside your application:

```sh
npx --package /path/to/create-mercato-module create-mercato-module init visits
npx --package /path/to/create-mercato-module create-mercato-module publish visits
```

Run `npm test` in the tool checkout to verify scaffolding, portable builds, real npm archives, and isolated Git publication without publishing to external services.

With a built Open Mercato checkout available, run `OPEN_MERCATO_ROOT=/path/to/open-mercato npm test` to also install a generated archive in a temporary app and verify the real CLI's module activation, page/translation discovery, and source ejection.
