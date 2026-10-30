# Execution plan: link Open Mercato Modules as a live site

## Goal

Open Mercato Modules answers at https://modules.openmercato.com (200 on `/`, `/modules.json`, `/submit` and module pages under `/m/<package>`, checked 2026-10-30), so the tool links to it as a live site: `describe`, `publish` and `--help` print its links without the pending-launch note, `describe --open` opens the submit page, and the docs stop saying the catalog has not launched.

## Scope

- `src/package.ts`: set `catalogLaunched = true`; add `catalogModuleUrl` for the module page (`<catalog>/m/<package>`), honoring `MERCATO_CATALOG_URL` like `catalogSubmitUrl`.
- `src/describe.ts`, `src/cli.ts`: where the pending note was printed, a live catalog now gets the module page link (describe header comment, publish message). The pending-note branch stays behind the flag.
- Tests in `test/describe.test.cjs`, `test/link-cli.test.cjs`, `test/config-cli.test.cjs`: with the flag on, describe and publish output link the submit page and the module page on https://modules.openmercato.com and print no pending note; `--open` opens the public submit page; `MERCATO_CATALOG_URL` still overrides both links and `--open`.
- `README.md`, `docs/guide.md`: drop the "has not launched yet" texts; `CHANGELOG.md` entry under Unreleased.

## Non-goals

- Removing the `catalogLaunched` flag or the pending-note code path.
- Generated module READMEs (they already link the public submit page) and the catalog badge.
- Changing the `describe` YAML fields (protected surface in `BACKWARD_COMPATIBILITY.md`); only a header comment line changes.

## Risks

- Tests that run `describe --open` must not open a real browser; the existing fixture replaces `open`/`xdg-open`/`explorer` on `PATH`.
- The module page exists only after the catalog lists the module, so the texts say "once listed".

## Implementation Plan

### Phase 1: Live catalog links

1.1 Set `catalogLaunched = true`, add the module page link to describe and publish output, update tests.

### Phase 2: Documentation

2.1 Update README, guide and CHANGELOG.

### Phase 3: Review fixes

3.1 Clear `MERCATO_CATALOG_URL` in the config-cli and link-cli fixtures so a shell override cannot break the live-catalog assertions.

## Progress

PR: #19

> Convention: `- [ ]` pending, `- [x]` done. Append ` - <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Live catalog links

- [x] 1.1 Set catalogLaunched and link the module page in describe and publish output - 9bf5a39

### Phase 2: Documentation

- [x] 2.1 Update README, guide and CHANGELOG - 3da2fa3

### Phase 3: Review fixes

- [x] 3.1 Isolate the catalog URL override in CLI fixtures - d6e28bc
