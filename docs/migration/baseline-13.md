# M1.1 baseline evidence and runbook

Issue: [#13](https://github.com/fpcMotif/fenbase/issues/13), parent [#1](https://github.com/fpcMotif/fenbase/issues/1). Inventory: [feature-map.md](feature-map.md).

## Inspected state

- Date: 2026-10-03, Australia/Perth. Source revision: `0cfb7b558e27dfb6d6ff3459c12a20eb91175f3f`, branch `main`; tracked and untracked working tree initially clean. This change is documentation only, so the exercised application code remains that revision.
- `AGENTS.md` read; no root `AGENTS.local.md`. Routing ADR-0001 and Oxc ADR-0004 remain applicable. No source runtime or import boundary changed.
- Node `v26.10.0`, Bun `1.4.3`, Convex CLI `1.46.0`, Vite `8.3.1`, Vitest `5.0.2`. Node/Bun resolve through `/etc/profiles/per-user/martinfan/bin` (Nix profile). No tracked shell environment wrapper was found. `portless.json` names `fenbase`; this run uses explicit ports.
- Both `bun.lock` and `yarn.lock` are tracked and preserved. Installed `node_modules` were reused; no install/upgrade performed. `.node-version` asks for 22, `engines.node` for >=22, and Volta still names 20.16.0/Yarn 1.22.19; `packageManager` names Yarn 1.22.22. This run does not claim to reconcile that tooling drift.
- `yarn` is unavailable. Docker CLI exists, but its OrbStack daemon socket is unavailable. Existing OA installation/data and remote ERP/CRM installations are therefore unverified, not absent.
- Selected runtime: existing standalone `src/demo/` React/Vite frontend, root `/`, with real Convex and Better Auth. It is not a replacement for the retained Legacy/Modern client runtimes.

## Isolated target and preservation

A new self-hosted local Convex backend used loopback **3310** (API) / **3311** (HTTP/auth), instance `baseline13`, a fresh `storage/baseline-13/backend.sqlite3`, and separate `storage/baseline-13/files`. Vite used **5173**. No SAP, Salesforce, Feishu, cloud deployment credential, OA seed, or source data export was needed.

Before starting, SHA-256 fingerprints covered 70 existing files under `.convex/`, `.env`, `.env.local`, and `storage/oa-demo/`. All 70 matched after verification. The source Convex backend and OA runtime were never started or written to. Source Docker/remote data was not inspected; file fingerprints do not establish remote database contents.

One failed setup attempt used `convex dev --env-file ... --once`: despite the custom target file, it rewrote `.env.local`, and deployment stopped because `JWKS` was unset. `.env.local` was restored **byte-for-byte against its original fingerprint**. All subsequent pushes used `convex deploy --env-file` on the explicit loopback target. No ignored environment file remains changed. The runbook below avoids the failed approach and backs up the file before any CLI operation.

## Reproduce start and setup

Run from the repository root, using existing installed dependencies and an available Convex backend binary. The inspected cached binary is `~/.cache/convex/binaries/precompiled-2026-09-28-5c7cb5b/convex-local-backend`. Its version and CLI flags were inspected locally; a fresh machine needs the corresponding backend provisioned first. Installed Google Chrome is required by these existing journeys. This is an installed-dependency baseline, not a verified clean dependency installation.

First verify 3310, 3311 and 5173 are unused. Use a fresh directory per run; do not point at `.convex/local/default` or OA storage. In terminal A:

```sh
umask 077
BASELINE_DIR=$(mktemp -d "$PWD/storage/baseline-13-XXXXXX")
BASELINE_BINARY="$HOME/.cache/convex/binaries/precompiled-2026-09-28-5c7cb5b/convex-local-backend"
cp -p .env.local "$BASELINE_DIR/original.env.local"
BASELINE_SECRET=$(openssl rand -hex 32)
BASELINE_KEY=$("$BASELINE_BINARY" keygen admin-key \
  --instance-name baseline13 --instance-secret "$BASELINE_SECRET")
printf "CONVEX_SELF_HOSTED_URL='http://127.0.0.1:3310'\nCONVEX_SELF_HOSTED_ADMIN_KEY='%s'\n" \
  "$BASELINE_KEY" > "$BASELINE_DIR/target.env"
printf '%s' "$BASELINE_SECRET" > "$BASELINE_DIR/instance-secret"
unset BASELINE_KEY
"$BASELINE_BINARY" --interface 127.0.0.1 --port 3310 --site-proxy-port 3311 \
  --instance-name baseline13 --instance-secret "$BASELINE_SECRET" \
  --local-storage "$BASELINE_DIR/files" --disable-beacon "$BASELINE_DIR/backend.sqlite3" \
  > "$BASELINE_DIR/backend.log" 2>&1
```

Keep the server in that terminal; Ctrl-C stops it. In terminal B, set `BASELINE_DIR` to the exact directory created above (its path is not a secret), then:

```sh
node_modules/.bin/convex env set --env-file "$BASELINE_DIR/target.env" SITE_URL http://localhost:5173
openssl rand -hex 32 | node_modules/.bin/convex env set \
  --env-file "$BASELINE_DIR/target.env" BETTER_AUTH_SECRET
node_modules/.bin/convex env set --env-file "$BASELINE_DIR/target.env" JWKS '[]'
node_modules/.bin/convex deploy --env-file "$BASELINE_DIR/target.env" --typecheck enable --codegen disable
node_modules/.bin/convex run --env-file "$BASELINE_DIR/target.env" auth:getLatestJwks > "$BASELINE_DIR/jwks.json"
node_modules/.bin/convex env set --env-file "$BASELINE_DIR/target.env" JWKS < "$BASELINE_DIR/jwks.json"
node_modules/.bin/convex deploy --env-file "$BASELINE_DIR/target.env" --typecheck enable --codegen disable
cmp .env.local "$BASELINE_DIR/original.env.local"
VITE_CONVEX_URL=http://127.0.0.1:3310 VITE_CONVEX_SITE_URL=http://127.0.0.1:3311 \
  bun run demo:dev --host 127.0.0.1 --port 5173 --strictPort
```

`JWKS='[]'` is only a bootstrap value for this fresh target; replace it with the action result before running journeys. Treat that result as secret material: Better Auth uses private signing-key documents. `CONVEX_SITE_URL` is supplied by the backend's site origin; frontend `VITE_CONVEX_SITE_URL` points at 3311. `SITE_URL` is the allowed frontend origin (`http://localhost:5173`). The isolated admin key contains a pipe and must be quoted in shell-compatible files. Do not print environment/key files or commit them.

## Verified journeys and checks

In terminal C, set these non-secret overrides so Bun/Vite cannot use the existing cloud configuration:

```sh
export VITE_CONVEX_URL=http://127.0.0.1:3310
export VITE_CONVEX_SITE_URL=http://127.0.0.1:3311
export DEMO_APP_URL=http://localhost:5173
bun run demo:journey
bun run demo:collection-journey
bun run demo:record-journey
bun run demo:isolation-journey
bun run demo:browse-journey
bun run demo:typecheck
node_modules/.bin/tsc --noEmit -p convex/tsconfig.json
bun run demo:build
```

All five journeys ran against the real isolated target; none used `DEMO_JOURNEY_ALLOW_REMOTE`.

| Check | Observed outcome at inspected revision | Local evidence |
| --- | --- | --- |
| #2 auth | **18 checks passed**, English/Chinese sign-in, invalid password, keyboard navigation, reload, sign-out, anonymous/session/token replay denial | `storage/baseline-13/auth.log`; `dist/demo-journey/` screenshots |
| #3 collections | **31 checks passed**, create/configure/rename/reopen/delete, invalid inputs and nonempty deletion behavior, both locales | `storage/baseline-13/collection.log`; `dist/collection-journey/` |
| #4 records | **37 checks passed**, primitive CRUD, persisted reload, validation and denied access, both locales | `storage/baseline-13/record.log`; `dist/record-journey/results.json` and screenshots |
| #5 isolation | **57 checks passed**, direct cross-owner and anonymous denial, unchanged owner resources after denial, browser account replacement clears prior data/forms | `storage/baseline-13/isolation.log`; `dist/isolation-journey/results.json` and screenshots |
| #6 browsing | **18 checks passed**, 25-row pagination reconciliation, combined filters/sorts, stable ties, boundaries and translated errors | `storage/baseline-13/browse.log`; `dist/browse-journey/results.json` and screenshots |
| Typechecking | Demo and Convex both passed | `typecheck.log`, `convex-typecheck.log` in baseline directory |
| Build | Passed; existing >500 kB chunk warning | `storage/baseline-13/build.log` |
| Focused unit file | `recordQuery.test.ts`: **41 passed** | `storage/baseline-13/focused.log` |
| Full Convex unit suite | **5 files / 82 tests passed**, files sequential | `storage/baseline-13/convex-tests.log` |

The rendered English record screen after reload was also inspected: saved values, selected collection, filter/sort controls, and visible keyboard focus rendered correctly. Local artifact directories predate this run and can contain older files (including old failure screenshots); only this run's log/result outputs and freshly written journey screenshots establish the results above. This committed report is the durable sanitized evidence; local images/databases are ignored, not published credentials or production evidence.

The default test wrapper fails before discovery: `bun run test convex/__tests__/recordQuery.test.ts --run --maxWorkers=1` invokes removed `--poolOptions.threads.singleThread=true`, yielding `Unknown option --poolOptions` with installed Vitest 5. The required `yarn test` command cannot run because Yarn is absent. For existing Convex tests, this temporary ignored configuration was used:

```sh
cat > storage/baseline-13/vitest.config.mts <<'CONFIG'
export default { test: { include: ['convex/__tests__/*.test.ts'], maxWorkers: 1, fileParallelism: false } };
CONFIG
node_modules/.bin/vitest run --config storage/baseline-13/vitest.config.mts convex/__tests__/recordQuery.test.ts
node_modules/.bin/vitest run --config storage/baseline-13/vitest.config.mts
```

No new tests or behavioral changes were introduced; the established journeys and existing test seams were reused. The full upstream suite is not claimed green. The final repository-wide attempt `bun run test --run --maxWorkers=1` failed before discovery with the same removed `--poolOptions` option (`storage/baseline-13/full-suite.log`). No upstream tests ran.

Required scoped checks were attempted: `bun run lint docs/migration/feature-map.md docs/migration/baseline-13.md` reported no lintable files (exit 1). `bun run format '!**/*' docs/migration/feature-map.md docs/migration/baseline-13.md` reported all files excluded; the exclusion prevents the root format script from rewriting unrelated files. Markdown is deliberately excluded by ADR-0004 and `.oxfmtrc.json`; these are not passing code checks. Documentation was checked manually and with `git diff --check`.

Review verification: `bun scripts/migrate-verify.ts --json` initially exposed a documentation regression: its literal `Convex Target` / `Effect Schema` check failed after the inventory rewrite. The labels were restored with accurate implementation status; `CHK-DOC-01` now passes. The verifier still fails `CHK-CFL-01` because it parses `wrangler.jsonc` using `JSON.parse`; that config and code were unchanged. Its Effect/Query passes only exercise the placeholder wrappers and are not stack-adoption evidence. Before/after JSON reports are retained in the baseline directory.

Known baseline warnings: Node's experimental localStorage message, Vite's future native-config-loader warning, bundle chunk size, and Bun's `directory mismatch ... tsconfig.demo.json` diagnostic after successful tsconfig-override journeys (exit 0). These occurred without source changes and are not hidden regressions.

## Cleanup and retained resources

Final direct table reads on the isolated target found **zero** `demoCollections`, `demoRecords`, `demoWorkflows`, and `demoWorkflowRuns`; Better Auth retained **8 synthetic users and 16 session documents**. Journey sign-outs do not delete every session created by all browser/API contexts. They are explicitly retained in the isolated database, not represented as fully purged authentication state.

- Retain `storage/baseline-13/`: synthetic database/file store, private target configuration and JWKS, fingerprints, logs, temporary unit-test config, and sanitized cleanup counts. Permissions restrict the directory; do not upload it wholesale.
- Retain fresh journey screenshots/results under `dist/{demo,collection,record,isolation,browse}-journey/`, and the rebuilt `dist/demo` output. These are ignored build/evidence artifacts.
- Existing `.env`, `.env.local`, `.convex/` and OA runtime credentials are unchanged after verification. Existing OA/source fixtures and data were not deleted or reseeded.
- Both baseline servers were stopped after verification and their listening ports checked. To reproduce cleanup, stop Vite and the baseline backend with Ctrl-C in their own terminals. Confirm 5173/3310/3311 no longer listen with `lsof -nP -iTCP -sTCP:LISTEN`; do not stop unrelated servers. Reopening the backend with the same database, instance name and private instance secret retains its synthetic state.
- After evidence is no longer needed, deleting **only the newly created baseline directory** removes its synthetic users, sessions, database, files and keys. Preserve the existing `.convex/local/default`, OA credentials and Docker volumes. Never use `docker compose down -v` as baseline cleanup.

Next executable ticket: **#10** (Oxc enforcement/staging safety and existing tooling failures), then #14 once its prerequisites are met. CRM/ERP discovery remains access-limited; no absent production instance, completed leave application, or retirement is inferred.
