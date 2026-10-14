# GitHub installation with npm-style version suffixes

## Goal

Make `create-mercato-module install org/repo@1.2.3` work with conventional
`v1.2.3` Git tags, while preserving existing exact Git refs and npm installation.

## Scope

The current main branch already parses `org/repo@ref`. Complete version
resolution, regression coverage, CLI help, and installation documentation.
The request is interpreted as `create-mercato-module install` from the preceding
conversation. No changes to create-mercato-app, publishing, link, dependencies,
or the default-branch selection behavior are planned.

## Implementation plan

### Phase 1: Implementation and regression tests

1. Preserve exact-ref precedence. For a numeric version supplied after `@`,
   retry `v<version>` only when GitHub reports the exact ref missing (HTTP 404
   or the commit-not-found HTTP 422 response).
   Explicit `--ref` and `#ref` keep exact-ref semantics. Fail before Yarn on
   missing refs, authentication/network errors, or conflicting selectors.
2. Cover version tags, prereleases, exact-ref precedence, failure paths,
   npm compatibility, and the CLI argument-to-Yarn boundary.
3. Document suffix syntax and resolution order in help, README, guide,
   and the changelog.

### Phase 2: Verification and PR delivery

1. Run the configured validation gate and review compatibility, security,
   scope, and tests through om-auto-review-pr / om-code-review.
2. Update the PR with verification evidence, labels, review results, and
   manual verification steps; mark it ready and remove the temporary worktree.

## Risks

- Both `1.2.3` and `v1.2.3` can exist; exact-ref precedence preserves the
  existing selection. A typo or unavailable release must never install main.
- Only a confirmed missing ref permits the alternate tag lookup. Other GitHub
  failures stop installation.
- A read-only GitHub API probe confirmed that `/commits/<missing-ref>` returns
  HTTP 422 with `No commit found for SHA:`. Tests cover this actual response
  separately from generic HTTP 422 validation failures.
- A GitHub version selector resolves Git refs, not npm dist-tags or ranges.

## Progress

PR: #8

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Implementation and regression tests

- [x] 1.1 Implement npm-style GitHub version resolution and regression tests — adea7ca
- [x] 1.2 Document GitHub version suffixes and compatibility — f27741d

### Phase 2: Verification and PR delivery

- [ ] 2.1 Complete the validation gate and automated code review
- [ ] 2.2 Finalize the ready PR with verification evidence
