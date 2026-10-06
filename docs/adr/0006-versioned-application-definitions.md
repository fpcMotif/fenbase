# Versioned application definitions

## Context

Issue #15 lets a builder configure the leave application's fields, list columns, date rule, policy preset and reviewer, then publish it. Requests created later (#16, #17) must keep the version they started on, so a published version can never change. Two builders can edit at once, and Convex has no unique constraints or multi-row locks beyond optimistic concurrency on the rows a mutation reads.

## Decision

1. **One head row plus insert-only versions.** `applicationDefinitions` holds one row per application: the editable `draft`, a `revision` counter, `publishedRevision`, `currentVersionId` and `latestVersion`. `applicationDefinitionVersions` holds one row per publish. No code path patches, replaces or deletes a version row; only `fixtures:removeOrganization` deletes them, with the whole fixture organization.
2. **Every write goes through the head row.** `saveDraft` and `publish` read the head and take `expectedRevision`. A mismatch returns `DEFINITION_REVISION_CONFLICT` with `currentRevision`. Because both mutations read and write the same head row, Convex optimistic concurrency serializes concurrent publishes; the loser re-runs, sees the new revision and gets the conflict. No builder's work is replaced without an error.
3. **The draft is always on the head.** There is no separate "create draft" step and no editing/published state machine. After a publish the head's draft is the next draft. `publish` returns `DEFINITION_NOTHING_TO_PUBLISH` when `publishedRevision === revision` or when the draft equals the current version, so an edit followed by a revert adds no version. Saving an identical draft writes nothing.
4. **Published keys are frozen.** Every field key in the current version must stay in the draft with the same type (`DEFINITION_FIELD_REMOVED`, `DEFINITION_FIELD_TYPE_CHANGED`). This rules out destructive field migrations, which the issue excludes.
5. **Checks before writes, in a fixed order.** Principal, `configureApplication`, head lookup, revision, definition validation, reviewer eligibility, then writes. A rejected save or publish leaves the head, the pointer and every version unchanged.
6. **The reviewer is a membership ID checked at save and publish.** It must be an active membership of the same application with `reviewRequests`. The check is point-in-time; #17 re-checks at submit and decision time.
7. **Policy presets name #14 grants only.** `requesterAndAssignedReviewer` and `requesterAssignedReviewerAndReaders` are stored and validated here; #16 and #17 enforce them.

## Rejected options

- **A version row that is patched in place, or a "published" flag on the draft.** Either lets a later edit change what an in-flight request was created against.
- **A draft row per builder or per version with `createDraft`/`createNextDraft` mutations.** It adds a state machine and three error codes without covering any extra acceptance case.
- **Conflict detection by version number only.** A stale save would overwrite another builder's unpublished draft without an error.

## Consequences

- #16 and #17 read the frozen definition through `applicationDefinitions.getPublishedVersion`, by version ID or the current pointer.
- Renaming or retyping a published field needs a future migration design; the freeze blocks it today.
- `fixtures:removeOrganization` must keep deleting versions and heads before applications.
