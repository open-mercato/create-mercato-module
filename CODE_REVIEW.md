# Code review rules

Repository-specific rules, applied by `om-code-review` in addition to its built-in checklist. This tool publishes other people's source to public registries with their credentials, so safety outranks convenience.

## Priorities

1. **Nothing leaves the machine without approval.** Any new path that pushes, publishes, or creates a remote resource must sit behind the confirmation in `src/cli.ts`. A new risk needs its own warning and approval option; `--yes` never covers warnings.
2. **No credential leaves the machine.** Files that can reach npm or GitHub pass the shared credential scan. Tokens are never written to disk, saved settings, command arguments, or error output.
3. **No write outside owned paths.** Filesystem writes and deletes are checked against symlinks and the app or checkout root before they happen.
4. **Failure leaves a usable state.** Multi-step filesystem changes roll back; external steps are ordered so a failure is retryable.

## Repository-specific checks

- External commands go through `run` or an injected `Executor` with an argument array. No `shell: true`, no string concatenation into a command.
- Every value interpolated into a command, path, or generated file is validated first (`validateId`, `validateSettings`, the repository and package-name patterns).
- A failed check on auth, registry, or repository state stops the run; it never falls through to "assume it is fine".
- `src/build.ts` stays self-contained: Node built-ins and `typescript` only.
- Network commands whose output is captured keep the default timeout.
- Changes to `src/workflow.ts` are reviewed as CI security changes: no untrusted `${{ }}` in `run`, actions pinned to commits, minimal permissions.
- Behavior changes ship with a test in `test/*.test.cjs` that fails without them. Publication paths are tested with fake executors or local bare repositories, never real registries.
- User-facing errors say what happened, what was or was not changed, and what to do next.

## Severity

- **blocker**: unapproved publication, credential exposure, writes outside owned paths, a failing validation command, a breaking change to a surface in `BACKWARD_COMPATIBILITY.md` without its required path.
- **major**: correctness bug on a realistic path, missing test for changed behavior, failure that leaves the app or repository in a state the tool cannot recover from.
- **minor / nit**: conventions, wording, polish.
