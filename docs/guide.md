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


Run inside an Open Mercato app, including a fresh app without the module:

```bash
npx create-mercato-module link pkarw/marketing-consents
npx create-mercato-module link https://github.com/pkarw/marketing-consents.git
npx create-mercato-module link @piotrkarwatka/marketing-consents
```

`link` reads the npm package name and module ID from the repository. The npm form first looks up the package's `repository` metadata on npm; no npm publication or login is required for a public package. Scoped package names use npm discovery; use `npm:package-name` for an unscoped npm package. A bare repository name uses your authenticated GitHub account unless an unsaved local module has the same name; that legacy form asks for the module's dedicated repository instead. Use `owner/repository` to remove the ambiguity. HTTPS, SSH, `github:owner/repo`, trailing slashes, and `.git` URLs are accepted. Even an accidentally repeated `https://github.com/` prefix is normalized.

To choose the checkout folder, add a local name:

```bash
npx create-mercato-module link pkarw/marketing-consents my-consents
```

This uses `.mercato/module-repos/my-consents` while keeping the repository's module ID (`marketing_consents`) and its routes and imports. Names may contain letters, numbers, hyphens and underscores.

A dedicated module repository must have a root `package.json` with `name` and `mercatoModule: { id, formatVersion: 1 }`, plus `src/modules/<id>/index.ts`. npm packages without a dedicated GitHub repository, monorepo packages, empty repositories, and unrelated projects produce actionable errors before app files change. GitHub authentication uses `gh auth login`.

The tool registers a new module automatically. A matching installed npm package registration switches to `@app`; conflicting or dynamic registrations require an explicit manual correction. Existing local module sources are backed up before linking; a fresh module needs no backup. The checkout shares the app's installed dependencies.

Saved settings keep the original command working. For an unsaved local module, the same command prompts for its repository in a terminal; scripts pass `--repo owner/repository`:

```bash
npx create-mercato-module link visits
# Or choose a repository explicitly, without supplying an npm name:
npx create-mercato-module link visits --repo owner/mercato-visits
```

For a local module that has no dedicated repository yet, run `publish visits --repo owner/mercato-visits` first. With the default checkout name, the resulting layout is:

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

Linked publication uses the owned checkout and preserves repository documentation and workflow files. It preserves author source and tests, refreshes generated build output and release metadata, then makes a normal Git commit and push before submitting npm publication, and tags the release once npm accepts it. Check your checkout's active branch before releasing; the tool does not force-push or change branches for you.

**This is local development setup.** The app's Git sees its former module directory replaced by a symlink. `.mercato/` stays ignored, so committing that symlink does not copy the independent repository or its metadata into the app. A fresh clone of the whole app will need its module source/link restored on that machine. Do not assume that checking in the symlink alone makes the app portable. The original source is retained under the printed backup path; no app commits or remotes are changed automatically.

For a simpler whole-app Git workflow, skip `link`: keep the real module directory in the app and continue exporting releases. Do not independently edit its exported repository as a second source of truth.


## Command reference

### `init <module_id>`

Creates a translated starter page, registers the module, and runs generation. Module IDs use `snake_case`, such as `visits` or `service_visits`. Existing module directories and duplicate registrations are rejected.

| Option | Behavior |
|---|---|
| `--no-generate` | Create and register the module; run generation yourself |

The starter is one page. After `yarn setup` has the app running, you will probably want to open the app in your coding agent and have it build the module further; the app's `AGENTS.md` gives the agent the framework conventions.

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
| `--allow-public-repo` | Approve pushing a restricted package's source to an existing public GitHub repository |
| `--overwrite-repo` | Approve replacing repository changes that this app did not release |
| `--allow-branch` | Approve releasing a linked module from a branch other than the repository default |
| `--allow-install-scripts` | Approve publishing `preinstall`, `install`, or `postinstall` scripts from a linked module repository |

Nothing is published without approval. In a terminal, the tool shows the destinations and every warning, then asks you to retype the package name; anything else cancels and exits with code 1. `y` is not accepted.

For scripts or CI, supply the settings and explicit approval:

```bash
npx create-mercato-module publish visits \
  --package @your-name/mercato-visits \
  --repo your-name/mercato-visits \
  --version 0.1.1 \
  --yes
```

Without `--yes`, a noninteractive invocation builds the archive, publishes nothing, and exits with an error. Each warning in the summary additionally needs its own option, named next to the warning; `--yes` alone never approves a warning. Private npm packages require the corresponding npm permissions. Repository visibility flags apply when creating a new repository; existing repository visibility is preserved.

### `install <repository-or-npm-package>`

Installs and enables a published module in the current Open Mercato app. npm
locators delegate to `yarn mercato module add`, so Open Mercato updates the app
dependency, edits `src/modules.ts` through its supported implementation, and
runs all generators. GitHub locators first discover the package identity from
the dedicated repository, resolve the selected ref (or the current default
branch) once to a full commit SHA for a repeatable Yarn install, and then
delegate activation to `yarn mercato module enable`.

```bash
npx create-mercato-module install @your-name/mercato-visits@beta
npx create-mercato-module install @your-name/mercato-visits@1.2.3
npx create-mercato-module install npm:unscoped-visits
npx create-mercato-module install your-name/mercato-visits
npx create-mercato-module install your-name/mercato-visits@1.2.3
npx create-mercato-module install your-name/mercato-visits@1.2.3-beta.1
npx create-mercato-module install your-name/mercato-visits@release/1.2.3
npx create-mercato-module install https://github.com/your-name/mercato-visits.git
```

It accepts the same repository forms as `link`: GitHub `owner/repo`, HTTPS,
SSH, `github:owner/repo`, and a bare repository name for the authenticated
GitHub user. Scoped names are npm locators; prefix an unscoped npm package with
`npm:` to distinguish it from a bare GitHub repository name. GitHub installs
require `gh auth login`; npm authentication and registry settings remain under
Yarn/Open Mercato control.

If Yarn blocks the requested GitHub URL with `YN0080`, the interactive installer
shows the exact repository and asks `Add this repository to Yarn approvals and
retry? [y/N]`. Only `y` or `yes` changes the configuration. Approval appends that
URL to the existing project-level `approvedGitRepositories` via `yarn config
set`; it never adds a wildcard or approves another blocked dependency. Without
a terminal, use `--approve-git-repository` to explicitly approve this step.
If the retry fails, the approved URL remains in the app configuration for the
next attempt; inspect the `.yarnrc.yml` diff before committing it.
After approval, Yarn shows live installation progress. The installer waits for
that installation to finish, then enables the module in the same invocation.

Apps created by `create-mercato-app` install npm versions only 5 days after
publication (Yarn `npmMinimalAgeGate`; Yarn's own default is one day), except
packages listed in `npmPreapprovedPackages`. When an npm installation fails,
`install` reads the app's gate, its preapprovals and the version's publication
time from Yarn. If the gate held the version back, it explains the wait and, in
a terminal, asks `Add this package to Yarn's preapproved packages and retry?
[y/N]`. Approval appends only that package name to the existing list via `yarn
config set` and retries; later versions of the package then install without
the wait. Without a terminal, pass `--preapprove-package`. Other failures keep
Yarn's own error. GitHub installs are not held back by this gate for the module
itself.

After installation, `install` compares the module's `@open-mercato/*` peers
with the framework versions in the app and prints one warning for any that do
not match (Yarn reports them as `YN0060`).

Use `owner/repo@version-or-ref` for the same suffix syntax as npm's
`package@version`. A numeric version such as `@1.2.3` first resolves the exact
Git ref `1.2.3`. `publish` tags each release with that bare version, so
repositories released by this tool resolve here. Only when GitHub reports that
ref missing (HTTP 404 or its commit-not-found HTTP 422 response), the installer
tries `v1.2.3`, the tag form the generated publication workflow listens to. Prereleases such as `@1.2.3-beta.1` work the same way. If both refs
exist, the exact unprefixed ref wins to preserve existing installations.

Non-numeric suffixes such as `@v1.2.3`, `@beta`, `@release/1.2.3`, and commit
SHAs select that exact Git ref. GitHub suffixes do not query npm dist-tags or
resolve semver ranges. `owner/repo#ref` and `--ref` always mean an exact ref,
including numeric refs; an explicit `--ref` disables the version-tag fallback.
If a locator suffix and `--ref` are both provided, they must match exactly.
Authentication, rate-limit, and network failures stop installation. A missing
version never falls back to the default branch, and Yarn is called only after
the selected ref resolves to a full commit SHA.

A module can declare the modules it depends on as `requires` in the `metadata`
export of its `index.ts`. `install` compares that list with the modules
registered in `src/modules.ts` and warns about each one that is missing, because
Open Mercato's generators stop while a required module is not enabled. For a
GitHub locator the warning appears after the package is added and before the
module is enabled; for an npm locator Open Mercato installs and enables in one
step, so the warning follows that step or is attached to its error. Enable the
listed modules in `src/modules.ts`, then run `install` again if it failed. The
check is skipped when `src/modules.ts` does not define a plain `enabledModules`
array. Conditional registrations are included only when literal or current
process-environment conditions can be evaluated. Unsupported condition branches
are conservatively excluded; the checker does not execute application code.

Requirements accept legacy module IDs (`customers`), scoped npm packages
(`@pkarw/marketing_consents@beta`), explicit npm locators
(`npm:marketing-consents@1.0.0`), and GitHub repository locators (`owner/repo`,
`github:owner/repo`, HTTPS, and SSH). Canonical identities are
`npm:<package-name>` and `github:<owner>/<repository>`; versions and refs are
installation choices and GitHub names compare without case sensitivity.
Packages from different publishers do not satisfy each other's requirements
even when their module IDs are identical. Missing package requirements include
an `install` command preserving the requested version or ref.

The checker derives npm identity from the installed package's manifest name,
falling back to the enabled entry's `from` when the name is unavailable, and
GitHub identity from its app dependency specifier or dedicated package
`repository` metadata (monorepo subdirectories are excluded). An optional
`locator` on an enabled entry or module `metadata` preserves identity for local,
ejected, and linked modules. `link` records its canonical GitHub locator when
registering a local checkout, together with its `packageName` so npm requirements
continue to match the linked package. GitHub installation rejects a module ID already
registered from another package/source, or occupied by a local module, before
running `yarn add`.


| Option | Behavior |
|---|---|
| `--package @your-name/mercato-visits` | Verify the discovered/requested package identity before installation |
| `--approve-git-repository` | Approve adding only the requested GitHub repository URL to the app's Yarn `approvedGitRepositories` if installation is blocked |
| `--preapprove-package` | Approve adding only the requested npm package to the app's Yarn `npmPreapprovedPackages` if its version is younger than `npmMinimalAgeGate` |
| `--module module_id` | Choose one module from a package that contains multiple modules |
| `--ref tag-or-branch-or-commit` | Resolve and pin this exact GitHub ref; must match any locator suffix; rejected for npm locators |
| `--eject` | Ask Open Mercato to copy ejectable source into `src/modules` and register it as `@app` |

### `link <repository-or-npm-package> [local-name]`

Connects repository source to the current app and remembers its identity for `publish <module_id>`. Accepts GitHub `owner/repo`, repository URLs, bare repository names for the signed-in GitHub user, scoped npm package names, and `npm:package-name`. With no argument, a terminal prompt asks for the repository or npm package. The optional local name only changes the checkout folder.

Repeating a link with matching saved ownership metadata preserves edits and reuses the checkout. Arbitrary module symlinks, conflicting registrations, and occupied checkout directories are rejected. Linking rolls back source and registration changes if setup or metadata saving fails. `yarn generate` runs after the link is saved; if generation fails, fix its reported error and rerun generation or the same link command.

| Option | Behavior |
|---|---|
| `--package @your-name/mercato-visits` | Optional package identity check; normally inferred from the repository |
| `--repo owner/repository` | Repository override for the legacy `link <module_id>` form; accepts URLs too |
| `--no-generate` | Link the source without running `yarn generate` |

Messages that say a module is already linked point to `unlink`.

Linked publication reads the owned checkout, including custom local checkout names, and preserves author source, tests, README and workflow customizations. The first release after linking suggests the repository version's next patch; later releases increment the last published version. Use `--version` to choose another version. A dry run packages the linked source without writing to GitHub or npm.

### `unlink <module_id>`

Makes a linked module an ordinary local module again. The checkout's current source, including uncommitted edits, is copied into `src/modules/<module_id>`, and the development link is removed from `.mercato/module-tool.json`. The package name, repository and released versions stay saved, so `publish <module_id>` exports from the app again; if the repository's latest commit came from the linked checkout, publish asks for `--overwrite-repo` approval first. The checkout under `.mercato/module-repos/` and the source backed up when linking stay in place for you to inspect or delete. `src/modules.ts` is not changed. If saving the settings fails, the symlink is restored.

## Authentication

Publication checks npm authentication before building the archive and checks GitHub authentication before work requiring a repository. GitHub forms of `install` and `link` check GitHub first. npm forms of `install`, `init`, `--help`, and `publish --dry-run` do not require GitHub authentication.

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

New module repositories include `.github/workflows/publish.yml`. It uses GitHub-hosted Ubuntu, Node 24, `id-token: write`, a build, and direct `npm publish`; no npm write token is needed. It runs manually or for a `v*` tag matching `package.json`'s version, and skips publication when that version is already on npm.

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

Choose one publisher for each version: local `publish visits` or the repository workflow. A version already submitted by one cannot be published again by the other. Local `publish` tags its releases with the bare version (`1.2.3`), which does not match the workflow's `v*` trigger. For workflow releases, bump the repository's package version, commit/push it, then run the workflow or push its matching tag. `--auth trusted` selects OIDC for this tool inside a suitably configured Actions job; it does not configure npm settings or log in a local terminal.

## What ships in the package

| Included | Excluded |
|---|---|
| Selected module's TypeScript sources | Other modules and app configuration |
| Individually compiled ESM files | App Git history and `.env` files |
| Portable TypeScript under `types/` for consumer type resolution | App-only alias dependencies in the public type surface |
| Translations and runtime assets | `node_modules`, tests, and mock directories |
| Migrations and schema snapshots | Symlinks and credential files |
| Package metadata and rebuild script | Authentication tokens |

The package includes `src/modules/<id>`, `dist/modules/<id>`, and portable `types/modules/<id>` for discovery, ejection, runtime imports, and consumer type resolution. Compilation preserves client directives, React's automatic JSX runtime, and legacy decorator metadata. Entity convention files (`entities`, `entities.override`, and `schema` under `data/` or legacy `db/`) also keep a TypeScript source mirror beside their compiled JavaScript in `dist`, allowing the host to discover exported entity classes and fields. Executable package exports continue to resolve to JavaScript. In linked development, publication keeps the repository's author source and tests intact; the build rewrites own-module aliases in generated output and portable type sources.

Imported dependencies are recorded from installed versions. Framework packages, React, Next.js, and MikroORM become exact-version peers to match the source app. `install` warns when an app's `@open-mercato/*` versions differ from those peers. `@tanstack/react-query` and `@tanstack/react-table` come from the host app, which provides their React context and types: they become `^<installed>` peers and exact development dependencies, so an app never installs a second copy. Other imported packages become runtime dependencies. On a release from a linked repository, a name that the repository's `package.json` declares in `peerDependencies` is never added to `dependencies`, and the repository's range for `@tanstack/react-query` or `@tanstack/react-table` is kept unless it excludes the installed version.

The initial module license follows the app's `package.json` `license` field, or defaults to `UNLICENSED`. Linked releases preserve the module repository's own license. Choose the appropriate license before publishing. The tool itself is MIT licensed.

### Keep your module portable

Imports within the selected module, including `@/modules/visits/...`, become portable relative imports. Publication stops with an actionable error for app-only aliases, imports of another local module, local/Git dependency locators, CommonJS `require()` / `import = require`, symlinks, and recognizable embedded credentials.

Server-side module-presence checks such as `import { enabledModules } from '@/modules'` followed by `enabledModules.some(module => module.id === 'customers')` are translated to the consuming app's runtime `getModules()` registry. Renamed imports work too. The publishing app's configuration is never copied, and your original source stays unchanged. Other uses of `@/modules` (configuration fields, mutations, namespace imports, or client components) remain unsupported and report an actionable error.

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

Without `link`, the application module remains the source of truth. The tool does not commit, push, or change the app's Git origin. GitHub export uses an isolated checkout under `.mercato/module-publish/`, then pushes a normal commit without forcing history. Existing repositories must be empty or contain the matching package and this tool's ownership marker. The export replaces the repository's `src`, `dist`, `types`, `README.md`, and workflow with the app's module, so when the repository's latest commit was not released from an app by this tool (a merged pull request, an edit on GitHub, a release from a linked checkout), the tool warns and asks for approval first. Release commits carry a `Mercato-Source:` trailer for this, so the check works from any machine and in CI. Exports older than 15 minutes are removed from `.mercato/module-publish/` on the next export. With `link`, the independent checkout becomes the module source; the app's symlink keeps development inside the same app.

GitHub is updated before npm publication: a retry after an npm failure finds the release commit and adds no second one, while a published npm version can never be redone. A new repository is therefore created, with the visibility shown in the summary, even if npm then rejects the package. If npm fails after the push, the error names the repository and the pushed commit; fix the reported npm issue and run publish again with the same version. Once npm accepts the release, the tool tags its commit with the bare version (for example `1.2.3`) through the GitHub API so `install owner/repo@1.2.3` resolves it. A failed tag request only warns, because the npm release is already out, and prints the command that creates the tag.

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

To rehearse a whole publication without touching npmjs.com or GitHub, run the local release checks: they point the tool at a throwaway registry with `MERCATO_NPM_REGISTRY` (addresses on your machine only) and at local Git repositories.

For release verification against **fresh, fully installed `create-mercato-app` applications**, use the repeatable [release end-to-end scripts](https://github.com/open-mercato/create-mercato-module/blob/main/test/release-e2e/README.md). They install a real module from both npm and GitHub, verify discovery and runtime behavior, and save sanitized results. Fixture publication is a separate explicit step; the harness does not create remote repositories or publish packages. Private fixture packages/repositories are supported.

The Next source-link test verifies HTTP rendering and edits in a running dev server. It does not claim a database-backed CRUD flow or browser-level Fast Refresh coverage. Trusted Publishing requires the real npm publisher configuration and an Actions runner; local OIDC simulation is not evidence of a successful registry publication.

Contributions are welcome. Keep changes focused, add tests for changed behavior, and include validation results in your pull request.
