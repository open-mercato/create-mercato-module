<p align="center"><img src="https://raw.githubusercontent.com/open-mercato/create-mercato-module/main/.github/readme/open-mercato.svg" alt="Open Mercato logo" width="72" /></p>

<h1 align="center">Create Mercato Module</h1>

<p align="center"><strong>Build in your app. Publish one module.</strong></p>

<p align="center">Turn a custom Open Mercato module into an npm package and a dedicated GitHub repository.<br />Two commands. From your terminal or an Open Mercato Cloud sandbox.</p>

<p align="center">
  <a href="https://www.npmjs.com/package/create-mercato-module"><img src="https://img.shields.io/npm/v/create-mercato-module?color=b4f372&amp;label=npm" alt="npm version" /></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/node-%E2%89%A524-1b1b1b" alt="Node.js 24 or newer" /></a>
  <a href="https://github.com/open-mercato/create-mercato-module/actions/workflows/test.yml"><img src="https://github.com/open-mercato/create-mercato-module/actions/workflows/test.yml/badge.svg" alt="Tests" /></a>
  <a href="https://github.com/open-mercato/create-mercato-module/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-bc9aff" alt="MIT license" /></a>
</p>

```bash
npx create-mercato-module init visits
# Build your feature in src/modules/visits.
npx create-mercato-module publish visits
```

Your application is the development workspace. This tool creates a portable package from **one selected module**, including its sources, compiled code, translations, and migrations. Publish it to npm, optionally give it a dedicated GitHub repository, and install it in another Open Mercato app.

**Already built the module?** Skip `init` and go straight to [`publish`](#publish-an-existing-module).

<p align="center"><a href="#quick-start">Quick start</a> · <a href="#publish-an-existing-module">Existing modules</a> · <a href="#in-an-open-mercato-cloud-sandbox">Cloud sandboxes</a> · <a href="#preview-before-you-publish">Dry run</a> · <a href="#command-reference">Commands</a> · <a href="https://docs.openmercato.com/">Docs</a> · <a href="https://discord.gg/f4qwPtJ3qA">Discord</a></p>

<p align="center"><img src="https://raw.githubusercontent.com/open-mercato/create-mercato-module/main/.github/readme/module-flow.svg" alt="Develop visits in your Open Mercato app, package only that module, then publish to npm and an optional dedicated GitHub repository." width="100%" /></p>

## Why this exists

An app created with [`create-mercato-app`](https://github.com/open-mercato/open-mercato) is a complete application. Its Git repository may contain the app, configuration, and several custom modules. You should still be able to share just one of those modules.

| You have | You run | You get |
|---|---|---|
| An app and a new idea | `init visits`, then `publish visits` | A registered starter module, then a reusable package |
| A module you already built | `publish visits` | That module as an npm package |
| The whole app in GitHub | `publish visits` with a dedicated repo | A separate module repository; the app keeps its origin |
| An app without Git | The same `publish visits` | A package and, optionally, a new GitHub repository |

## Quick start

Start **inside an installed Open Mercato app**. You need Node.js 24 or newer, npm, and the app's working `yarn generate` command. On Windows, use WSL2 as recommended by the [Open Mercato installation guides](https://docs.openmercato.com/installation).

The tool checks your current directory and its parents for the app's `src/modules.ts`, declared `@open-mercato/core` dependency, and installed framework package. You can run it from a subdirectory. Outside an app it stops before changing files and shows where to run the command; if dependencies are missing, it asks you to run `yarn install` first. `--help` works everywhere.

### 1. Create your module

```bash
cd my-mercato-app
npx create-mercato-module init visits
```

The command creates this starter, adds `{ id: 'visits', from: '@app' }` to `src/modules.ts`, and runs `yarn generate`:

```text
src/modules/visits/
├── index.ts
├── backend/visits/
│   ├── page.tsx
│   └── page.meta.ts
└── i18n/
    ├── en.json
    └── pl.json
```

Open `/backend/visits` in your running app. You have an authenticated page with English and Polish translations. Build your feature in `src/modules/visits`; follow the app's own `AGENTS.md` and module conventions when adding entities, APIs, permissions, or UI.

**Done when:** the page opens and your feature works in the source app. The starter contains no database entities; creating it does not apply migrations.

### 2. Publish your module

Authenticate once before your first publication:

```bash
npm login
gh auth login # only if you want a GitHub repository
```

Then:

```bash
npx create-mercato-module publish visits
```

The wizard asks for:

| Setting | Example |
|---|---|
| npm package | `@your-name/mercato-visits` |
| Version | `0.1.0` |
| Dedicated GitHub repository, optional | `your-name/mercato-visits` |
| Access | `public` or `restricted` |

It builds a `.tgz`, displays the package, destinations, archive path, and integrity, then asks you to confirm publication. Use your own npm scope and a new or empty repository. The tool creates the GitHub repository when needed.

**Done when:** npm lists your package and, if selected, the dedicated repository contains the module snapshot. Settings are saved per module in `mercato-modules.json`; the next successful stable release defaults to the next patch version.

### 3. Reuse it in another app

```bash
yarn mercato module add @your-name/mercato-visits --allow-third-party
```

`--allow-third-party` is the explicit opt-in for packages outside `@open-mercato/*`. The receiving app needs a Mercato CLI version that supports this flag.

## Publish an existing module

If `src/modules/visits/index.ts` already exists, no scaffolding or source move is needed:

```bash
npx create-mercato-module publish visits \
  --package @your-name/mercato-visits \
  --repo your-name/mercato-visits
```

Keep developing in the source app. Run the same command for the next release; it updates the dedicated repository with a normal commit and publishes a new npm version.

## In an Open Mercato Cloud sandbox

Open the sandbox's terminal and run the same two commands from `/workspace`:

```bash
npx create-mercato-module init visits
npx create-mercato-module publish visits
```

The sandbox is already a `create-mercato-app` application. Its Git repository can keep the entire app while your module gets its own repository. No image rebuild, helper installation, or sandbox configuration change is required.

## Preview before you publish

```bash
npx create-mercato-module publish visits \
  --package @your-name/mercato-visits \
  --repo your-name/mercato-visits \
  --dry-run
```

This builds a real npm archive under `.mercato/module-publish/` and prints its exact path and integrity. It needs no npm/GitHub login and makes no publication calls.

Inspect the archive:

```bash
tar -tzf /absolute/path/to/your-name-mercato-visits-0.1.0.tgz
```

Or install it in a second app before publishing:

```bash
yarn mercato module add @your-name/mercato-visits@file:/absolute/path/to/module.tgz --allow-third-party
```

## Command reference

### `init <module_id>`

Creates a translated starter page, registers the module, and runs generation. Module IDs use `snake_case`, such as `visits` or `service_visits`. Existing module directories and duplicate registrations are rejected.

| Option | Behavior |
|---|---|
| `--no-generate` | Create and register the module; run generation yourself |

### `publish <module_id>`

Packages one local module and publishes it after confirmation.

| Option | Behavior |
|---|---|
| `--package @your-name/mercato-visits` | Set the npm package name |
| `--version 0.1.0` | Set a new npm version |
| `--repo owner/repository` | Also export to a dedicated GitHub repository |
| `--repo -` | Clear a saved GitHub repository; publish only to npm |
| `--access public` | Public npm package and public new GitHub repository; default |
| `--access restricted` | Private npm package and private new GitHub repository |
| `--dry-run` | Build the archive without publishing or saving settings |
| `--yes` | Publish the displayed package without an interactive prompt |

For scripts or CI, supply the settings and explicit approval:

```bash
npx create-mercato-module publish visits \
  --package @your-name/mercato-visits \
  --repo your-name/mercato-visits \
  --version 0.1.1 \
  --yes
```

Without `--yes`, a noninteractive invocation builds the archive and cancels publication. Private npm packages require the corresponding npm permissions. Repository visibility flags apply when creating a new repository; existing repository visibility is preserved.

## What ships in the package

| Included | Excluded |
|---|---|
| Selected module's TypeScript sources | Other modules and app configuration |
| Individually compiled ESM files | App Git history and `.env` files |
| Translations and runtime assets | `node_modules`, tests, and mock directories |
| Migrations and schema snapshots | Symlinks and credential files |
| Package metadata and rebuild script | Authentication tokens |

The package includes both `src/modules/<id>` and `dist/modules/<id>` for Mercato's discovery and ejection workflows. Compilation preserves client directives, React's automatic JSX runtime, and legacy decorator metadata.

Imported dependencies are recorded from installed versions. Framework packages, React, Next.js, and MikroORM become exact-version peers to match the source app. Other imported packages become runtime dependencies.

The module's license follows the app's `package.json` `license` field, or defaults to `UNLICENSED`. Choose the appropriate license before publishing. The tool itself is MIT licensed.

### Keep your module portable

Imports within the selected module, including `@/modules/visits/...`, become portable relative imports. Publication stops with an actionable error for app-only aliases, imports of another local module, local/Git dependency locators, CommonJS `require()` / `import = require`, symlinks, and recognizable embedded credentials.

Move shared code into the module or publish it as a separate dependency. Run your app's typecheck and feature tests before publishing: the package build checks transpilation, not semantic types or business behavior.

### How Git and releases work

The application remains the source of truth. The tool does not commit, push, or change its Git origin. GitHub export uses an isolated checkout under `.mercato/module-publish/`, then pushes a normal commit without forcing history. Existing repositories must be empty or contain the matching package and this tool's ownership marker.

Later releases replace the generated module snapshot in the dedicated repository, so make feature changes in the source app. GitHub is updated before npm publication. If npm fails, fix the reported login or version issue and retry; published npm versions cannot be overwritten.

Keep `.mercato/` ignored by Git; Open Mercato sandboxes already exclude it. `mercato-modules.json` contains package settings and may be committed with the app. Authentication stays in npm and GitHub CLI configuration.

## Try the GitHub version

Run directly from this repository inside your app:

```bash
npx --package github:open-mercato/create-mercato-module create-mercato-module init visits
npx --package github:open-mercato/create-mercato-module create-mercato-module publish visits --package @your-name/mercato-visits --dry-run
```

## Development

```bash
git clone https://github.com/open-mercato/create-mercato-module.git
cd create-mercato-module
npm ci
npm test
npm pack --dry-run
```

Tests cover scaffolding, portable imports, JSX and decorator metadata, real npm archives, and isolated Git publication. Remote publishing calls are simulated; Git operations use temporary local repositories.

With a built Open Mercato checkout, also verify real archive installation, standalone CLI activation, page/translation discovery, and ejection:

```bash
OPEN_MERCATO_ROOT=/path/to/open-mercato npm test
```

Contributions are welcome. Keep changes focused, add tests for changed behavior, and include validation results in your pull request.

## Part of Open Mercato

[Open Mercato](https://github.com/open-mercato/open-mercato) is the AI-engineering foundation for business applications: ready business modules plus the architecture and agent guidance to build your own.

[Website](https://openmercato.com/) · [Documentation](https://docs.openmercato.com/) · [Open Mercato Cloud](https://openmercatocloud.com/) · [Skills](https://github.com/open-mercato/skills) · [Discord](https://discord.gg/f4qwPtJ3qA)

MIT © Open Mercato contributors. See [LICENSE](https://github.com/open-mercato/create-mercato-module/blob/main/LICENSE).
