# Execution plan: publish host-provided singletons as peers

## Goal

Publish `@tanstack/react-query` and `@tanstack/react-table` as peer dependencies of exported modules, and keep a maintainer's peer choice when a linked release merges the repository manifest, so an app never installs a second copy of either package.

## Scope

- `src/package.ts`: a named `hostProvidedPackages` list. Those names go to `peerDependencies` as `^<installed version>` and to `devDependencies` at the exact installed version, never to `dependencies`. The existing framework singletons (`@open-mercato/*`, `@mikro-orm/*`, `react`, `react-dom`, `next`) keep their current exact peers.
- `src/publish.ts`: after the linked-release merge, drop from `dependencies` every name the repository manifest declares in `peerDependencies`.
- `CHANGELOG.md` entry and a `BACKWARD_COMPATIBILITY.md` note on the published package layout row.
- Unit tests with synthetic fixtures only.

## Non-goals

- Changing how framework singletons are written (caret ranges are a separate change).
- Any change to the catalog/metadata or catalog/default-license branches.
- Installing or running any third-party module on this host.

## Risks

- The singleton block conflicts with the catalog/metadata branch; the second merge must keep that branch's caret ranges and add the host-provided names to the peer path.
- Published layout is a protected surface: a maintainer has to accept the change.

## Implementation Plan

### Phase 1: Host-provided peers

1.1 Add `hostProvidedPackages` and route those names to caret peers plus exact dev dependencies, with tests.

### Phase 2: Linked release keeps peer choice

2.1 Drop repository-declared peers from merged `dependencies`, with tests.

### Phase 3: Documentation

3.1 CHANGELOG entry and BACKWARD_COMPATIBILITY.md note.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` - <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Host-provided peers

- [ ] 1.1 Add hostProvidedPackages and route them to caret peers plus exact dev dependencies

### Phase 2: Linked release keeps peer choice

- [ ] 2.1 Drop repository-declared peers from merged dependencies

### Phase 3: Documentation

- [ ] 3.1 CHANGELOG entry and BACKWARD_COMPATIBILITY.md note
