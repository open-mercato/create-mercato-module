# Execution plan: fix the defects found by the 0.5.1 end-to-end test

## Goal

Make publish, install, link and the release checks work on the path a user actually takes with create-mercato-module 0.5.1: npm 12, Yarn's age gate in new apps, version installs from repositories this tool released, and CI that exercises that path.

## Scope

Defects 1, 2, 3, 5, 6, 7, 8, 9, 10, 11, 12 and 13 from the end-to-end report (there is no defect 4 in the report).

| # | Decision |
|---|---|
| 1 | Accept both `npm pack --json` shapes: the array (npm ≤ 11) and the object keyed by package name (npm 12). |
| 2 | On a failed npm install, detect Yarn's age-gate quarantine from Yarn's own configuration and package metadata, then print a ready command. `install --preapprove-package` (or the interactive `[y/N]`) adds only that package to `npmPreapprovedPackages`, keeping existing entries. The same instruction appears after publish, in the module README, the tool README and the guide. |
| 3 | After a successful npm publication, tag the release commit as `<version>` (no `v`) and push the tag. `install owner/repo@1.2.3` resolves the exact ref first, and the generated workflow only listens to `v*`, so a local release never triggers a second publication. The generated workflow also skips publication when the version is already on npm. |
| 5 | Keep GitHub before npm (a retry after an npm failure stays idempotent), but name the pushed repository and commit when npm fails afterwards, and say in the summary that a new repository stays even if npm rejects the publication. |
| 6 | Read the ref from the locator after stripping the URL prefix, not from the raw input. |
| 7 | Peers stay exact: `BACKWARD_COMPATIBILITY.md` lists peer-dependency rules as a protected package-layout surface, so widening them is a release decision. `install` now warns once when the module's `@open-mercato/*` peers do not match the app. |
| 8 | Add `unlink <module_id>`: copies the checkout's current source back into `src/modules/<id>`, keeps checkout and backup, drops the development link. Messages point to it. |
| 9 | Use `npx create-mercato-module install` everywhere; the module README also shows the GitHub form. |
| 10 | A declined wizard confirmation exits with code 1. |
| 11 | Compare the raw `remote.origin.url` (no `insteadOf` rewriting). |
| 12 | Replace the missing `pkarw/visits-example` example with a public module repository. |
| 13 | Add an npm 12 CI leg, run release checks on the current scaffold, and make the harness use `create-mercato-module install` for both lanes, including a negative quarantine case. |

## Non-goals

- The `api_keys` failure of the `empty` preset (framework bug; no new workaround here).
- PR #11 (`ref: develop` → `main` in framework-tests); that line is left untouched.
- Widening published peer ranges (see 7).
- Creating pipeline labels in the repository.

## Risks

- Tag pushes are best effort: npm publication is already done, so a failed tag push warns instead of failing.
- Quarantine detection depends on Yarn's `npmMinimalAgeGate` / `npmPreapprovedPackages` settings (Yarn ≥ 4.10); when they are absent, behavior is unchanged.
- `create-mercato-app@latest` in CI is a moving target; the pinned leg stays as the stable signal.

## Implementation Plan

### Phase 1: Publish correctness

1.1 Accept both `npm pack --json` formats, with unit tests for each.
1.2 Read the raw origin URL in linked publish.
1.3 Name the pushed repository/commit when npm fails after GitHub; note it in the summary.
1.4 Tag releases as `<version>` after npm publication; the workflow skips versions already on npm.
1.5 A declined wizard confirmation exits 1.

### Phase 2: Install

2.1 Parse refs of `ssh://` and `git+ssh://` locators correctly.
2.2 Detect Yarn quarantine and offer `--preapprove-package`.
2.3 Warn when the module's framework peers do not match the app.

### Phase 3: Link

3.1 Add `unlink <module_id>` and point the messages to it.

### Phase 4: Docs and messages

4.1 Use one install command and one quarantine note everywhere.
4.2 Replace the missing example repository.

### Phase 5: CI and release checks

5.1 Add an npm 12 CI leg.
5.2 Run release checks on the current scaffold with the latest npm.
5.3 Route both harness lanes through `install`, add the quarantine negative case and the tag check.
5.4 Run the local release checks on this server.

### Phase 6: Validation

6.1 Run lint, typecheck, test, build and `npm pack --dry-run`.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Publish correctness

- [x] 1.1 Accept both `npm pack --json` formats, with unit tests for each. — 33b4edc
- [x] 1.2 Read the raw origin URL in linked publish. — 4fdb280
- [x] 1.3 Name the pushed repository/commit when npm fails after GitHub; note it in the summary. — 98b9de5
- [x] 1.4 Tag releases as `<version>` after npm publication; the workflow skips versions already on npm. — 98b9de5
- [x] 1.5 A declined wizard confirmation exits 1. — 98b9de5

### Phase 2: Install

- [x] 2.1 Parse refs of `ssh://` and `git+ssh://` locators correctly. — 6153cc5
- [x] 2.2 Detect Yarn quarantine and offer `--preapprove-package`. — 771cad9
- [x] 2.3 Warn when the module's framework peers do not match the app. — c0706cd

### Phase 3: Link

- [x] 3.1 Add `unlink <module_id>` and point the messages to it. — f16cc9c

### Phase 4: Docs and messages

- [x] 4.1 Use one install command and one quarantine note everywhere. — b3e5468
- [x] 4.2 Replace the missing example repository. — 47a23ca

### Phase 5: CI and release checks

- [x] 5.1 Add an npm 12 CI leg. — fe9281a
- [x] 5.2 Run release checks on the current scaffold with the latest npm. — fe9281a
- [x] 5.3 Route both harness lanes through `install`, add the quarantine negative case and the tag check. — fe9281a, 3309984
- [ ] 5.4 Run the local release checks on this server.

### Phase 6: Validation

- [ ] 6.1 Run lint, typecheck, test, build and `npm pack --dry-run`.
