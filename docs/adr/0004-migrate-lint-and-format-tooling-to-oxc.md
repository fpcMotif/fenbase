# Oxc quality policy and staged snapshots

## Context

The initial migration selected Oxc plugins without enabling type-aware execution in CI.
The hook used regular expressions and could stage unrelated working-tree changes.
Legacy application compiler settings also conflict with the native TypeScript lint engine.

## Decision

Use repository-installed Oxlint 1.86.0, Oxfmt 0.71.0, and oxlint-tsgolint 7.0.2003.
Bun 1.4.2 and bun.lock define the supported installation path.
Node 22 is the CI runtime; package metadata requires at least 22.12.0.
Vitest 1.5.2 matches the existing test runner and coverage packages.

The shared quality checker accepts either the staged index or committed HEAD against an explicit merge base.
Both paths materialize an isolated source snapshot.
Oxlint diagnostics enforce introduced code through .oxlintrc.policy.json.
Added-line matching includes multiline diagnostic spans and never exempts an entire removal hunk.
Valid targeted suppression directives retain their meaning.
Void type annotations and the void-zero sentinel remain valid.

Type-aware checks cover E2E files, Convex, the demo application, and scripts.
Snapshots use tsconfig.oxlint.json as their root compiler configuration.
Generated workspace aliases resolve into snapshot sources.
Nested compiler configurations are removed only inside the disposable snapshot.
Application compiler configurations remain unchanged.
Configuration errors, malformed output, missing tools, and process failures block checks.

Ordinary warnings retain the existing per-file, per-rule ratchet.
Updating that baseline can only lower counts after a successful complete scan.
Type-aware debt is reported separately by the full-scope audit.
Existing typed findings outside introduced spans do not block unrelated changes.

The hook runs formatting and the existing license-header tool inside the staged snapshot.
It updates index blobs only after every check succeeds.
Partially staged working-tree bytes remain intact.
The hk hook disables automatic restaging and stashing because the snapshot hook owns index updates.
CI uses the non-mutating checker and a separate static client-runtime import check.
The import check ignores `__tests__`, `lib`, `dist`, and `esm` directories; all other client-v2 source is checked.

Formatting keeps single quotes, trailing commas, width 120, and existing root exclusions.
Scaffolds use the root package-manifest formatting exclusion and pinned Oxc versions.
Commit-message and license-header tooling remain in place.

## Consequences

Direct legacy lint and format dependencies are removed.
Reachable Umi and Convex dependencies still contain legacy tooling.
Deleting those lock entries would break dependency resolution.

Native rule coverage does not establish complete historical rule parity.
Supported root mappings are restored for introduced code.
Docs overrides restore supported recommendations and Biome mappings labeled same for introduced docs code.
Unsupported and approximate mappings remain explicit exceptions in the rule inventory.
See [Issue 10 evidence](../migration/tooling-10.md) for commands, coverage, timings, and limits.
Live workflow and required-status evidence belongs to [PR 20](https://github.com/fpcMotif/fenbase/pull/20).
