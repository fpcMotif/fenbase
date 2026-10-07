# M1.4 versioned application definition

Issue: [#15](https://github.com/fpcMotif/fenbase/issues/15), parent [#1](https://github.com/fpcMotif/fenbase/issues/1). Decision record: [ADR-0006](../adr/0006-versioned-application-definitions.md). Glossary: `CONTEXT.md`, "Application Definition". Builds on [membership-14.md](membership-14.md).

## At a glance

Before #15 the leave application had no stored configuration, so nothing could pin a request to a definition. A builder with `configureApplication` now edits a draft with a revision number and publishes immutable versions through a keyboard-operable builder in English and Chinese. Application identity, membership rules and the owner-scoped demo are unchanged.

## Persisted contract

### Tables (`convex/schema.ts`)

| Table | Fields | Index |
| --- | --- | --- |
| `applicationDefinitions` (head, one per application) | `applicationId`, `organizationId`, `draft`, `revision`, `publishedRevision` (number or null), `currentVersionId` (ID or null), `latestVersion` (0 before the first publish), `updatedAt`, `updatedByMembershipId` | `by_application [applicationId]`, read with `.unique()` |
| `applicationDefinitionVersions` (insert-only) | `applicationId`, `organizationId`, `version` (1, 2, …), `definition`, `sourceRevision`, `publishedAt`, `publishedByMembershipId` | `by_application_version [applicationId, version]` |

`revision` starts at 1 on the first save and goes up by 1 on every changed save and every publish. The application row (`applications`) keeps its ID and organization across versions.

### Definition shape (`convex/definitionModel.ts`)

```text
{
  fields: Field[]                      // 1..30, array order is the form order
  listColumns: string[]                // 1..10 distinct field keys or system columns, in order
  dateRules: { startKey, endKey }[]    // 0..1, two different 'date' fields
  policyPreset: 'requesterAndAssignedReviewer' | 'requesterAssignedReviewerAndReaders'
  reviewerMembershipId: Id<'memberships'>
}
```

Every field has `type`, `key`, `label: {enUS, zhCN}` (1..120 characters after trim; `saveDraft` stores the trimmed text) and `required`.

The only system column is `requester`, the authenticated requester. A builder can place it in `listColumns` but cannot define or edit it as a field, because `requester` is a reserved key. A date rule records which fields form a range. #16 enforces "end on or after start" on record values; this ticket only stores the rule.

| Type | Bounds |
| --- | --- |
| `text` | `maxLength`, integer 1..4000 |
| `number` | finite `min <= max`, `integer`; integer fields need integer bounds |
| `boolean` | none |
| `date` | none; #16 checks record values as `YYYY-MM-DD` calendar dates without `Date` or UTC conversion |

Keys match `^[a-z][a-zA-Z0-9]{0,62}$`. Reserved keys: `requester`, `requesterMembershipId`, `status`, `state`, `reviewer`, `reviewerMembershipId`, `version`, `versionId`, `createdAt`, `updatedAt`, `id`. Every key in the current version must stay in the draft with the same type.

The leave reference definition (`scripts/leave-definition.ts`): `startDate` and `endDate` (date, required), `days` (number 1..366, integer, required, entered explicitly), `reason` (text up to 1000, required); list columns in that order; one date rule `startDate → endDate`; preset `requesterAndAssignedReviewer`.

### Functions (`convex/applicationDefinitions.ts`)

| Function | Gate | Behavior |
| --- | --- | --- |
| `getBuilderState({applicationId})` | `configureApplication` | Head (draft, revision, published revision, current version, latest version), the newest 100 versions with `versionsTruncated`, reviewer candidates (active members with `reviewRequests` among the first 100 members) with `reviewerCandidatesTruncated`, and the frozen published keys |
| `getPublishedVersion({applicationId, versionId?})` | Any active member | The frozen definition of `versionId`, or of the current version; `isCurrent` |
| `saveDraft({applicationId, expectedRevision, definition})` | `configureApplication` | `expectedRevision: 0` creates the head; otherwise it must equal the head revision. Labels are trimmed first. An identical draft writes nothing. Returns `{revision}` |
| `publish({applicationId, expectedRevision})` | `configureApplication` | Refuses a draft equal to the current version. Revalidates the draft and reviewer, inserts version `latestVersion + 1`, moves the pointer. Returns `{versionId, version, revision}` |

No function accepts `organizationId`, a version number or a publisher. Strict validators reject extra keys and unknown field types. Checks run before any write: principal, grant, head, revision, definition, reviewer.

### Error codes

| Code | When |
| --- | --- |
| `APPLICATION_ACCESS_DENIED`, `PERMISSION_DENIED` | Reused from #14: outsider or inactive member; member without `configureApplication` |
| `DEFINITION_NOT_FOUND` | Publish before any save; read with nothing published |
| `DEFINITION_REVISION_CONFLICT` (`currentRevision`) | Stale `expectedRevision` on save or publish, including the losing concurrent publish |
| `DEFINITION_NOTHING_TO_PUBLISH` | The draft has no changes since the last publish, or was edited back to equal the current version |
| `DEFINITION_VERSION_NOT_FOUND` | A version ID from another application |
| `DEFINITION_FIELD_TYPE_UNKNOWN`, `_KEY_INVALID`, `_KEY_DUPLICATE`, `_KEY_RESERVED`, `_COUNT_INVALID`, `_LABEL_INVALID`, `_BOUNDS_INVALID`, `_REMOVED`, `_TYPE_CHANGED` | Field rules above; all but the count carry `field` |
| `DEFINITION_LIST_COLUMNS_INVALID`, `DEFINITION_DATE_RULE_INVALID`, `DEFINITION_POLICY_INVALID`, `DEFINITION_REVIEWER_INVALID` | Layout, date rule, preset and reviewer rules |

`src/demo/actionErrors.ts` maps each `DEFINITION_*` code to `definitionErrors.<CODE>` in en-US and zh-CN.

### Builder UI (`src/demo/DefinitionBuilder.tsx`)

The "Application builder" tab appears for members whose `listMine` grants include `configureApplication`. Each field is a `fieldset` named "Field n" with key, type, both labels, required, its bounds, and Move up, Move down and Remove buttons. Key, type and Remove are locked for the row that carries a published key. Labels must be 1..120 characters after trim. List columns, the date rule and the reviewer are searchable selects; the list offers "Requester (system)" before the fields, and the date range needs both a start and an end or neither. The policy is a radio group. Save draft submits the form; Publish asks for confirmation. Both buttons stop loading when the call returns, not when the toast closes. Their row turns antd motion off, so the loading icon leaves without an animation; see "Stuck loading icon" below. A label error marks the language that is invalid. Notices appear when the version or reviewer list is truncated. The form reloads from the server only when it has no unsaved edits. A revision conflict shows a focused alert with "Reload latest". Field error codes mark the matching control; other codes show a message. Reviewers appear as "Member" plus the last six characters of the membership ID, with "(you)" for the caller; no member names are exposed.

### Seed

`seedLeaveDefinition` (`scripts/demo-definition-seed.ts`, CLI `bun run demo:definition-seed`) signs in as a builder and calls `saveDraft(0)` then `publish` only when the application has no head. With any head, including one a builder edited, it returns `skipped` and writes nothing. A racing seed loses with a revision conflict. It creates no records or runs.

## Evidence

Revision exercised: `fd04277bbe` on `claude/issue-15-spinner`, 2026-10-07, which carries the review fixes and the stuck-loading-icon fix. Later commits on the branch change documentation only. The review fixes were first exercised at `dcda10d6dc8a5c1ae8a949844185950d99fb467d` and the first implementation at `351bfe61bbd0ba0f42e29cf11318f6ea3fe07f54`; the earlier red runs come from those revisions. Target: a self-hosted Convex backend on loopback 3310/3311, instance `definition15`, its own SQLite and file store under `storage/definition-15-*/`, set up with the [baseline runbook](baseline-13.md) (`convex deploy --env-file`, static JWKS). Vite ran on 5173 against it.

### Commands

```sh
bunx vitest run -c vitest.demo.config.ts
node_modules/.bin/tsc --noEmit -p convex/tsconfig.json
bun run demo:typecheck
bun run demo:build
node_modules/.bin/convex deploy --env-file "$DEFINITION_DIR/target.env" --typecheck=enable --codegen=disable -y
DEFINITION_DIR="$DEFINITION_DIR" VITE_CONVEX_URL=http://127.0.0.1:3310 \
  VITE_CONVEX_SITE_URL=http://127.0.0.1:3311 DEMO_APP_URL=http://localhost:5173 bun run demo:definition-journey
```

`DEFINITION_DIR` holds `target.env`, `run-id` and `password` (mode 600, never printed). `DEFINITION_JOURNEY_MODE=red` runs only the HTTP phase and writes `results-red.json`.

### Red before green

| Run | Outcome |
| --- | --- |
| `definitionModel.test.ts` before `definitionModel.ts` existed | Suite failed to load the module |
| `applicationDefinitions.test.ts` against handlers that threw "not implemented" | 24 of 24 tests failed, including every unauthorized, invalid and stale publish |
| Fixture cascade test before `removeOrganization` deleted definitions | Failed: no `definitions` or `definitionVersions` counts |
| `i18n.test.ts` before `actionErrors.ts` existed | Suite failed to load the module |
| Journey HTTP phase against the backend deployed from `83a9de1e6f` (no definition functions) | 8 of 10 checks failed with `FunctionNotFound`; the row-count and cleanup checks passed |
| Review fixes, `applicationDefinitions.test.ts` against `e997370f06` | A second date rule was accepted; padded labels were stored untrimmed; a draft edited back to the current version published a duplicate version; more than 100 members threw `MEMBERSHIP_LIST_LIMIT_EXCEEDED`; no `versionsTruncated` flag |
| Review fixes, `definitionModel.test.ts` against `e997370f06` | `listColumns` rejected the system `requester` column |
| Review fixes, `definitionForm.test.ts` against stubs with the old behavior | 5 of 8 failed: untrimmed labels, the English label marked for a Chinese label error, a half-chosen date range accepted, and Save/Publish pending until the toast closed (timed out) |
| Review fixes, `i18n.test.ts` before the new keys | `builder.versionLabel` was missing |
| Journey check `ui.zh.save-button-settles-after-rejected-saves` at `f57bcc8963`, before the fix | Failed: the Save button settled after 2 of 20 rejected saves, then kept its loading icon |

### Results

| Check | Outcome |
| --- | --- |
| Demo unit suite | 12 files, 209 tests passed: 30 in `applicationDefinitions.test.ts`, 24 in `definitionModel.test.ts`, 8 in `definitionForm.test.ts`, 7 in `i18n.test.ts`, 2 in `demo-definition-seed.test.ts` |
| Convex and demo typecheck, demo build, `quality:check --base origin/main` | Passed; the quality gate reported 0 introduced diagnostics |
| `convex codegen` against the target | After `oxfmt`, no change to `convex/_generated/` |
| Definition journey | 30/30 checks passed in each of 3 runs, each in a new Vite session started after deleting `node_modules/.vite/deps` |
| Regressions on the same target | `demo:membership-journey` 66/66, `demo:verify` 24, `demo:journey` 18, `demo:collection-journey` 31, `demo:record-journey` 37, `demo:isolation-journey` 57, `demo:browse-journey` 18; all passed and exited 0 |

Journey checks, expected equal to actual for every row:

| Area | Expected and actual |
| --- | --- |
| HTTP denials | A save and publish: `PERMISSION_DENIED`; Z: `APPLICATION_ACCESS_DENIED`; unknown field type and a spoofed `organizationId`: `ArgumentValidationError`; reviewer without `reviewRequests` and reviewer from another organization: `DEFINITION_REVIEWER_INVALID`; duplicate key: `DEFINITION_FIELD_KEY_DUPLICATE`. No definition rows before or after |
| en-US, keyboard only, recorded | D built V1 and saved; the persisted draft deep-equals the leave definition; after reload and reopen every control matched; publish created V1 from revision 1 |
| V2 | D added optional text `note`, added it to the list and switched the reviewer from B to C; save, reload and reopen matched; publish created V2 |
| Immutability | The V1 row was byte-for-byte equal before and after V2 and after a later V3; the pointer moved to V2 on the same application |
| Read API | Requester A read V2 as current through `getPublishedVersion` |
| zh-CN, recorded | Builder controls and V2 reopened with Chinese labels; a duplicate `reason` key showed `键名 reason 被多个字段使用。` on field 6 with no write; after each of 20 rejected saves the button was named "保存草稿" again within 2 seconds, with no write; after E saved over HTTP, the browser's stale save showed the focused conflict alert, wrote nothing, and "加载最新草稿" restored E's draft |
| No page errors | None in either locale, apart from the expected failed-mutation logs |
| Concurrency | D and E published from the same revision with `Promise.allSettled`: one succeeded, one got `DEFINITION_REVISION_CONFLICT`, exactly one version was added |
| Seed | First run `created` (revision 2, V1); D edited the draft; the CLI run returned `skipped` (revision 3) and the rows were unchanged |
| Cleanup | `removeOrganization` removed 1 head and 3 versions (org one), 1 head and 1 version (seed org) and nothing for org two; 0 fixture organizations, applications, memberships, heads or versions remained |

Evidence files (ignored build output, regenerated by each run) in `dist/definition-journey/`: `en-US-builder.webm`, `zh-CN-builder.webm`, `en-US-{1-empty-builder,2-v1-filled,3-v1-reopened,4-v1-published,5-v2-published}.png`, `zh-CN-{1-builder,2-duplicate-key,3-conflict,4-reloaded-latest}.png`, `persisted-definition.json` (head and versions after V2, IDs normalized) and `results.json`. `results-red.json` is written only by a red run.

### Stuck loading icon

Before `fd04277bbe`, the zh-CN step failed intermittently: after the rejected duplicate-key save, `getByRole('button', { name: '保存草稿', exact: true })` timed out because the button's accessible name stayed "loading 保存草稿". This was a builder bug, not a Vite cache effect. It reproduced in warm Vite sessions, and a debug loop of 30 rejected saves on the real builder left the icon stuck 11 times.

The cause is antd 5's Button (5.24.2; 5.29.3 has the same code). It animates its loading icon with rc-motion and removes the icon only on `transitionend`, with no deadline. A traced failure showed the sequence:

1. At 92 ms, `loading` became true. The icon mounted in the `enter-start` step with width 0.
2. At 124 ms, the mutation had rejected and `loading` was false. `ant-btn-loading` left the button, so React state was correct. The icon moved to `leave-start` (width 14px) before its enter motion reached an active frame.
3. At 133 ms, `leave-active` set the width back to 0 before the transition had advanced. Chrome fired `transitioncancel` for width, opacity and margin, and never fired `transitionend`.

rc-motion stayed in `leave-active`, so the icon stayed. The page screenshot started later, at 582 ms, and did not cause the cancel. The race needs a rejection within a frame or two of the click, which the local backend makes common.

The fix turns antd motion off (`theme.token.motion: false`) for the Save and Publish row, so the icon is removed as soon as `loading` ends. The journey check `ui.zh.save-button-settles-after-rejected-saves` repeats the rejected save 20 times. At a stuck rate near 1 in 3, an unfixed builder almost always fails it.

Every other pending antd button in `src/demo` uses the same `withoutMotion` theme from `src/demo/pendingAction.ts`. In `src/demo/App.tsx` that covers sign-in, Load sample, the record row Edit and Delete, Delete empty collection, Create collection, collection settings Save, the record dialog Save, workflow Run and Create workflow. The record dialog Save hit this race in `demo:record-journey` about once in 142 rejected saves. The journey check `save-button-settles-after-rejected-saves` now repeats the rejected create 20 times in each locale. Before the fix, a 150-save version of that check left the icon stuck after 121 settled saves; after the fix, 150 of 150 settled in both locales.

## Retained resources

- `storage/definition-15-*/`: the synthetic database, file store, private target configuration, JWKS, run ID, password, logs and journey output. Do not upload it. Deleting the directory removes all of it.
- Better Auth retains the synthetic users and sessions that the journeys create: 6 users per definition journey run and 12 users with 28 sessions from the membership journey. Sign-out does not delete every session.
- `dist/definition-journey/` and the other `dist/*-journey/` folders.

## Not covered

- Rendering request forms and lists from published versions, the requester column, calendar-date and date-rule validation of request values, pinning requests to a version, and the read side of the policy presets are delivered by #16 ([records-16.md](records-16.md)). The request form reads its pinned version through `getPublishedVersion`.
- Re-checking the reviewer at submit and decision time, the reviewer side of the policy presets, and the effects of a reviewer change: #17.
- Excluded by the issue: drag and drop, a full schema editor, expression or script engines, destructive field migrations, holiday or leave-balance logic, and Feishu.
