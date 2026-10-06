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

Indexes: `by_application_requester [applicationId, requesterMembershipId]`, which also serves application-wide reads by ranging on `applicationId` alone, and `by_requester_operation [requesterMembershipId, operationId]`. The owner-scoped `demoCollections` and `demoRecords` are unchanged.

A second table, `requestCounts {applicationId, count}` with index `by_application [applicationId]`, holds one row per application. `create` reads and increments it, `remove` decrements it, and `fixtures:removeOrganization` deletes it. The cap check therefore reads one document, not the application's requests. Concurrent creates in one application still conflict on that row under Convex's optimistic concurrency, and Convex retries them one after another.

### Functions (`convex/requests.ts`)

Every function resolves the application principal first, so anonymous callers get `Unauthenticated` and outsiders, inactive members and other organizations get `APPLICATION_ACCESS_DENIED`. Argument validators are strict: `organizationId`, `requesterMembershipId`, `state`, `reviewerMembershipId`, `version` or any other extra argument fails with `ArgumentValidationError`.

| Function | Gate | Behavior |
| --- | --- | --- |
| `create({applicationId, definitionVersionId, operationId, values})` | `submitRequests` | Normalizes the values, then checks in order: grant, operation ID, duplicate, current version, values, application cap from `requestCounts`; then increments the count and inserts. Returns `{requestId, revision, version, created}` |
| `update({applicationId, requestId, expectedRevision, values})` | Own request and `submitRequests` | Replaces all values after normalizing them and validating them against the pinned version. An unchanged update returns the same revision and writes nothing |
| `remove({applicationId, requestId, expectedRevision})` | Own request and `submitRequests` | Deletes the request and decrements the count |
| `get({applicationId, requestId})` | Read rule | The request view, or `null` when it is missing, foreign or not readable |
| `list({applicationId, filters?, sort?, page?, pageSize?})` | Read rule | Validates the query before reading any request, then returns a page of readable requests with `total`, `page`, `pageSize`, `pageCount` and `scope` (`own` or `application`) |

The request view holds `_id`, `_creationTime`, `updatedAt`, `version`, `versionId`, `revision`, `state`, `values`, `requester: {membershipId, isMe}` and `canEdit`. It never returns `organizationId`, `policyPreset` or the operation fields.

### Read and edit rules

- The requester reads their own requests, even after losing `submitRequests`.
- A member with `readApplicationRecords` also reads every request whose own `policyPreset` is `requesterAssignedReviewerAndReaders`, drafts included. Under `requesterAndAssignedReviewer` the grant adds nothing. The preset comes from the request row, so publishing a version with another preset does not change older requests.
- `list` reports `scope: 'application'` only when the grant reaches past the caller's own requests: the current version uses the readers preset, or a readable request does. Under `requesterAndAssignedReviewer` a reader's list is labelled `own`.
- The reviewer branch of both presets covers submitted requests and arrives with #17. A reviewer sees no drafts.
- Only the requester edits or deletes, and only while holding `submitRequests`. Another member's request, a request of another application and a missing request all fail with `RECORD_NOT_FOUND`.

### Validation (`convex/requestValues.ts`)

`normalizeRequestValues(values)` runs first, on the server and in the demo form. It drops text that is empty or only spaces and stores `-0` as `0`. A blank optional value of any type is therefore stored as absent, and a blank required value fails as missing. The fingerprint and the unchanged-update check use the normalized values.

Field values are read only from the object's own keys, so a field named like a built-in object property (`toString`, `constructor`, `valueOf`) behaves like any other key in validation, filters and sorting.

`validateRequestValues(definition, values)` returns the first issue in this order. The server throws it; the demo runs the same function before submit.

1. A reserved key (`requester`, `requesterMembershipId`, `status`, `state`, `reviewer`, `reviewerMembershipId`, `version`, `versionId`, `createdAt`, `updatedAt`, `id`): `RECORD_FIELD_SERVER_OWNED`.
2. A key the pinned version does not define: `RECORD_FIELD_UNKNOWN`.
3. Each field in definition order: a missing value or blank text on a required field (`false` counts as present): `RECORD_FIELD_REQUIRED`; a blank optional value is skipped; a wrong type, `NaN` or an infinite number: `RECORD_FIELD_TYPE_INVALID`; text longer than `maxLength`: `RECORD_TEXT_TOO_LONG` with `maxLength`; a fraction on an integer field: `RECORD_NUMBER_NOT_INTEGER`; a number outside `[min, max]`: `RECORD_NUMBER_OUT_OF_RANGE` with `min` and `max`; a date that is not a real `YYYY-MM-DD` day in years 0001–9999 (checked by arithmetic, without `Date`): `RECORD_DATE_INVALID`.
4. The configured date rule: an end before its start fails with `RECORD_DATE_RANGE_INVALID` on the end key. The rule is skipped when either value is missing. Equal dates pass.
5. More than 8192 UTF-8 bytes of canonical JSON: `RECORD_TOO_LARGE`.

### Concurrency and duplicates

- A stale `expectedRevision` on `update` or `remove` fails with `RECORD_REVISION_CONFLICT` and `currentRevision`, and writes nothing.
- A `definitionVersionId` that is not the current version fails with `RECORD_DEFINITION_OUTDATED` and `currentVersionId`. An application without a published definition fails with `DEFINITION_NOT_FOUND`.
- An operation ID must match `^[A-Za-z0-9_-]{8,64}$` (`RECORD_OPERATION_ID_INVALID`). It is scoped to the caller's membership. Repeating it with the same version and values, in any key order, returns the original request with `created: false` and writes nothing. Repeating it with other values fails with `RECORD_OPERATION_CONFLICT`. The fingerprint covers the version, so the demo starts a new operation ID when "Load new version" moves the form to a newer version. An ID replayed after its request was deleted creates a new request; there is no ledger.

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
| Requests per application | 1000, counted in `requestCounts`; the 1001st create fails with `RECORD_APPLICATION_FULL`, and a delete frees a slot |
| Rows read per list | at most 1000 readable rows; more fail with `RECORD_BROWSE_LIMIT_EXCEEDED`, never a cut-off list |
| Page size | 1–100, default 20; a page past the end returns the last page |
| Filters | at most 10, combined with AND, on fields of the current version: text `$includes`, `$notIncludes`, `$eq`, `$ne`, `$empty`, `$notEmpty`; number and date `$eq`, `$ne`, `$gt`, `$gte`, `$lt`, `$lte`, `$empty`, `$notEmpty`; boolean `$isTruly`, `$isFalsy`. A date filter value must be a valid calendar date |
| Sort | one field of the current version or `_creationTime`, `asc` or `desc`; ties fall back to newest first, then ID; a missing value sorts last ascending |
| Operation ID | 8–64 characters from `A–Z a–z 0–9 - _` |

The backend accepts every filter in the table above. The demo list offers one of them: a date range on the configured date rule, with the start on or after one day and the end on or before another. Other filters are reachable only through direct calls in M1.5.

Requests are filtered, sorted and paged in memory after the authorized index read, because Convex cannot index the dynamic keys inside `values`. Filtering happens before paging, so `total` counts only readable matches. With at most 1000 requests of at most 8 KiB, one list reads under Convex's per-function read limit.

### Error codes

`REQUEST_ERROR_CODES` lists every code above plus `RECORD_NOT_FOUND`. `src/demo/actionErrors.ts` maps each to `requestErrors.<CODE>` in en-US and zh-CN, with the field's label from the pinned version and the `min`, `max` and `maxLength` from the error. Query codes reuse the existing `RECORD_QUERY_*` messages.

### Requests tab (`src/demo/RequestsPanel.tsx`, `src/demo/requestForm.ts`, `src/demo/requestModal.ts`)

The tab appears for any active member. With more than one application it shows an application select. When the current version has a date rule, a filter row above the table offers "<start field> on or after", "<end field> on or before" and "Clear dates"; native date inputs send the range to `list` as `$gte` and `$lte` filters, and a range with no match shows "No requests match these dates." The table builds its columns from the current version's `listColumns`: field labels in the active language, a system column titled by its own `builder.systemColumns.<key>` text, "Me" or "Member" plus the last six characters of the membership ID for the requester column, "—" for a value an older version does not have, then a `V{n}` version tag and Open and Delete buttons. Field columns sort on the server; paging offers 10, 20, 50 and 100 rows. The table keeps the previous page while the next one loads and shows the number of requests and the scope. An application without a published form shows an empty state.

"New request" (only with `submitRequests`) and Open show a modal form built from the pinned version, titled with "Version n" and "Revision n". Text uses an input with a character count (a text area above 200 characters), numbers an input with the range as help, booleans a switch, and dates a native `type="date"` input whose value is the `YYYY-MM-DD` string itself, so no time zone can shift it. Validation errors mark the field and move focus to it; other errors show an inline alert. A stale save shows a focused alert with "Keep my changes" (save again over the newer revision) and "Reload latest", and the form keeps the typed values. A create refused as outdated shows "Load new version", which keeps values for keys that still exist with the same type. Each create attempt pairs a version with a `crypto.randomUUID()` operation ID (`src/demo/requestModal.ts`): one is made when the form opens and kept across retries, and "Load new version" starts a new one. When the request or its pinned version cannot be loaded, for example after `APPLICATION_ACCESS_DENIED` or `DEFINITION_VERSION_NOT_FOUND`, the modal stops loading, shows the translated error in an alert and offers only Close. Escape and Cancel close the modal and return focus to the button that opened it. Readers see the form disabled. Delete asks for confirmation and sends the row's revision. Save and Delete rows turn antd motion off with the `withoutMotion` theme from `src/demo/pendingAction.ts`, shared with the #15 builder, so a fast rejection cannot leave a loading icon behind. Status messages use an `aria-live` output.

## Evidence

Revision exercised: `a0987cf8b4` on `claude/issue-16-review-fixes`, 2026-10-07, which applies the code and security review fixes to `integration/issue-16`; later commits change documentation only. Target: a fresh self-hosted Convex backend on loopback 3320/3321, instance `records16review`, its own SQLite and file store under `storage/records-16-review-*/`, set up with the [baseline runbook](baseline-13.md) (`convex deploy --env-file`, static JWKS, `SITE_URL` `http://localhost:5183`). Vite ran on 5183 against it. Each of the three request journey runs started Vite after deleting `node_modules/.vite/deps`, so dependencies were optimized from scratch every time.

### Commands

```sh
bunx vitest run -c vitest.demo.config.ts
node_modules/.bin/tsc --noEmit -p convex/tsconfig.json
bun run demo:typecheck
bun run demo:build
bun run quality:check --base origin/main
node_modules/.bin/convex deploy --env-file "$REQUEST_DIR/target.env" --typecheck=enable --codegen=disable -y
# With CONVEX_SELF_HOSTED_URL and CONVEX_SELF_HOSTED_ADMIN_KEY exported from "$REQUEST_DIR/target.env":
node_modules/.bin/convex codegen --typecheck=enable
rm -rf node_modules/.vite/deps   # before each journey run, with Vite stopped
VITE_CONVEX_URL=http://127.0.0.1:3320 VITE_CONVEX_SITE_URL=http://127.0.0.1:3321 \
  bun run demo:dev --host 127.0.0.1 --port 5183 --strictPort
REQUEST_DIR="$REQUEST_DIR" VITE_CONVEX_URL=http://127.0.0.1:3320 \
  VITE_CONVEX_SITE_URL=http://127.0.0.1:3321 DEMO_APP_URL=http://localhost:5183 bun run demo:request-journey
```

The regression journeys ran on the same target and Vite with the same three URLs, plus `MEMBERSHIP_DIR` and `DEFINITION_DIR` set to `$REQUEST_DIR`.

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
| Review fixes, built-in property keys (`toString`, `constructor`) in `requestValues`, `recordQuery` and `requestForm` tests | 3 tests failed: an omitted optional key read the inherited function |
| Review fixes, blank optional values | 5 tests failed: an optional `''` date got `RECORD_DATE_INVALID`, `normalizeRequestValues` did not exist, and a `'   '` note was stored |
| Review fixes, the form sending a `'   '` note | 1 test failed: the note was sent |
| Review fixes, a create in an application holding 30 requests | Failed: it read 30 request rows; it now reads 0 |
| Review fixes, `requests.by_application` removed from the schema with the test fake checking index names | 7 tests failed with `Unknown index requests.by_application` until `list` and fixture cleanup used `by_application_requester` |
| Review fixes, `list` scope and query validation | 3 tests failed: a reader under `requesterAndAssignedReviewer` got `application`, and a malformed query read 2 index ranges first |
| Review fixes, client helpers (`isRequestErrorCode`, `columnTitle`, `dateRangeFilters`, `requestModalStatus`, `newCreateAttempt`) | 3 tests failed on missing exports, and `requestModal.test.ts` failed to load the module |
| Review fixes, date filter text | 1 `i18n.test.ts` test failed without the `requests.filter*`, `clearFilter` and `noMatches` keys |

### Results

| Check | Outcome |
| --- | --- |
| Demo unit suite | 16 files, 320 tests passed: 39 in `requestValues.test.ts`, 36 in `requests.test.ts`, 56 in `recordQuery.test.ts`, 13 in `i18n.test.ts`, 9 in `requestForm.test.ts`, 6 in `requestModal.test.ts` |
| Convex and demo typecheck, demo build | Passed |
| `oxlint` on touched files | No diagnostics |
| `quality:check --base origin/main` | 26 changed files, 0 introduced diagnostics |
| `convex codegen` against the target | After `oxfmt`, `convex/_generated` is unchanged: `requestCounts` is a table, not a module, and `dataModel.d.ts` derives tables from the schema |
| Request journey, three runs, each from a fresh Vite dependency cache | 73/73, 73/73 and 73/73 checks passed; each exited 0. No run failed, so no failure needed a root cause |
| Regressions on the same target | `demo:verify` 24, `demo:journey` 18, `demo:collection-journey` 31, `demo:record-journey` 37, `demo:isolation-journey` 57, `demo:browse-journey` 18, `demo:membership-journey` 66/66, `demo:definition-journey` 30/30; all exited 0 on the first run |

Journey checks, expected equal to actual for every row:

| Area | Expected and actual |
| --- | --- |
| Forged identity and grants | Anonymous: `Unauthenticated`; inactive member and second organization: `APPLICATION_ACCESS_DENIED`; builder and reader without `submitRequests`: `PERMISSION_DENIED`; top-level `organizationId`, `requesterMembershipId`, `state`, `reviewerMembershipId`, `version`: `ArgumentValidationError`. No request rows before or after |
| Invalid values | `state`, `reviewerMembershipId`, `requester` in values: `RECORD_FIELD_SERVER_OWNED`; `approvedBy` and V2's `note` on V1: `RECORD_FIELD_UNKNOWN`; missing reason, string days, 1001-character reason, 400 days, 1.5 days, 2026-02-30, an ISO datetime and a reversed range each got their code; an object value: `ArgumentValidationError`; a two-letter operation ID: `RECORD_OPERATION_ID_INVALID`; another organization's version: `RECORD_DEFINITION_OUTDATED`. Each left the table unchanged |
| Create | The row holds A's membership, organization one, V1, the first preset, `draft`, revision 1 and the values |
| Duplicates | The same operation ID with reordered values returned the original ID with `created: false` and no write; with other values: `RECORD_OPERATION_CONFLICT` |
| Isolation | B, C and R got `null` for A's request and lists of 0, and R's list was labelled `own`; Z got `APPLICATION_ACCESS_DENIED`; B's update and delete and A's call through another application: `RECORD_NOT_FOUND` |
| Revisions | Update to revision 2; stale update and delete: `RECORD_REVISION_CONFLICT`; a reviewer value and a reversed range on update wrote nothing |
| Readers preset | In the readers application R read A's request (`isMe: false`, `canEdit: false`) and listed 1 with scope `application`; B (the reviewer) listed 0; R's delete: `RECORD_NOT_FOUND` |
| Paging | 25 of A's requests with 3 of B's interleaved; the `requestCounts` row read 28, equal to the rows, and 0 after the 28 deletes: 3 pages of 10, 10 and 5 by `days` ascending held days 1–25 exactly once; page 9 returned page 3 of 3; `startDate $gte 2026-05-21` by `days` descending returned 25, 24, 23, 22, 21; B listed only their 3; page size 101 and an invalid date filter got their codes |
| en-US, keyboard only, recorded | Empty state; a reversed range showed "End date must not be earlier than the start of the date range." under End date, focused it, and wrote nothing; the fixed form saved V1 with the exact values; focus returned to "New request"; after reload the row read Me, 2026-03-02, 2026-03-04, 3, V1 and the form reopened with the same values; an edit saved revision 2. In the date filter, "Start date on or after" 2026-03-03 hid the row and showed "No requests match these dates.", 2026-03-02 showed it again, "End date on or before" 2026-03-03 hid it, and "Clear dates" emptied both inputs and showed the row |
| V2 and V3 | C published V2 with an optional `note` field and column through `saveDraft` and `publish`; the Note column appeared with "—" for the V1 row; the V1 request reopened with only the V1 fields and "Version 1"; Escape returned focus to Open; a new form showed "Version 2" with Note. C published V3 while the form was open: the save was refused with the "newer version" alert and no write; "Load new version" kept every typed value and added Contact; the save created a V3 request with the note. The page sent two `requests:create` mutations for this form, read from its Convex WebSocket frames: their operation IDs differed, and the stored V3 request holds the second |
| Delete | The Popconfirm, reached from the keyboard, deleted the V3 request; only the V1 request remained |
| zh-CN, recorded | Chinese headers and cells (我, V1) and the filter labels 开始日期不早于 and 结束日期不晚于; a second client saved revision 3 while the form held "我的未保存修改"; Save showed the focused conflict alert, kept the input and wrote nothing; after each of 20 rejected saves the button was named "保存草稿" again within 2 seconds; "保留我的修改" then saved revision 4 with the typed reason; delete emptied the list |
| No page errors | None in either locale, apart from the expected failed-mutation logs |
| After the browser | B and R listed 0 of A's requests; Z got `APPLICATION_ACCESS_DENIED` |
| Cleanup | `removeOrganization` removed 1 request (readers application) and every fixture organization, application, membership, head, version and request count; 0 remained |

The modal's failed-query state has unit evidence only. Its reachable triggers, such as a deactivated membership, also remove the application from the member's list, which replaces the panel and closes the modal before a browser could observe it.

Evidence files (ignored build output, regenerated by each run) in `dist/request-journey/`: `en-US-requests.webm`, `zh-CN-requests.webm`, `en-US-{1-empty,2-reversed-range,3-created,3a-filtered-out,4-v1-reopened-after-v2,5-outdated,6-v3-created,7-deleted}.png`, `zh-CN-{1-list,2-conflict,3-kept-and-saved,4-empty-again}.png`, `{en-US,zh-CN}-console.log`, `persisted-requests.json` (request rows after the browser phase, IDs normalized) and `results.json`; red mode writes `results-red.json` instead. The target directory keeps a copy of each run: `runs/1/` holds run 1's `results.json`, screenshots, videos and console logs, `runs/2/` and `runs/3/` hold `results.json` and console logs, and `run2.log` and `run3.log` hold the console output. `dist/request-journey/` holds run 3's files.

## Retained resources

- `storage/records-16-review-*/`: the synthetic database, file store, private target configuration, JWKS, run ID, password, backend log, per-run journey evidence and regression logs. Do not upload it. Deleting the directory removes all of it.
- Better Auth retains the synthetic users and sessions that the journeys create; sign-out does not delete every session.
- `dist/request-journey/` and the other `dist/*-journey/` folders.

## Not covered

- Submission, reviewer assignment, decisions, decision history and the reviewer branch of the presets: #17. `state` stays the literal `draft`, so there is no "not a draft" error yet.
- Tombstones or an operation ledger; an operation ID replayed after delete creates a new request.
- Filters beyond the listed operators, filter controls other than the date range in the demo, indexes on dynamic fields, and more than 1000 requests per application.
- Whether `readApplicationRecords` under `requesterAssignedReviewerAndReaders` should see other members' **drafts**. ADR-0007 decides yes; the issue's outcome calls drafts the employee's own work before submission. This needs the spec owner's decision; if drafts stay private, #17 limits the reader branch to non-draft states.
- Migrating requests between versions; a request keeps its pinned version.
- A full designer, Feishu, ERP or CRM synchronization.
- The design proposed an antd `DatePicker`; the form uses a native date input instead, which keeps the value a plain `YYYY-MM-DD` string with no conversion step.
