# create-mercato-module

A Node CLI (`npx create-mercato-module`) that scaffolds one module inside an existing Open Mercato app, packages it as a standalone npm package, publishes it to npm and optionally to a dedicated GitHub repository, and links that repository back into the app for development. TypeScript compiled to CommonJS in `dist/`; the only runtime dependency is `typescript`.

## Task routing

| When the task involves… | Read first | Key rules |
|---|---|---|
| CLI arguments, prompts, the publish summary | `src/cli.ts`, `docs/guide.md` | Flags are parsed by hand in `parse`; every flag is documented in the help text and the guide. Nothing is published without explicit approval. |
| Packaging a module (file selection, import rewriting, manifest) | `src/package.ts`, `src/build.ts` | `src/build.ts` is copied verbatim into published packages as `build.cjs`: it may import only Node built-ins and `typescript`. |
| npm and GitHub publication | `src/publish.ts`, `src/npm-auth.ts` | Run commands through `run`/an `Executor` with argument arrays, never a shell string. Validate every value before it reaches a command. Tokens stay in the environment. |
| Linked development (`link`) | `src/development.ts` | Paths never pass through symlinks; every filesystem step has a rollback. |
| Repository and credential safety checks | `src/repository-safety.ts`, `src/build.ts` | One credential scan, shared by every path that publishes files. |
| Saved settings | `src/config.ts` | `.mercato/module-tool.json` holds no credentials and is written atomically. |
| Scaffolding (`init`) | `src/scaffold.ts` | Edits `src/modules.ts` through the TypeScript AST, not by text search. |
| Generated GitHub workflow | `src/workflow.ts` | Ships to users' repositories; keep it free of expression injection and pin actions to commits. |
| Unit tests | `test/*.test.cjs` | `node --test` against `dist/`; external commands are replaced with fake executors or local bare Git repositories. |
| Release verification against real apps | `test/release-e2e/README.md` | Separate from unit tests; never publishes or creates repositories. |

## Validation

Run in order: `npm run typecheck`, `npm test`, `npm pack --dry-run`.

## Process

- Ticket flow and labels: `SDLC.md`
- Review rules: `CODE_REVIEW.md`
- Protected contract surfaces: `BACKWARD_COMPATIBILITY.md`
- Agent pipeline settings: `.ai/agentic.config.json`
