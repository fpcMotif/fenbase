# Issue 10 tooling evidence

## At a glance

The previous gate missed typed violations and could replace partially staged changes.
Shared snapshot checks now enforce introduced code locally and in required CI.
Existing application compiler settings, warning debt, and commit-message checks remain unchanged.

## Supported toolchain

Use Bun 1.4.2 with the committed bun.lock and Node 22.12.0 or newer.
Repository dependencies pin Oxlint 1.86.0, Oxfmt 0.71.0, and oxlint-tsgolint 7.0.2003.
Vitest 1.5.2 matches the existing NocoBase runner and coverage packages.
Tests using the previously selected Vitest 5 failed on unsupported pool arguments.

Root installation uses `bun install --frozen-lockfile`.
A fresh installation populated 4,367 packages in 20.43 seconds on macOS ARM64.
A separate integration checkout completed the same installation in 26.83 seconds.
Both used empty dependency directories and stable Bun 1.4.2.
Local Node was 26.10.0; CI verifies Node 22 separately.

Automatic frontend, Windows, and quality workflows use frozen Bun installations.
Manual legacy workflows still use Yarn; historical yarn.lock remains for those consumers.
Umi and Convex still resolve transitive ESLint, Prettier, and related packages.
Removing reachable lock entries would break installation.
Direct root, docs, and scaffold lint commands use Oxc.
The existing blame-ignore entry retains the original mechanical Oxfmt migration commit.
This follow-up contains behavioral changes, so it adds no formatting-only blame exclusion.

## Commands and boundaries

| Command | Checked source | Behavior |
| --- | --- | --- |
| `bun run pre-commit` | Staged index snapshot | Formats and licenses snapshot files; updates index after checks pass. |
| `bun run quality:check --staged` | Staged index snapshot | Checks introduced diagnostics without changing the index. |
| `bun run quality:check --base <revision>` | Committed HEAD snapshot | Compares introduced diagnostics against the merge base. |
| `bun run lint:typeaware` | All tracked typed-scope files | Reports existing debt; exits nonzero while findings remain. |
| `bun scripts/lint-ratchet.ts` | Ordinary full-tree scope | Rejects increases against existing per-file, per-rule counts. |
| `bun scripts/lint-ratchet.ts --update` | Ordinary full-tree scope | Only lowers counts after a successful complete scan. |
| `bun scripts/check-client-imports.ts` | Client-v2 source | Rejects static imports from the legacy client runtime. |
| `bun run quality:test` | Disposable repositories | Exercises actual checker commands and Git hooks. |

Typed scope includes scripts, Convex, src/demo, and E2E directories.
Generated workspace aliases target staged snapshot sources.
Snapshots replace their root TypeScript configuration and remove nested configurations.
These operations never change application compiler configurations.
The native engine otherwise discovers incompatible legacy configuration despite an explicit `--tsconfig` argument.

Policy diagnostics use syntax-aware spans, including multiline annotations.
Deleted lines never exempt newly added violations within the same diff hunk.
Valid targeted suppressions remain effective.
Void return types and the void-zero sentinel remain valid.
Missing tools, malformed output, configuration errors, and crashes always fail the gate.

The hook preserves unstaged working-tree bytes, including partially staged files.
Binary index entries are preserved.
Working files update only when raw-content Git blob hashes match their original index entries.
Canonical paths exclude working-file and parent-directory symlinks from those writes.
Staged symlinks are rejected explicitly.
The existing license-header tool and commit-message hook remain active.
The hk configuration disables automatic staging and stashing because the snapshot hook updates index blobs itself.

The runtime-boundary check ignores `__tests__`, `lib`, `dist`, and `esm` directories.
That exclusion covers the seven existing client-v2 test imports and also exempts new test files.
All other client-v2 static imports remain checked.
Dynamic imports and computed module loading are outside this static-import check.

## Behavioral verification

| Check | Observed result |
| --- | --- |
| Quality regression suite | 16 tests, 78 assertions passed under stable Bun. |
| Existing Oxc fixtures | Five cases passed. |
| Staged and committed-base fixtures | Floating promises and async void calls fail; corrections pass. |
| Multiline policy fixtures | Added `any` is rejected even across multiline spans. |
| Partial staging through actual Git hooks | Success and failure preserve unrelated working-tree bytes. |
| Binary partial staging | Different invalid UTF-8 bytes remain distinct; unstaged bytes survive the commit. |
| Working-tree symlinks | File and parent-directory links retain their external target bytes after formatting staged content. |
| Filename and snapshot fixtures | Newlines, shell characters, binary blobs, and license headers survive. |
| Dependency snapshot fixture | Staged Promise types are checked instead of unstaged replacement types. |
| Configuration symlink fixture | Snapshot replacement preserves both external targets and source symlinks. |
| Docs accessibility fixture | Missing button type fails; explicit button type passes. |
| Docs plugin fixture | Font-display violations fail only within docs; corrected display strategy passes. |
| Failure handling fixtures | Missing binaries, crashes, malformed JSON, and baseline increases fail. |
| Runtime boundary fixture | Forbidden v2-to-v1 import fails; corrected import passes. |
| Hook and promise fixtures | Invalid hooks and misused promises fail; void types and void-zero pass. |
| Ordinary full-tree ratchet | 3,108 existing warnings; no regression. |
| NocoBase Convex wrapper | Five files and 82 tests passed sequentially. |
| Demo validation | Typecheck and production build passed; existing large-chunk warning remains. |
| hk staged check | Passed against the full implementation diff in a disposable Git checkout. |

The existing CLI helper suite still contains a machine-specific `/Users/chen` path expectation.
That unrelated assertion fails on this machine.
The CLI entry-error suite passes five tests.

## Typed debt and cost

The complete audit checks 438 files and reports 40 existing findings without configuration errors.
Thirty-nine findings are typed rules; one is an ordinary escape warning.
Existing findings outside introduced spans remain deferred debt.
The audit is informational for rollout measurement, while introduced violations block merges.

Measurements used macOS ARM64, stable Bun 1.4.2, and installed dependencies.
These are observed single runs, not performance guarantees.
Peak RSS comes from macOS `/usr/bin/time -l` and includes child processes.

| Scope | Files | Findings | Wall time | Peak RSS |
| --- | ---: | ---: | ---: | ---: |
| Scripts | 29 | 5 | 1.28 s | 653 MiB |
| Demo | 3 | 12 | 1.75 s | 507 MiB |
| Convex | 23 | 0 | 0.80 s | 494 MiB |
| E2E | 386 | 23 | 1.09 s | 521 MiB |
| Complete snapshot and audit | 438 | 40 | 14.34 s | 714 MiB |

Per-scope measurements include declaration inputs; the complete audit excludes declaration files.
Scripts report four floating promises and one unnecessary escape.
Demo reports twelve misused promises.
E2E reports twenty await-thenable, two misused-promise, and one floating-promise findings.

## Docs and generated application

Docs frozen installation populated 754 packages in 4.15 seconds with lifecycle scripts disabled.
The root docs command now invokes Bun; lint passes with seven existing warnings.
Docs formatting checks pass across 142 matched files.
The prepared docs build produced 3,745 files.
Its index.html contains 27,634 bytes; llms.txt contains 284,232 bytes.
Building requires tsconfig.paths.json from root postinstall.
An initial build without that prerequisite failed; the prepared build passed.
Docs build verification used host Bun 1.4.3 and Node 26.10.0.

The actual generator created a fresh application using `--empty-key`.
Stable Bun installed its 3,114 packages in 43.76 seconds, including the application postinstall.
A frozen reinstall passed.
Generated lint and format checks passed with the final template exclusions.
Package manifests and generated tsconfig.paths.json are excluded from scaffold formatting.
Generator instructions now show Bun commands and require Node 22.12.0 or newer.
A deliberate syntax error failed lint; correcting it restored success.
A formatting fixture failed before formatting and passed afterward.
Application startup and database installation were outside this tooling check.

## Rule parity and intentional exceptions

The introduced-code policy restores supported historical root recommended rules.
It includes JavaScript-only undefined-variable checks and TypeScript-specific style checks.
Promise always-return remains off, matching the previous explicit exception.
The new-code any and async-void checks are separate from historical full-tree policy.
E2E disables React hooks checks because Playwright uses a callback named `use`.
Ordinary warning severities differ from some historical errors; the ratchet still rejects new counts.

Oxlint lacks React no-deprecated, so that check remains a coverage exception.
React prop-types was historically disabled; unsupported off entries must be omitted to avoid configuration errors.
JSX use-marker rules belong to ESLint variable tracking and have no direct Oxc configuration names.
The four TypeScript ESLint v5-only recommendations are not inferred from transitive packages.
The historical direct lock selected v6, whose recommended preset differs.

The [docs rule inventory](tooling-10-docs-rules.md) lists every historical Biome recommendation and remaining docs differences.
Available mappings alone do not prove semantic equivalence.
Unsupported CSS, GraphQL, and JavaScript checks remain explicit coverage exceptions.
Oxfmt sorting does not establish equivalence with Biome's semantic import organization.
Automatic import organization is therefore a documented removal.

## CI and merge enforcement

[PR 20](https://github.com/fpcMotif/fenbase/pull/20) carries the implementation and live check history.
[The required ruleset](https://github.com/fpcMotif/fenbase/rules/24572580) requires `Oxlint & Oxfmt Checks` on main.
It requires the latest base and has no bypass actors.
The check is bound to the GitHub Actions application.

[The negative run](https://github.com/fpcMotif/fenbase/actions/runs/37447518733) failed on an intentionally introduced floating promise.
The diagnostic identified `scripts/issue10-ci-negative.ts:5:1` and `typescript(no-floating-promises)`.
The fixture was removed afterward; its commit remains auditable in PR history.
[The initial passing run](https://github.com/fpcMotif/fenbase/actions/runs/37447148616) verifies the implementation before that negative proof.
[The corrected run](https://github.com/fpcMotif/fenbase/actions/runs/37447884888) passed every quality step after fixture removal.

Dependency Review is separate from the required quality check.
Its API returned 403 because GitHub does not support dependency review for this fork.
The action remains configured; this provider limitation is not represented as a successful dependency audit.
See [GitHub's dependency-review API documentation](https://docs.github.com/en/rest/dependency-graph/dependency-review).
