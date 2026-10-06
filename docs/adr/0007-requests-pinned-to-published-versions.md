# Requests pinned to published definition versions

## Context

Issue #16 lets employees create, edit, list and delete draft requests through forms built from the published application definition (#15). A request must keep the version it started on, so a later version can add fields without changing older requests. Its identity, organization, version and state must come from the server. Two clients can edit one request, a client can retry a create, and the read rules must follow the policy preset that ADR-0006 stored but did not enforce. Convex cannot index the dynamic keys inside `values`.

## Decision

1. **One `requests` table, separate from the demo collections.** A row holds `applicationId`, `organizationId`, `requesterMembershipId`, `definitionVersionId`, `version`, `policyPreset`, `state`, `revision`, `operationId`, `operationFingerprint`, `values` and `updatedAt`. Only `values` comes from the caller. The owner-scoped `demoCollections` and `demoRecords` stay unchanged.
2. **Pinned at create, never migrated.** `create` takes the `definitionVersionId` the form was built from. If it is not the current version, the call fails with `RECORD_DEFINITION_OUTDATED` and `currentVersionId`, so a form never saves against fields it did not show. Updates validate against the pinned version row forever.
3. **The preset is copied onto the row.** `policyPreset` is copied from the pinned version at create, because published versions never change. Read rules use the row's preset, so a later version cannot widen or narrow access to earlier requests.
4. **Read rule.** The requester reads their own requests. A member with `readApplicationRecords` also reads every request whose preset is `requesterAssignedReviewerAndReaders`, drafts included. Under `requesterAndAssignedReviewer` the grant adds nothing. The reviewer branch of both presets applies to submitted requests and arrives with #17.
5. **Edit rule.** Only the requester edits or deletes, and only while holding `submitRequests`. A request another member cannot read or edit returns the same `RECORD_NOT_FOUND` as a missing one; `get` returns `null`.
6. **Revisions.** `revision` starts at 1 and goes up by 1 on each changed update. `update` and `remove` take `expectedRevision`; a mismatch fails with `RECORD_REVISION_CONFLICT` and `currentRevision`. An unchanged update writes nothing.
7. **Duplicate creates by operation ID.** The client sends an `operationId` of 8 to 64 letters, digits, `-` or `_`, scoped to its membership. The server stores a SHA-256 fingerprint of the canonical JSON of `{definitionVersionId, values}`. The same ID with the same payload returns the original request with `created: false`; a different payload fails with `RECORD_OPERATION_CONFLICT`. There is no separate ledger, so an ID replayed after its request was deleted creates a new request.
8. **One pure validator.** `validateRequestValues` in `convex/requestValues.ts` checks server-owned keys, unknown keys, required values, types, text length, number range and integers, calendar dates, the configured date rule and an 8 KiB size budget, in that order. The server throws its result; the demo runs it before submit.
9. **Bounded in-memory browsing.** A list reads at most 1000 rows through `by_application` or `by_application_requester`, filters them by the read rule, then filters, sorts and pages them with the existing `queryRecords`. More than 1000 rows fail with `RECORD_BROWSE_LIMIT_EXCEEDED`; nothing is dropped. An application holds at most 1000 requests, and the size budget keeps one list under Convex's per-function read limit.

## Rejected options

- **Extending `demoRecords`.** Its rows are owner-scoped and carry no application, membership or version, and its journeys depend on that shape.
- **Validating updates against the current version.** A V1 request would gain V2's fields or fail on rules it never showed.
- **Looking up the preset from the version row on every read.** It costs a read per row and gives the same answer, because version rows never change.
- **An operation ledger table.** It would also catch replays after delete, at the cost of a second table and its cleanup. The replay case is documented instead.
- **A state guard in #16.** `state` is the literal `draft` today, so a "not a draft" error could never fire. #17 widens the state and adds the guard.

## Consequences

- #17 widens `state`, adds submit and decision commands, and must stop generic `update` and `remove` from touching non-draft requests.
- `fixtures:removeOrganization` deletes requests before definition versions and reports a `requests` count.
- Raising the 1000-request cap or the 8 KiB budget needs a new read strategy, such as paginated index reads.
