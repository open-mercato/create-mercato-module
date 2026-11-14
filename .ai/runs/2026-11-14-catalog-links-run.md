# Execution plan: catalog links point at www.openmercato.com/run

## Goal

The Open Mercato module catalog moves from https://modules.openmercato.com under the main site as its "Run" section. The links that people read in this repository (docs and the text the tool prints) point at the final addresses: the catalog home at `https://www.openmercato.com/run/modules` and every other page at `https://www.openmercato.com/run/<path>`.

## Scope

- `src/package.ts`: `publicCatalogUrl` becomes `https://www.openmercato.com/run`. Every use was read first: `catalogSubmitUrl` (`/submit?npm=<package>`) and `catalogModuleUrl` (`/m/<package>`) build links printed by `describe`, by the message after `publish` and in generated module READMEs; `--help` prints `<catalog>/submit`; `openCatalogPage` in `src/describe.ts` only checks that the URL it opens in the browser starts with the catalog address. All of them are links for a person. The tool fetches nothing from the catalog and builds no machine address from this constant (searched `src/` for `catalogUrl`, `publicCatalogUrl`, `fetch(`, `schema/`, `badge`, `modules.json`), so the constant is not split.
- Unit tests that assert these strings: `test/describe.test.cjs`, `test/config-cli.test.cjs`, `test/link-cli.test.cjs`, `test/module.test.cjs`.
- `README.md`, `docs/guide.md`: catalog home, submit links and module page links.
- `CHANGELOG.md`: one entry under Unreleased.

## Non-goals

- Machine endpoints stay on `https://modules.openmercato.com`: the descriptor schema address (`/schema/descriptor-1.json`, named in a comment in `src/describe.ts`, in `test/describe.test.cjs` and as `$id` in `test/fixtures/catalog/descriptor-1.json`), badge images (`/badge/<package>.svg`), `modules.json`, fixtures that mirror catalog data.
- `.ai/runs/**` history and past CHANGELOG entries.
- No behaviour change: `MERCATO_CATALOG_URL` keeps overriding the catalog address the same way. No version bump, no release.

## Risks

- The new addresses answer 404 until the catalog is switched (open-mercato/modules, branch `feat/under-openmercato-com`), so this PR must not be merged before that. The PR stays a draft with `do-not-merge`.
- The new addresses were not opened during this run; they are taken from the brief.

## Implementation Plan

### Phase 1: Printed links

1.1 Point `publicCatalogUrl` at `https://www.openmercato.com/run` and update the unit tests that assert the printed links.

### Phase 2: Documentation

2.1 Update the links for people in `README.md` and `docs/guide.md`.
2.2 Add the CHANGELOG entry under Unreleased.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Printed links

- [x] 1.1 Point publicCatalogUrl at www.openmercato.com/run and update the tests — 2fa03c6

### Phase 2: Documentation

- [ ] 2.1 Update links in README and guide
- [ ] 2.2 Add the CHANGELOG entry
