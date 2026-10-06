# M1.5 draft requests rendered from the published definition

Issue: [#16](https://github.com/fpcMotif/fenbase/issues/16), parent [#1](https://github.com/fpcMotif/fenbase/issues/1). Decision record: [ADR-0007](../adr/0007-requests-pinned-to-published-versions.md). Glossary: `CONTEXT.md`, "Requests". Builds on [definition-15.md](definition-15.md) and [membership-14.md](membership-14.md).

## At a glance

Employees with `submitRequests` now create, edit, list, reopen and delete draft requests in a Requests tab. The form and the list come from the published definition; no code path names the leave application. Each request is pinned to the version it was created with, so a V1 request keeps its V1 form after V2 is published. The server owns identity, version, policy, state and revision. Submission and review are #17.

## Runtime contract

### Table (`convex/schema.ts`)

| Field | Owner |
| --- | --- |
| `applicationId`, `organizationId`, `requesterMembershipId` | Server, from the application principal |
| `definitionVersionId`, `version` | Server; the current version at create, which the client must confirm |
| `policyPreset` | Server; copied from the pinned version at create |
| `state` | Server; always `draft` in #16 |
| `revision` | Server; 1 at create, +1 on every changed update |
| `operationId` | Client; `operationFingerprint` is computed by the server |
| `values` | Client; validated against the pinned version |
| `updatedAt` | Server |

Indexes: `by_application [applicationId]`, `by_application_requester [applicationId, requesterMembershipId]`, `by_requester_operation [requesterMembershipId, operationId]`. The owner-scoped `demoCollections` and `demoRecords` are unchanged.

### Functions (`convex/requests.ts`)

Every function resolves the application principal first, so anonymous callers get `Unauthenticated` and outsiders, inactive members and other organizations get `APPLICATION_ACCESS_DENIED`. Argument validators are strict: `organizationId`, `requesterMembershipId`, `state`, `reviewerMembershipId`, `version` or any other extra argument fails with `ArgumentValidationError`.

| Function | Gate | Behavior |
| --- | --- | --- |
| `create({applicationId, definitionVersionId, operationId, values})` | `submitRequests` | Checks in order: grant, operation ID, duplicate, current version, values, application cap; then inserts. Returns `{requestId, revision, version, created}` |
| `update({applicationId, requestId, expectedRevision, values})` | Own request and `submitRequests` | Replaces all values after validating them against the pinned version. An unchanged update returns the same revision and writes nothing |
| `remove({applicationId, requestId, expectedRevision})` | Own request and `submitRequests` | Deletes the request |
| `get({applicationId, requestId})` | Read rule | The request view, or `null` when it is missing, foreign or not readable |
| `list({applicationId, filters?, sort?, page?, pageSize?})` | Read rule | A page of readable requests with `total`, `page`, `pageSize`, `pageCount` and `scope` (`own` or `application`) |

The request view holds `_id`, `_creationTime`, `updatedAt`, `version`, `versionId`, `revision`, `state`, `values`, `requester: {membershipId, isMe}` and `canEdit`. It never returns `organizationId`, `policyPreset` or the operation fields.

### Read and edit rules

- The requester reads their own requests, even after losing `submitRequests`.
- A member with `readApplicationRecords` also reads every request whose own `policyPreset` is `requesterAssignedReviewerAndReaders`, drafts included. Under `requesterAndAssignedReviewer` the grant adds nothing. The preset comes from the request row, so publishing a version with another preset does not change older requests.
- The reviewer branch of both presets covers submitted requests and arrives with #17. A reviewer sees no drafts.
- Only the requester edits or deletes, and only while holding `submitRequests`. Another member's request, a request of another application and a missing request all fail with `RECORD_NOT_FOUND`.

### Validation (`convex/requestValues.ts`)

`validateRequestValues(definition, values)` returns the first issue in this order. The server throws it; the demo runs the same function before submit.

1. A reserved key (`requester`, `requesterMembershipId`, `status`, `state`, `reviewer`, `reviewerMembershipId`, `version`, `versionId`, `createdAt`, `updatedAt`, `id`): `RECORD_FIELD_SERVER_OWNED`.
2. A key the pinned version does not define: `RECORD_FIELD_UNKNOWN`.
3. Each field in definition order: a missing value or blank text on a required field (`false` counts as present): `RECORD_FIELD_REQUIRED`; a wrong type, `NaN` or an infinite number: `RECORD_FIELD_TYPE_INVALID`; text longer than `maxLength`: `RECORD_TEXT_TOO_LONG` with `maxLength`; a fraction on an integer field: `RECORD_NUMBER_NOT_INTEGER`; a number outside `[min, max]`: `RECORD_NUMBER_OUT_OF_RANGE` with `min` and `max`; a date that is not a real `YYYY-MM-DD` day in years 0001–9999 (checked by arithmetic, without `Date`): `RECORD_DATE_INVALID`.
4. The configured date rule: an end before its start fails with `RECORD_DATE_RANGE_INVALID` on the end key. The rule is skipped when either value is missing. Equal dates pass.
5. More than 8192 UTF-8 bytes of canonical JSON: `RECORD_TOO_LARGE`.

### Concurrency and duplicates

- A stale `expectedRevision` on `update` or `remove` fails with `RECORD_REVISION_CONFLICT` and `currentRevision`, and writes nothing.
- A `definitionVersionId` that is not the current version fails with `RECORD_DEFINITION_OUTDATED` and `currentVersionId`. An application without a published definition fails with `DEFINITION_NOT_FOUND`.
- An operation ID must match `^[A-Za-z0-9_-]{8,64}$` (`RECORD_OPERATION_ID_INVALID`). It is scoped to the caller's membership. Repeating it with the same version and values, in any key order, returns the original request with `created: false` and writes nothing. Repeating it with other values fails with `RECORD_OPERATION_CONFLICT`. An ID replayed after its request was deleted creates a new request; there is no ledger.

### Exact bounds

| Bound | Value |
| --- | --- |
| Fields per definition | 1–30 (#15) |
| List columns | 1–10 field keys or the system `requester` column (#15) |
| Date rules | at most 1 (#15) |
| Text | at most the field's `maxLength`, which is 1–4000 (#15) |
| Numbers | finite, within the field's `[min, max]`, whole when `integer` is set |
| Dates | `YYYY-MM-DD`, years 0001–9999, Gregorian leap years |
| Request size | 8192 UTF-8 bytes of canonical JSON `values` |
| Requests per application | 1000; the 1001st create fails with `RECORD_APPLICATION_FULL` |
| Rows read per list | at most 1000 readable rows; more fail with `RECORD_BROWSE_LIMIT_EXCEEDED`, never a cut-off list |
| Page size | 1–100, default 20; a page past the end returns the last page |
| Filters | at most 10, combined with AND, on fields of the current version: text `$includes`, `$notIncludes`, `$eq`, `$ne`, `$empty`, `$notEmpty`; number and date `$eq`, `$ne`, `$gt`, `$gte`, `$lt`, `$lte`, `$empty`, `$notEmpty`; boolean `$isTruly`, `$isFalsy`. A date filter value must be a valid calendar date |
| Sort | one field of the current version or `_creationTime`, `asc` or `desc`; ties fall back to newest first, then ID; a missing value sorts last ascending |
| Operation ID | 8–64 characters from `A–Z a–z 0–9 - _` |

Requests are filtered, sorted and paged in memory after the authorized index read, because Convex cannot index the dynamic keys inside `values`. Filtering happens before paging, so `total` counts only readable matches. With at most 1000 requests of at most 8 KiB, one list reads under Convex's per-function read limit.

### Error codes

`REQUEST_ERROR_CODES` lists every code above plus `RECORD_NOT_FOUND`. `src/demo/actionErrors.ts` maps each to `requestErrors.<CODE>` in en-US and zh-CN, with the field's label from the pinned version and the `min`, `max` and `maxLength` from the error. Query codes reuse the existing `RECORD_QUERY_*` messages.

### Requests tab (`src/demo/RequestsPanel.tsx`, `src/demo/requestForm.ts`)

The tab appears for any active member. With more than one application it shows an application select. The table builds its columns from the current version's `listColumns`: field labels in the active language, "Me" or "Member" plus the last six characters of the membership ID for the requester column, "—" for a value an older version does not have, then a `V{n}` version tag and Open and Delete buttons. Field columns sort on the server; paging offers 10, 20, 50 and 100 rows. The table keeps the previous page while the next one loads and shows the number of requests and the scope. An application without a published form shows an empty state.

"New request" (only with `submitRequests`) and Open show a modal form built from the pinned version, titled with "Version n" and "Revision n". Text uses an input with a character count (a text area above 200 characters), numbers an input with the range as help, booleans a switch, and dates a native `type="date"` input whose value is the `YYYY-MM-DD` string itself, so no time zone can shift it. Validation errors mark the field and move focus to it; other errors show an inline alert. A stale save shows a focused alert with "Keep my changes" (save again over the newer revision) and "Reload latest", and the form keeps the typed values. A create refused as outdated shows "Load new version", which keeps values for keys that still exist with the same type. A new `crypto.randomUUID()` operation ID is made each time the form opens and kept across retries. Escape and Cancel close the modal and return focus to the button that opened it. Readers see the form disabled. Delete asks for confirmation and sends the row's revision. Save and Delete rows turn antd motion off, as in #15, so a fast rejection cannot leave a loading icon behind. Status messages use an `aria-live` output.

## Evidence

Revision exercised: `10f8b9f36c` on `claude/issue-16-impl`, 2026-10-07; later commits change documentation only. Target: a self-hosted Convex backend on loopback 3310/3311, instance `records16`, its own SQLite and file store under `storage/records-16-*/`, set up with the [baseline runbook](baseline-13.md) (`convex deploy --env-file`, static JWKS). Vite ran on 5173 against it.

### Commands

```sh
bunx vitest run -c vitest.demo.config.ts
node_modules/.bin/tsc --noEmit -p convex/tsconfig.json
bun run demo:typecheck
bun run demo:build
bun run quality:check --base origin/main
node_modules/.bin/convex deploy --env-file "$REQUEST_DIR/target.env" --typecheck=enable --codegen=disable -y
REQUEST_DIR="$REQUEST_DIR" VITE_CONVEX_URL=http://127.0.0.1:3310 \
  VITE_CONVEX_SITE_URL=http://127.0.0.1:3311 DEMO_APP_URL=http://localhost:5173 bun run demo:request-journey
```

`REQUEST_DIR` holds `target.env`, `run-id` and `password` (mode 600, never printed). `REQUEST_JOURNEY_MODE=red` runs only the HTTP phases and writes `results-red.json`. The browser types dates as year, month and day digits, the order Chrome used for the native date input on the recording machine; a machine with another system date order needs another digit order.

### Red before green

| Run | Outcome |
| --- | --- |
| `requestValues.test.ts` before `requestValues.ts` existed | Suite failed to load the module |
| `recordQuery.test.ts` date cases before the `date` field type | 13 of 13 date tests failed |
| `requests.test.ts` before `requests.ts` existed | Suite failed to load the module |
| `requestForm.test.ts` before `requestForm.ts` existed | Suite failed to load the module |
| `i18n.test.ts` before the request messages | 3 tests failed: missing codes, bound interpolation and error data |
| Journey HTTP phases against the backend deployed from `8da5c2693f` (no request functions) | 41 of 43 checks failed with `FunctionNotFound`; the empty-table and cleanup checks passed |
| Journey `ui.en-US.no-page-errors` before clearing only shown field errors | Failed: rc-field-form logged "There may be circular references" when the form reset an empty error list on every change |

### Results

| Check | Outcome |
| --- | --- |
| Demo unit suite | 15 files, 299 tests passed: 33 in `requestValues.test.ts`, 32 in `requests.test.ts`, 55 in `recordQuery.test.ts`, 12 in `i18n.test.ts`, 6 in `requestForm.test.ts` |
| Convex and demo typecheck, demo build | Passed |
| `quality:check --base origin/main` | 22 changed files, 0 introduced diagnostics |
| `convex codegen` against the target | After `oxfmt`, `convex/_generated/api.d.ts` gains only the `requests` and `requestValues` modules |
| Request journey | 70/70 checks passed |
| Regressions on the same target | `demo:verify` 24, `demo:journey` 18, `demo:collection-journey` 31, `demo:record-journey` 37, `demo:isolation-journey` 57, `demo:browse-journey` 18, `demo:membership-journey` 66/66, `demo:definition-journey` 30/30; all exited 0. The first browse run failed with a React `createRoot` warning because files were reformatted during the run and Vite hot-reloaded the entry; the rerun with unchanged files passed |

Journey checks, expected equal to actual for every row:

| Area | Expected and actual |
| --- | --- |
| Forged identity and grants | Anonymous: `Unauthenticated`; inactive member and second organization: `APPLICATION_ACCESS_DENIED`; builder and reader without `submitRequests`: `PERMISSION_DENIED`; top-level `organizationId`, `requesterMembershipId`, `state`, `reviewerMembershipId`, `version`: `ArgumentValidationError`. No request rows before or after |
| Invalid values | `state`, `reviewerMembershipId`, `requester` in values: `RECORD_FIELD_SERVER_OWNED`; `approvedBy` and V2's `note` on V1: `RECORD_FIELD_UNKNOWN`; missing reason, string days, 1001-character reason, 400 days, 1.5 days, 2026-02-30, an ISO datetime and a reversed range each got their code; an object value: `ArgumentValidationError`; a two-letter operation ID: `RECORD_OPERATION_ID_INVALID`; another organization's version: `RECORD_DEFINITION_OUTDATED`. Each left the table unchanged |
| Create | The row holds A's membership, organization one, V1, the first preset, `draft`, revision 1 and the values |
| Duplicates | The same operation ID with reordered values returned the original ID with `created: false` and no write; with other values: `RECORD_OPERATION_CONFLICT` |
| Isolation | B, C and R got `null` for A's request and lists of 0; Z got `APPLICATION_ACCESS_DENIED`; B's update and delete and A's call through another application: `RECORD_NOT_FOUND` |
| Revisions | Update to revision 2; stale update and delete: `RECORD_REVISION_CONFLICT`; a reviewer value and a reversed range on update wrote nothing |
| Readers preset | In the readers application R read A's request (`isMe: false`, `canEdit: false`) and listed 1; B (the reviewer) listed 0; R's delete: `RECORD_NOT_FOUND` |
| Paging | 25 of A's requests with 3 of B's interleaved: 3 pages of 10, 10 and 5 by `days` ascending held days 1–25 exactly once; page 9 returned page 3 of 3; `startDate $gte 2026-05-21` by `days` descending returned 25, 24, 23, 22, 21; B listed only their 3; page size 101 and an invalid date filter got their codes |
| en-US, keyboard only, recorded | Empty state; a reversed range showed "End date must not be earlier than the start of the date range." under End date, focused it, and wrote nothing; the fixed form saved V1 with the exact values; focus returned to "New request"; after reload the row read Me, 2026-03-02, 2026-03-04, 3, V1 and the form reopened with the same values; an edit saved revision 2 |
| V2 and V3 | C published V2 with an optional `note` field and column through `saveDraft` and `publish`; the Note column appeared with "—" for the V1 row; the V1 request reopened with only the V1 fields and "Version 1"; Escape returned focus to Open; a new form showed "Version 2" with Note. C published V3 while the form was open: the save was refused with the "newer version" alert and no write; "Load new version" kept every typed value and added Contact; the save created a V3 request with the note |
| Delete | The Popconfirm, reached from the keyboard, deleted the V3 request; only the V1 request remained |
| zh-CN, recorded | Chinese headers and cells (我, V1); a second client saved revision 3 while the form held "我的未保存修改"; Save showed the focused conflict alert, kept the input and wrote nothing; after each of 20 rejected saves the button was named "保存草稿" again within 2 seconds; "保留我的修改" then saved revision 4 with the typed reason; delete emptied the list |
| No page errors | None in either locale, apart from the expected failed-mutation logs |
| After the browser | B and R listed 0 of A's requests; Z got `APPLICATION_ACCESS_DENIED` |
| Cleanup | `removeOrganization` removed 1 request (readers application) and every fixture organization, application, membership, head and version; 0 remained |

Evidence files (ignored build output, regenerated by each run) in `dist/request-journey/`: `en-US-requests.webm`, `zh-CN-requests.webm`, `en-US-{1-empty,2-reversed-range,3-created,4-v1-reopened-after-v2,5-outdated,6-v3-created,7-deleted}.png`, `zh-CN-{1-list,2-conflict,3-kept-and-saved,4-empty-again}.png`, `{en-US,zh-CN}-console.log`, `persisted-requests.json` (request rows after the browser phase, IDs normalized), `results.json` and `results-red.json`.

## Retained resources

- `storage/records-16-*/`: the synthetic database, file store, private target configuration, JWKS, run ID, password, logs and regression logs. Do not upload it. Deleting the directory removes all of it.
- Better Auth retains the synthetic users and sessions that the journeys create; sign-out does not delete every session.
- `dist/request-journey/` and the other `dist/*-journey/` folders.

## Not covered

- Submission, reviewer assignment, decisions, decision history and the reviewer branch of the presets: #17. `state` stays the literal `draft`, so there is no "not a draft" error yet.
- Tombstones or an operation ledger; an operation ID replayed after delete creates a new request.
- Filters beyond the listed operators, indexes on dynamic fields, and more than 1000 requests per application.
- Migrating requests between versions; a request keeps its pinned version.
- A full designer, Feishu, ERP or CRM synchronization.
- The design proposed an antd `DatePicker`; the form uses a native date input instead, which keeps the value a plain `YYYY-MM-DD` string with no conversion step.
