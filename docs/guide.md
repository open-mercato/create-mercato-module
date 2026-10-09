# Usage and development guide

[Back to the README](../README.md)

- [Command reference](#command-reference)
- [Authentication](#authentication)
- [npm Trusted Publishing](#npm-trusted-publishing)
- [Package contents and portability](#what-ships-in-the-package)
- [Generated-import errors](#an-error-mentions-mercatogenerated)
- [Git and release behavior](#how-git-and-releases-work)
- [Development in a dedicated repository](#develop-in-the-dedicated-repository-without-leaving-your-app)
- [Try the GitHub version](#try-the-github-version)
- [Contributing and verification](#development)

## Develop in the dedicated repository without leaving your app


After publishing to a dedicated repository, run this **inside the same app**:

```bash
npx create-mercato-module link visits
```

No saved settings yet? Specify the module's existing package and repository:

```bash
npx create-mercato-module link visits \
  --package @your-name/mercato-visits \
  --repo your-name/mercato-visits
```

The tool clones that repository, verifies its package/module ownership, backs up the original module, and creates a relative source link:

```text
my-app/
├── src/modules/visits -> ../../.mercato/module-repos/visits/src/modules/visits
├── src/modules.ts                     still uses @app
├── node_modules/
└── .mercato/
    ├── module-tool.json               remembered settings and link ownership
    ├── module-backups/visits-…/        original local source, preserved
    └── module-repos/visits/            independent Git checkout
        ├── .git/
        ├── node_modules -> ../../../node_modules
        └── src/modules/visits/        linked TypeScript source
```

Continue editing `src/modules/visits` and running your existing app. Those edits now change the module repository's real TypeScript files. The module stays `@app`; you do not install a second copy of it or switch the app to compiled package imports. Shared `node_modules` keeps React and framework dependencies consistent. `link` runs `yarn generate`; use `--no-generate` if you will run it yourself.

Use normal Git commands for module development:

```bash
git -C .mercato/module-repos/visits status
git -C .mercato/module-repos/visits switch -c feat/visit-notes
# Edit and test src/modules/visits in this app.
git -C .mercato/module-repos/visits add src
git -C .mercato/module-repos/visits commit -m "Add visit notes"
git -C .mercato/module-repos/visits push -u origin feat/visit-notes
gh pr create --repo your-name/mercato-visits --head feat/visit-notes --base main
```

After your feature branch is reviewed and merged, switch the module checkout back to the release branch, pull it, and publish the next version from the app:

```bash
git -C .mercato/module-repos/visits switch main
git -C .mercato/module-repos/visits pull --ff-only
npx create-mercato-module publish visits
```

Linked publication uses the owned checkout and preserves repository documentation and workflow files. It preserves author source and tests, refreshes generated build output and release metadata, then makes a normal Git commit and push before submitting npm publication. Check your checkout's active branch before releasing; the tool does not force-push or change branches for you.

**This is local development setup.** The app's Git sees its former module directory replaced by a symlink. `.mercato/` stays ignored, so committing that symlink does not copy the independent repository or its metadata into the app. A fresh clone of the whole app will need its module source/link restored on that machine. Do not assume that checking in the symlink alone makes the app portable. The original source is retained under the printed backup path; no app commits or remotes are changed automatically.

For a simpler whole-app Git workflow, skip `link`: keep the real module directory in the app and continue exporting releases. Do not independently edit its exported repository as a second source of truth.


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
| `--tag beta` | npm channel; defaults to `latest` for stable and `next` for prerelease |
| `--repo owner/repository` | Also export to a dedicated GitHub repository |
| `--repo -` | Clear a saved GitHub repository; publish only to npm |
| `--access public` | Public npm package and public new GitHub repository; default |
| `--access restricted` | Private npm package and private new GitHub repository |
| `--auth auto\|login\|token\|trusted` | Choose npm authentication; defaults to `auto` |
| `--configure` | Reopen the wizard to edit remembered settings |
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

### `link <module_id>`

Connects the current app's local module source to its dedicated repository, with an original-source backup. Requires GitHub authentication and an existing matching repository created by this tool. Repeating the command with matching saved ownership metadata is safe; arbitrary module symlinks and existing checkout directories are rejected.

| Option | Behavior |
|---|---|
| `--package @your-name/mercato-visits` | Package identity if it is not already saved |
| `--repo owner/repository` | Dedicated repository if it is not already saved |
| `--no-generate` | Link the source without running `yarn generate` |

## Authentication

Publication checks npm authentication before building the archive and checks GitHub authentication before work requiring a repository. `link` checks GitHub first. `init`, `--help`, and `publish --dry-run` do not require registry or GitHub authentication.

| Mode | Credentials |
|---|---|
| `--auth auto` | Uses an environment token when present, GitHub Actions OIDC when available, otherwise the npm login session |
| `--auth login` | Uses your existing `npm login` session |
| `--auth token` | Reads `NPM_TOKEN` or `NODE_AUTH_TOKEN`; fails early if neither is set |
| `--auth trusted` | Requires GitHub Actions OIDC and a configured npm trusted publisher |

For token publishing, inject the token from your secret manager or CI secrets into the environment:

```bash
# NPM_TOKEN or NODE_AUTH_TOKEN is already set securely in this shell.
npx create-mercato-module publish visits --auth token
```

Never put the token in a CLI argument, module source, committed config, or README. The tool uses an isolated temporary npm configuration containing an environment placeholder, removes it afterward, and saves no credential in module metadata. The token must allow writing the intended npm package; any required npm verification still applies.

GitHub uses the separate `gh auth login` session. For private packages, use a scoped name such as `@your-name/mercato-visits` and `--access restricted`; your npm account must have the relevant private package permissions.

### npm Trusted Publishing

New module repositories include `.github/workflows/publish.yml`. It uses GitHub-hosted Ubuntu, Node 24, `id-token: write`, a build, and direct `npm publish`; no npm write token is needed. It runs manually or for a `v*` tag matching `package.json`'s version.

After the initial package exists, configure its **Trusted Publisher** in npm package settings:

| npm setting | Value for `your-name/mercato-visits` |
|---|---|
| Provider | GitHub Actions |
| Organization or user | `your-name` |
| Repository | `mercato-visits` |
| Workflow filename | `publish.yml` — only the filename |
| Environment | Leave empty unless you add an environment to the workflow |
| Allowed actions | Enable direct `npm publish` for this workflow |

Trusted Publishing requires npm 11.5.1 or newer. For private dependencies, add a read-only GitHub secret named `NPM_READ_TOKEN`; the generated workflow uses it during installation only. See [npm's Trusted Publishing documentation](https://docs.npmjs.com/trusted-publishers/) for provider configuration.

Choose one publisher for each version: local `publish visits` or the repository workflow. A version already submitted by one cannot be published again by the other. For workflow releases, bump the repository's package version, commit/push it, then run the workflow or push its matching tag. `--auth trusted` selects OIDC for this tool inside a suitably configured Actions job; it does not configure npm settings or log in a local terminal.

## What ships in the package

| Included | Excluded |
|---|---|
| Selected module's TypeScript sources | Other modules and app configuration |
| Individually compiled ESM files | App Git history and `.env` files |
| Portable TypeScript under `types/` for consumer type resolution | App-only alias dependencies in the public type surface |
| Translations and runtime assets | `node_modules`, tests, and mock directories |
| Migrations and schema snapshots | Symlinks and credential files |
| Package metadata and rebuild script | Authentication tokens |

The package includes `src/modules/<id>`, `dist/modules/<id>`, and portable `types/modules/<id>` for discovery, ejection, runtime imports, and consumer type resolution. Compilation preserves client directives, React's automatic JSX runtime, and legacy decorator metadata. In linked development, publication keeps the repository's author source and tests intact; the build rewrites own-module aliases in generated output and portable type sources.

Imported dependencies are recorded from installed versions. Framework packages, React, Next.js, and MikroORM become exact-version peers to match the source app. Other imported packages become runtime dependencies.

The initial module license follows the app's `package.json` `license` field, or defaults to `UNLICENSED`. Linked releases preserve the module repository's own license. Choose the appropriate license before publishing. The tool itself is MIT licensed.

### Keep your module portable

Imports within the selected module, including `@/modules/visits/...`, become portable relative imports. Publication stops with an actionable error for app-only aliases, imports of another local module, local/Git dependency locators, CommonJS `require()` / `import = require`, symlinks, and recognizable embedded credentials.

Move shared application code into the module or publish it as a separate dependency. Run your app's typecheck and feature tests before publishing: the package build checks transpilation, not semantic types or business behavior.

### An error mentions `.mercato/generated`

For example:

```text
src/modules/patients/api/addresses/route.ts
imports @/.mercato/generated/entities/patient_address
```

The file to fix is **your module's `api/addresses/route.ts`**, not the generated file. Generated registries belong to this particular app; another app may generate a different set. Those entity helper files can contain field-name constants and entity identifiers, so importing one does not necessarily mean you imported an entity class.

For field helpers, put the needed typed field-name literals in module-owned code and import them locally:

```ts
// src/modules/patients/lib/addressFields.ts
export const id = 'id' as const
export const organization_id = 'organization_id' as const
```

For an entity identifier, use the owning module's stable `module:entity` ID, or a supported API exported by its package. If you need an actual entity class, import its module-owned source or the owning package's public export. **Do not move, edit, or publish `.mercato/generated`.**

### How Git and releases work

Without `link`, the application module remains the source of truth. The tool does not commit, push, or change the app's Git origin. GitHub export uses an isolated checkout under `.mercato/module-publish/`, then pushes a normal commit without forcing history. Existing repositories must be empty or contain the matching package and this tool's ownership marker. With `link`, the independent checkout becomes the module source; the app's symlink keeps development inside the same app.

GitHub is updated before npm publication. If npm fails after the push, that Git commit may already exist; fix the reported login or version issue and retry. Published npm versions cannot be overwritten.

Keep `.mercato/` ignored by Git; Open Mercato sandboxes already exclude it. `.mercato/module-tool.json` stores per-module publishing settings, last successful versions, and owned development-link paths. It contains no tokens. Authentication stays in the environment or the npm/GitHub CLI session. The original `mercato-modules.json` file remains a compatible settings input.

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
npm run typecheck
npm test
npm pack --dry-run
```

The implementation is strict TypeScript under `src/`, compiled to `dist/`; the small CommonJS bin only starts the compiled CLI. Tests cover scaffolding, portable imports, JSX/decorator metadata, authentication modes, saved settings, real npm archives, isolated Git publication, and source-link ownership/rollback. Unit tests simulate remote publication calls and use real temporary local Git repositories.

With a built Open Mercato checkout, also verify archive installation, standalone CLI activation, page/translation discovery, ejection, source-linked generation, and a running Next development server that sees source edits without a rebuild:

```bash
OPEN_MERCATO_ROOT=/path/to/open-mercato npm test
```

For release verification against **fresh, fully installed `create-mercato-app` applications**, use the repeatable [release end-to-end scripts](https://github.com/open-mercato/create-mercato-module/blob/main/test/release-e2e/README.md). They install a real module from both npm and GitHub, verify discovery and runtime behavior, and save sanitized results. Fixture publication is a separate explicit step; the harness does not create remote repositories or publish packages. Private fixture packages/repositories are supported.

The Next source-link test verifies HTTP rendering and edits in a running dev server. It does not claim a database-backed CRUD flow or browser-level Fast Refresh coverage. Trusted Publishing requires the real npm publisher configuration and an Actions runner; local OIDC simulation is not evidence of a successful registry publication.

Contributions are welcome. Keep changes focused, add tests for changed behavior, and include validation results in your pull request.

