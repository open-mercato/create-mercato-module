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

## Verification evidence

- Focused installer/CLI suite: 33 passed. Three new version-tag regression
  tests fail against the base installer.
- Full configured gate passed: typecheck; 184 tests passed, 5 existing opt-in
  real-framework tests skipped; npm pack dry-run produced 53 packaged files.
- Lint and diff whitespace checks passed. On macOS the full gate used
  `TMPDIR=/private/tmp` because the default `/var` path is a symlink rejected
  by existing safety checks. No test or source guard was weakened.
- Code review found no actionable findings. GitHub rejected formal self-approval;
  the full assessment is posted on PR #8 for independent review.
- Remote CI remains pending. Missing configured workflow labels were skipped
  by the tracker guards; the existing documentation label was applied.
- PR #8 contains the review, validation evidence, risks, manual smoke steps,
  and rollback instructions. No npm release was made.

## Progress

PR: #8

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Implementation and regression tests

- [x] 1.1 Implement npm-style GitHub version resolution and regression tests — adea7ca
- [x] 1.2 Document GitHub version suffixes and compatibility — f27741d

### Phase 2: Verification and PR delivery

- [x] 2.1 Complete the validation gate and automated code review — reviewed adea7ca and f27741d
- [x] 2.2 Finalize the ready PR with verification evidence — PR #8
