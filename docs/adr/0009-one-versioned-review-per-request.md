# One versioned review per request

## Context

Issue #17 lets a requester submit a draft request and one reviewer approve or reject it. The requester can also withdraw a pending request. The reviewer comes from the published version the request is pinned to (ADR-0006, ADR-0007). Two people can act on one request at the same moment, clients retry, and a reviewer can lose access while a request waits. The state change, the review task and the audit history must never disagree. Multi-stage review, delegation, reopening and a workflow graph are out of scope.

## Decision

1. **Four explicit commands.** `requestReviews.submit`, `approve`, `reject` and `withdraw` each take `{applicationId, requestId, expectedRevision, operationId}` and return `{requestId, state, revision, eventId, replayed}`. The transitions are `draft → pending` (submit), `pending → approved | rejected` (approve, reject) and `pending → withdrawn` (withdraw). Every other combination fails with `REQUEST_STATE_CONFLICT` and `currentState` and `currentRevision`. `approved`, `rejected` and `withdrawn` are terminal.
2. **One mutation writes everything.** A command patches the request (state, revision + 1, times, and the reviewer at submit), opens or closes its review task, and appends one event. Convex commits all of it or none of it, so a failed submit leaves a draft with no task and no event.
3. **One row is both the review task and the execution.** `reviewTasks` holds one row per submitted request, keyed by the request, with the reviewer, pinned version and a status of `pending`, `completed` or `cancelled`. Its fields are the "persisted progress tied to this request and version" the issue asks for. The spec owner accepted this single row for #17. No scheduler or durable-workflow component runs. The #8 `demoWorkflows` and `demoWorkflowRuns` stay separate and unchanged.
4. **The reviewer is copied at submit.** Submit loads the pinned version, never the current head, checks the stored values against it again, and copies its `reviewerMembershipId` onto the request and the task. Publishing a later version with another reviewer therefore never moves an existing request. Submit fails with `REQUEST_SELF_REVIEW` when that reviewer is the requester and with `REQUEST_REVIEWER_UNAVAILABLE` when they are not an active member holding `reviewRequests`.
5. **Fixed check order.** Each command resolves the principal (`Unauthenticated` or `APPLICATION_ACCESS_DENIED`), validates the operation ID (`RECORD_OPERATION_ID_INVALID`), loads the request under the read rule (`RECORD_NOT_FOUND`), checks the role, looks up a replay, then checks the state, then the revision (`RECORD_REVISION_CONFLICT`).
   - Submit and withdraw need the requester holding `submitRequests`.
   - Approve and reject fail with `REQUEST_SELF_REVIEW` for the requester. Otherwise they need the assigned reviewer holding `reviewRequests`.
   - Any other role failure is `PERMISSION_DENIED`.
6. **Operation IDs are scoped to the actor.** The event row stores the operation ID and a SHA-256 fingerprint of `{command, applicationId, requestId, expectedRevision}`, indexed by actor membership and operation ID. The same ID with the same payload returns the stored result with `replayed: true` and writes nothing, even after the request became terminal. The same ID with another payload fails with `RECORD_OPERATION_CONFLICT`. The replay lookup runs after the principal, read and role checks. A caller who lost access since the first call therefore gets the same denial as any other unauthorized call, and a caller whose access returns gets the original result again. Create IDs keep their own scope on the `requests` row (ADR-0007), so one ID can name one create and one command.
7. **Races resolve on the request row.** Every command reads and patches the request row, so Convex's optimistic concurrency runs competing commands one after another. The loser runs again, sees the new state and fails with `REQUEST_STATE_CONFLICT`. Concurrent duplicates of one operation also conflict on the event index range, and the rerun returns the replay.
8. **Generic edits stop at the draft.** `requests.update` and `requests.remove` fail with `REQUEST_STATE_CONFLICT` for a non-draft request, after the ownership and grant checks and before the revision check. Their arguments cannot name state, requester, reviewer or version.
9. **Read rule.** The assigned reviewer reads a submitted request while holding `reviewRequests`. `requestReviews.inbox` reads the reviewer's `pending`, `completed` or `cancelled` tasks through `by_reviewer_status`, at most 100 rows plus a `truncated` flag, so the reviewer can reopen decided and withdrawn requests. `requestReviews.history` returns the first 100 events plus a `truncated` flag to anyone who may read the request.

## Rejected options

- **Separate task and execution tables.** Both would hold the same keys and status, written in the same mutation. A `requestExecutions` table can be split out later if a reviewer needs it.
- **A durable workflow or scheduler.** A single review needs no waiting process; the pending task row is the durable state.
- **Resolving the reviewer from the version on every read.** It costs a read per row, and the inbox would have no index to read by reviewer.
- **An operation ledger keyed on the request row.** The request row holds only its create operation; decisions need their own scope per actor.
- **Letting withdraw skip `submitRequests`.** If the reviewer loses access, the requester still holds the grant and can withdraw. If the requester loses the grant, the reviewer can still decide. Requiring the grant matches the #16 edit rule.
- **Returning a replay to a caller who lost access.** A replay reveals nothing the actor did not already receive, but the spec owner chose one rule for every call: access is checked on the current membership and grants, replay or not. A deactivated reviewer or a requester without `submitRequests` is refused.

## Consequences

- A pending request whose reviewer became inactive or lost `reviewRequests` stays pending. Only the requester's withdraw ends it; reassignment and delegation are not built.
- `fixtures:removeOrganization` deletes each request's task and events before the request and reports `reviewTasks` and `requestEvents` counts.
- The request view adds `state`, `reviewer`, `submittedAt`, `decidedAt`, `canSubmit`, `canWithdraw` and `canDecide`. `canEdit` is true only for a draft.
- Unit tests cover the rules sequentially; the races are shown only against a real Convex backend (`demo:review-journey`).
