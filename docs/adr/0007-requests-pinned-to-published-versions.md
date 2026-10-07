# Requests pinned to published definition versions

## Context

Issue #16 lets employees create, edit, list and delete draft requests through forms built from the published application definition (#15). A request must keep the version it started on, so a later version can add fields without changing older requests. Its identity, organization, version and state must come from the server. Two clients can edit one request, a client can retry a create, and the read rules must follow the policy preset that ADR-0006 stored but did not enforce. Convex cannot index the dynamic keys inside `values`.

## Decision

1. **One `requests` table, separate from the demo collections.** A row holds `applicationId`, `organizationId`, `requesterMembershipId`, `definitionVersionId`, `version`, `policyPreset`, `state`, `revision`, `operationId`, `operationFingerprint`, `values` and `updatedAt`. Only `values` comes from the caller. The owner-scoped `demoCollections` and `demoRecords` stay unchanged.
2. **Pinned at create, never migrated.** `create` takes the `definitionVersionId` the form was built from. If it is not the current version, the call fails with `RECORD_DEFINITION_OUTDATED` and `currentVersionId`, so a form never saves against fields it did not show. Updates validate against the pinned version row forever.
3. **The preset is copied onto the row.** `policyPreset` is copied from the pinned version at create, because published versions never change. Read rules use the row's preset, so a later version cannot widen or narrow access to earlier requests.
4. **Read rule: drafts stay private.** A draft is the employee's own work before submission, so only its requester reads it. The requester reads their own requests in every state. A member with `readApplicationRecords` also reads other members' requests whose preset is `requesterAssignedReviewerAndReaders`, but never a draft. Under `requesterAndAssignedReviewer` the grant adds nothing. The reviewer branch of both presets applies to submitted requests (ADR-0008).
5. **Edit rule.** Only the requester edits or deletes, only while holding `submitRequests`, and only while the request is a draft; a non-draft request fails with `REQUEST_STATE_CONFLICT` (ADR-0008). A request another member cannot read or edit, including another member's draft, returns the same `RECORD_NOT_FOUND` as a missing one; `get` returns `null`.
6. **Revisions.** `revision` starts at 1 and goes up by 1 on each changed update. `update` and `remove` take `expectedRevision`; a mismatch fails with `RECORD_REVISION_CONFLICT` and `currentRevision`. An unchanged update writes nothing.
7. **Duplicate creates by operation ID.** The client sends an `operationId` of 8 to 64 letters, digits, `-` or `_`, scoped to its membership. The server stores a SHA-256 fingerprint of the canonical JSON of `{definitionVersionId, values}`. The same ID with the same payload returns the original request with `created: false`; a different payload fails with `RECORD_OPERATION_CONFLICT`. Because the version is part of the payload, the demo makes a new ID when it moves a form to a newer version. There is no separate ledger, so an ID replayed after its request was deleted creates a new request.
8. **One pure validator.** Before validation and storage, `normalizeRequestValues` drops blank text and stores `-0` as `0`, so a blank optional value of any type is absent. `validateRequestValues` in `convex/requestValues.ts` then checks server-owned keys, unknown keys, required values, types, text length, number range and integers, calendar dates, the configured date rule and an 8 KiB size budget, in that order. The server throws its result; the demo runs it before submit.
9. **Bounded in-memory browsing.** A list first validates its filters, sort and page. It then reads the caller's own requests through `by_application_requester`, ranged on the application and requester. A caller with `readApplicationRecords` also reads the application's non-draft requests through `by_application_state`, as the two ranges below and above `draft`; other members' drafts are never loaded. Each range reads at most 1001 rows. The list keeps the rows the read rule allows, without duplicates, then filters, sorts and pages them with the existing `queryRecords`, so `total` counts only rows the caller may read. More than 1000 rows in a range or in the readable set fail with `RECORD_BROWSE_LIMIT_EXCEEDED`; nothing is dropped. The size budget keeps one list under Convex's per-function read limit. The list's `scope` is `application` only when a readable row belongs to another member; otherwise it is `own`.
10. **A counter row enforces the cap.** An application holds at most 1000 requests. One `requestCounts` row per application holds the count: `create` reads and increments it, and `remove` decrements it. The cap check reads one document instead of the application's requests. Concurrent creates in one application still conflict on that row under Convex's optimistic concurrency, so Convex retries them one after another.

## Rejected options

- **Extending `demoRecords`.** Its rows are owner-scoped and carry no application, membership or version, and its journeys depend on that shape.
- **Validating updates against the current version.** A V1 request would gain V2's fields or fail on rules it never showed.
- **Looking up the preset from the version row on every read.** It costs a read per row and gives the same answer, because version rows never change.
- **Counting requests by reading them.** Each create read up to 1001 rows, about 8 MiB, and conflicted with every other create in the application.
- **A count on the definition head.** Each create would rewrite the whole head document, draft included, and conflict with builder saves.
- **An operation ledger table.** It would also catch replays after delete, at the cost of a second table and its cleanup. The replay case is documented instead.
- **Letting readers read drafts under the readers preset.** The spec owner decided a draft stays the employee's own work until submission, so the grant reaches a request only once it leaves `draft`.
- **Reading the whole application and filtering drafts afterwards.** Other members' drafts would count toward the 1000-row browse limit and cost reads the caller can never see.

## Consequences

- ADR-0008 adds the submit and decision commands; generic `update` and `remove` refuse non-draft requests. Submitted requests under the readers preset reach readers through the existing `by_application_state` ranges.
- `fixtures:removeOrganization` deletes requests before definition versions and reports a `requests` count.
- `fixtures:removeOrganization` also deletes each application's `requestCounts` row.
- Raising the 1000-request cap or the 8 KiB budget needs a new read strategy, such as paginated index reads.
