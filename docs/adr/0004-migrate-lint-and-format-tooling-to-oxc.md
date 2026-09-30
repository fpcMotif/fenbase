# Migrate lint and format tooling to Oxc (Oxlint, Oxfmt, type-aware)

## Context

Contributors and AI coding agents previously operated under a slow, inconsistent, and fragmented linting and formatting toolchain:
- Root workspace used ESLint 8 (legacy config format) running Prettier as an ESLint plugin (`eslint-plugin-prettier`).
- The `docs` workspace ran ESLint 9 (flat config), Prettier, and Biome simultaneously across overlapping scopes.
- Scaffold templates (`create-nocobase-app`) distributed deprecated ESLint and Prettier setups to generated projects.
- Written contributor guidelines (banning `any` and fire-and-forget `void` calls) were largely unenforced because `no-explicit-any` was disabled and no rule caught unhandled/void promises.
- No CI workflow gated lint or format errors, and local git hooks failed with opaque errors in environments without globally linked binaries.

## Decision

We migrate the whole repository to the unified **Oxc toolchain**: **Oxlint** for linting (including type-aware checks via `oxlint-tsgolint`) and **Oxfmt** for formatting.

1. **Replacement, Not Coexistence:**
   - ESLint, Prettier, Biome, all ESLint plugins and parsers, and `pretty-quick` are completely removed from root, docs, and scaffold templates.
   - All ESLint/Prettier package overrides and resolutions are pruned.

2. **Rule Parity & Formatting Parity:**
   - Oxlint provides native plugin implementations for `typescript`, `react` (with React hooks), `promise`, and `oxc`.
   - Oxfmt reproduces existing Prettier formatting conventions: single quotes (`singleQuote: true`), trailing commas everywhere (`trailingComma: "all"`), and explicit print width of 120 (`printWidth: 120`).
   - Markdown, HTML, SVG, and template files remain excluded from automated formatting, preserving existing boundaries.

3. **Contributor Guide Enforcement:**
   - Staged changes strictly enforce contributor rules: avoiding `any` via `typescript/no-explicit-any` and fire-and-forget `void` via `no-void` and `typescript/no-floating-promises` with `{ "ignoreVoid": false }`.
   - Legacy violations in untouched files warn without blocking commits, allowing incremental improvement as files are edited.

4. **Dedicated Type-Aware Configuration & Scoped Rollout:**
   - Type-aware linting runs through dedicated, TypeScript 7 native compiler-compatible configurations (`tsconfig.oxlint.json`, `convex/tsconfig.json`, `src/demo/tsconfig.json`, `scripts/tsconfig.json`, and `packages/core/test/src/e2e/tsconfig.json`).
   - Initial rollout is scoped to the files that already relied on type-aware rules (e2e test suites), plus the Convex backend code, the demo application, and maintenance scripts.
   - Coverage will widen to individual packages as their TypeScript configurations are upgraded to modern compiler options.

5. **Local Hook & CI Alignment:**
   - Pre-commit checks invoke `bun scripts/pre-commit.ts`, checking that required tools exist (with clear remediation guidance if missing), formatting staged files with `oxfmt`, and linting staged files with `oxlint`.
   - GitHub Actions CI workflow (`.github/workflows/lint-and-format.yml`) runs the identical commands on pushes and pull requests.

## Consequences

- Installs and package audits are smaller and faster with ESLint and Prettier dependencies removed.
- Linting time for changes drops from tens of seconds to sub-second runs.
- Format and lint failures are decoupled into distinct check and fix commands (`bun run format` / `bun run format:check` vs `bun run lint`).
- Upstream merges will require maintaining the diverged root tooling configuration.
