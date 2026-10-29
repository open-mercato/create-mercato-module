# Changelog

## Unreleased

- Publish and `link @scope/package` work with npm 12, which prints `npm pack --json` as an object keyed by package name and wraps `npm view --json` results in an array.
- `install` of an npm module that Yarn holds back with its release-age gate (`npmMinimalAgeGate`, 5 days in apps from create-mercato-app) now explains the wait instead of a bare `yarn failed`. It asks before adding only that package to the app's `npmPreapprovedPackages`; noninteractive callers pass `--preapprove-package`. The message after publish and generated module READMEs say the same and use `npx create-mercato-module install` throughout.
- `publish` tags each release commit with its bare version (`1.2.3`) once npm accepts it, so `install owner/repo@1.2.3` works for repositories released by this tool. The bare tag does not start the generated `publish.yml` (`v*`). Newly generated workflows also skip publication when the version is already on npm; existing repositories keep their workflow until the next export from the app.
- When npm rejects a release after the GitHub push, the error names the repository, says whether this run created it, and gives the pushed commit. The summary says a new repository is created before npm publication.
- New `unlink <module_id>` command turns a linked module back into an ordinary local module and keeps the checkout and backup. Messages that mentioned unlinking now name it.
- `install` warns once when a module's `@open-mercato/*` peers differ from the app's framework versions.
- **Peer ranges:** published packages declare framework, React, Next.js and MikroORM peers as caret ranges of the source app's versions (`^0.9.0` instead of `0.9.0`), so apps on later compatible releases install them without Yarn peer warnings and Open Mercato Modules no longer reports `peer-exact-pin`. `devDependencies` keep the exact versions the module repository builds against.
- **Exit code:** cancelling the publish wizard by not retyping the package name now exits with code 1 instead of 0, so wrapping scripts can tell a cancellation from a release.
- SSH locators such as `ssh://git@github.com/owner/repo` no longer read `git@…` as a Git ref, and linked publish compares the configured origin URL, so `insteadOf` rewrites no longer make a valid checkout look foreign.
- Examples in `--help`, the README and the guide install `@fastwhitecat/integration-ksef-direct@0.1.8`, a published module, and link the placeholder `your-org/your-module`, instead of a repository that no longer exists.
- New `describe <module_id>` command prints the module's entry for [Open Mercato Modules](https://modules.openmercato.com) from its saved publish settings; `--open` opens the submit page, and `--package` describes a module before its first publish. After a public release, `publish` prints the submit link, and generated module READMEs mention it. Until the catalog launches, printed links say that it has not launched yet and `--open` does not open them; `MERCATO_CATALOG_URL` points the tool at another deployment of the catalog.
- **Description:** in a terminal, `init` asks what the module does and writes the answer as `description` in the module `metadata` (scripts pass `--description`); it must be 20 to 140 characters of plain text, as the catalog summary is. `publish` and `describe` warn alike when a module has no usable description, instead of silently using `Open Mercato module: <id>`, and name the file to set it in. A linked repository whose `package.json` still has that fallback takes the description from the module metadata.
- `describe` and `publish` read only the module's exported top-level `metadata` (`export const metadata` or `export { metadata }`); a local `metadata` inside a helper no longer overrides its title or description.
- `describe --open` prints the fallback `Open ... in your browser.` on stderr when no browser opens, so `describe <module_id> --open > entry.yml` stays valid YAML.
- Generated `package.json` files carry the keywords `open-mercato` and `open-mercato-module`, the description from the module's `metadata` and, with a dedicated repository, `homepage` and `bugs`. Linked releases keep the repository's keywords and add the two when missing. Once npm accepts a release, the dedicated repository gets the `open-mercato-module` and `open-mercato` topics (best effort, like the tag).

## 0.5.1

- Show live Yarn progress after approving a GitHub repository and allow the retry to finish before enabling the module. The retry no longer inherits the short timeout used for captured inspection commands, which could interrupt a slow installation and require another invocation.
- Preserve TypeScript entity convention files (`data/` and legacy `db/` entities, overrides, and schemas) beside compiled JavaScript in exported packages and dedicated-repository rebuilds. Open Mercato can then discover entity IDs and fields instead of generating an empty registry. Runtime import paths are unchanged. Existing repositories need the updated generated `build.cjs`, followed by a rebuild, host generation, and a development-server restart.

## 0.5.0

- Match module requirements by canonical npm package and GitHub repository identities, preserve requested versions in installation hints, and reject module ID collisions before changing app dependencies. Packages from different publishers do not satisfy each other's requirements.
- When GitHub installation is blocked by Yarn's `approvedGitRepositories` (YN0080), explain the required change and ask for confirmation interactively. Only after approval, append the exact requested GitHub URL to the existing app-level allowlist and retry. Noninteractive callers must pass `--approve-git-repository`; unrelated blocked dependencies are never automatically approved.
- GitHub installs accept npm-style version selectors such as `owner/repo@1.2.3` and `owner/repo@1.2.3-beta.1`. An existing exact ref wins; when it is missing, installation tries the conventional `v`-prefixed release tag and pins the resolved commit. Explicit `#ref` and `--ref` selectors keep exact-ref behavior.
- Keep published TypeScript source imports compatible with linked Next.js development while retaining `.js` imports in compiled ESM and types. Previously, publishing rewrote `src/` imports to `.js` and linking them back into an app could fail with `Module not found`. Existing repositories can remove the `.js` suffix from imports targeting TypeScript source; package exports and compiled output are unchanged.

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
