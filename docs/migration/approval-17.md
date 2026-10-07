# Issue #17: submit leave requests and complete one versioned review

Requesters now submit a draft request, and the reviewer named by the request's pinned version approves or rejects it. The requester can withdraw a pending request. Each command checks the actor, the expected state and the expected revision. It writes the new state, the review task and one history event in a single Convex mutation. The decisions are recorded in [ADR-0008](../adr/0008-one-versioned-review-per-request.md).

## Transition contract

| From | Command | Caller | To | Review task |
| --- | --- | --- | --- | --- |
| `draft` | `requestReviews.submit` | Requester with `submitRequests` | `pending` | Created, `pending`, assigned to the pinned version's reviewer |
| `pending` | `requestReviews.approve` | Assigned reviewer with `reviewRequests`, not the requester | `approved` | `completed`, outcome `approved` |
| `pending` | `requestReviews.reject` | Assigned reviewer with `reviewRequests`, not the requester | `rejected` | `completed`, outcome `rejected` |
| `pending` | `requestReviews.withdraw` | Requester with `submitRequests` | `withdrawn` | `cancelled`, outcome `withdrawn` |

Every other combination fails with `REQUEST_STATE_CONFLICT`, `currentState` and `currentRevision`. `approved`, `rejected` and `withdrawn` are terminal; a correction is a new request.

Each command takes `{applicationId, requestId, expectedRevision, operationId}` and returns `{requestId, state, revision, eventId, replayed}`. An accepted command adds 1 to the request revision. Checks run in this order:

1. The principal: `Unauthenticated` for an anonymous caller, `APPLICATION_ACCESS_DENIED` for an inactive member, a non-member or another organization.
2. The operation ID pattern: `RECORD_OPERATION_ID_INVALID`.
3. A replay: the same actor and operation ID with the same `{command, applicationId, requestId, expectedRevision}` returns the stored result with `replayed: true` and writes nothing. Another payload fails with `RECORD_OPERATION_CONFLICT`.
4. The read rule: `RECORD_NOT_FOUND` for a request the caller cannot read, the same as a missing one.
5. The role: `REQUEST_SELF_REVIEW` when the requester approves or rejects, otherwise `PERMISSION_DENIED`.
6. The state: `REQUEST_STATE_CONFLICT`.
7. The revision: `RECORD_REVISION_CONFLICT` with `currentRevision`.
8. Submit only: the stored values are validated against the pinned version again. The reviewer is read from that version. `REQUEST_SELF_REVIEW` if it is the requester, `REQUEST_REVIEWER_UNAVAILABLE` if it is not an active member holding `reviewRequests`.

Generic `requests.update` and `requests.remove` fail with `REQUEST_STATE_CONFLICT` for any non-draft request. Their arguments and the request values cannot name state, requester, reviewer or version.

### Data

- `requests` gains the server-owned `reviewerMembershipId`, `submittedAt` and `decidedAt`. `state` is `draft | pending | approved | rejected | withdrawn`.
- `reviewTasks`: one row per submitted request with the requester, reviewer, pinned version, `status` (`pending`, `completed`, `cancelled`), `outcome` and times. It is both the review task and the execution. Indexes `by_request` and `by_reviewer_status`.
- `requestEvents`: one append-only row per accepted command with the actor, command, from and to state, resulting revision, pinned version, operation ID and fingerprint, and time. Indexes `by_request` and `by_actor_operation`.
- The request view adds `state`, `reviewer: {membershipId, isMe} | null`, `submittedAt`, `decidedAt`, `canSubmit`, `canWithdraw` and `canDecide`. `canEdit` is true only for a draft.
- `requestReviews.inbox({applicationId, status})` needs `reviewRequests`. It reads at most 100 of the caller's tasks plus a `truncated` flag. `requestReviews.history({applicationId, requestId})` returns the events, or `null` when the caller cannot read the request.
- `fixtures:removeOrganization` deletes each request's task and events before the request and reports `reviewTasks` and `requestEvents` counts.
- The #8 field-update workflow (`convex/workflows.ts`, `demoWorkflows`, `demoWorkflowRuns`) is unchanged.

### Versions and reviewers

Submit copies the reviewer from the pinned version. A V1 request keeps reviewer B after V2 names reviewer C, including a V1 draft submitted after V2 was published; that submit does not fail with `RECORD_DEFINITION_OUTDATED`. When B becomes inactive or loses `reviewRequests`, B is denied and the task stays `pending`. Only the requester's withdraw ends it; reassignment is not built.

### Demo UI

The Requests tab shows a state tag on every row. Holders of `reviewRequests` get a "My requests" / "Assigned to me" switch; a reviewer without `submitRequests` starts on "Assigned to me". The inbox switches between "Waiting for me" and "Decided by me" and opens the same request dialog.

The dialog shows the state tag, the reviewer and a history timeline. A draft has Save draft and Submit for review; submit saves the form first. A pending request shows Withdraw to the requester behind a confirmation inside the dialog's focus trap, and Reject and Approve to the reviewer. Each attempt sends a new `crypto.randomUUID()` operation ID; the Convex client reuses it on a transport retry. The buttons follow the snapshot the dialog opened with. A command on a request that changed elsewhere is refused by the server, and the dialog shows a focused "This request changed since you opened it" alert with "Show latest". All buttons use the `withoutMotion` theme and `runPendingAction`. Results are announced in the `aria-live` output, and every new string exists in en-US and zh-CN.

## Runbook

The target is a fresh self-hosted backend set up with the [baseline runbook](baseline-13.md) on loopback 3340/3341, instance `approval17`, with `SITE_URL` `http://localhost:5203`. Ports 3330/3331/5193 were in use by another target during this work.

```sh
umask 077
REVIEW_DIR=$(mktemp -d "$PWD/storage/approval-17-XXXXXX")
# target.env, instance-name, instance-secret, run-id and password live in REVIEW_DIR (mode 600, never printed).
"$BIN" --interface 127.0.0.1 --port 3340 --site-proxy-port 3341 --instance-name approval17 \
  --instance-secret "$(cat "$REVIEW_DIR/instance-secret")" --local-storage "$REVIEW_DIR/files" \
  --disable-beacon "$REVIEW_DIR/backend.sqlite3" >> "$REVIEW_DIR/backend.log" 2>&1
node_modules/.bin/convex deploy --env-file "$REVIEW_DIR/target.env" --typecheck enable --codegen disable -y
# With CONVEX_SELF_HOSTED_URL and CONVEX_SELF_HOSTED_ADMIN_KEY exported from target.env:
node_modules/.bin/convex codegen --typecheck=enable && node_modules/.bin/oxfmt --write convex/_generated
rm -rf node_modules/.vite/deps   # with Vite stopped, before each run
VITE_CONVEX_URL=http://127.0.0.1:3340 VITE_CONVEX_SITE_URL=http://127.0.0.1:3341 \
  bun run demo:dev --host 127.0.0.1 --port 5203 --strictPort
REVIEW_DIR="$REVIEW_DIR" REVIEW_JOURNEY_MODE=full VITE_CONVEX_URL=http://127.0.0.1:3340 \
  VITE_CONVEX_SITE_URL=http://127.0.0.1:3341 DEMO_APP_URL=http://localhost:5203 bun run demo:review-journey
```

`REVIEW_JOURNEY_MODE` is `red` (backend phase, `results-red.json`), `backend` (backend phase) or `full` (default: backend phase, browsers and restart). Results go to `dist/review-journey/results-<mode>.json`, with ids, times, member references and the run ID labelled, so two runs of one mode write identical files. `evidence-<mode>.json` keeps what varies: the git revision, the winner of each race and the retained auth rows.

### Restart

The full mode restarts both local processes and expects the same data back:

1. Create and submit one request, then snapshot the fixture `requests`, `reviewTasks` and `requestEvents` rows.
2. Stop the process listening on the backend port after checking its command line names `REVIEW_DIR`, and the Vite process on the app port. Wait until both ports are closed.
3. Delete `node_modules/.vite/deps`.
4. Relaunch the backend with the same binary, instance name, instance secret, file store and SQLite file, and Vite with the same URLs. Both run detached and keep running after the journey.
5. Compare the rows byte for byte, sign the HTTP clients in again, and check that the pending task is still in the reviewer's inbox.
6. Open a new browser session as the reviewer, approve the request from the inbox and check the persisted decision.

## Evidence

Revision exercised: `5fb422c6c7` on `claude/issue-17-impl` for the unit suite, the regressions and three full journey runs, with the journey's normalization of member references and run-ID keys that `c1da26e3f7` commits. A fourth full run on `c1da26e3f7` itself, after redeploying, passed 59/59 with the same results hash. Date: 2026-10-07. Target: the isolated backend above, `storage/approval-17-bV72GS/`.

### Red before green

| Run | Outcome |
| --- | --- |
| `requestReviews.test.ts` before `convex/requestReviews.ts` existed | Suite failed to load `../requestReviews` |
| Cleanup test before `removeOrganization` knew the new tables | Failed: `reviewTasks` and `requestEvents` counts missing |
| `memberships.test.ts` after the cleanup counts changed | 2 tests failed until they expected the two new counts |
| `i18n.test.ts` before the three new error codes had text | 1 test failed: missing `requestErrors` keys |
| `requestModal.test.ts` before `requestActions` existed | 2 tests failed on the missing export |
| Mutation check: `requireEditable` without the state guard | 1 test failed: the generic update and remove of a pending request succeeded |
| Journey backend phase against functions deployed from `a747b322ea` (no review commands) | 22 of 24 checks failed with `FunctionNotFound` or a missing state guard; the draft-values check and cleanup passed; the run stopped at `requestReviews:submit` |
| Journey race phase, first green attempt | `RACE-01` failed: new requests used V2, whose reviewer is V, so B got `RECORD_NOT_FOUND`; the race actor became V |
| Journey browser phase, first green attempts | Withdraw's confirmation rendered outside the dialog's focus trap and Tab could not reach it; after "Show latest" focus left the dialog and Escape did nothing. Both were fixed in the UI |
| Three full runs before member references were labelled | Results differed only in "Member xxxxxx" text |

The backend command tests were written as a batch after the first red tracer, so most passed on their first run; the mutation check above shows the bypass test fails without its guard.

### Results

| Check | Outcome |
| --- | --- |
| `bunx vitest run -c vitest.demo.config.ts` | 17 files, 346 tests passed; 22 in `requestReviews.test.ts`, 38 in `requests.test.ts`, 14 in `i18n.test.ts`, 7 in `requestModal.test.ts`, 3 in `workflows.test.ts` |
| `node_modules/.bin/tsc --noEmit -p convex/tsconfig.json`, `bun run demo:typecheck`, `bun run demo:build` | Passed |
| `bun run quality:check --base origin/main` | 20 changed files, 0 introduced diagnostics |
| `convex codegen` against the target | `api.d.ts` gained `requestReviews` and `__tests__/requestFixture`; nothing edited by hand |
| `demo:review-journey`, mode `full`, three runs from a fresh Vite dependency cache | 59/59 checks each; the three `results-full.json` files are byte-identical (sha256 `870c2f22…`) |
| Race winners across the three runs (20 rounds each) | Approve against reject: 11/9, 15/5, 11/9 approved/rejected. Approve against withdraw: 11/9, 14/6, 16/4 approved/withdrawn. Every loser got `REQUEST_STATE_CONFLICT` |
| Regressions on the same target and Vite | `demo:verify` 24, `demo:journey` 18, `demo:collection-journey` 31, `demo:record-journey` 37, `demo:isolation-journey` 57, `demo:browse-journey` 18, `demo:membership-journey` 66/66, `demo:definition-journey` 30/30, `demo:request-journey` 73/73; each exited 0 |

Journey checks, expected equal to actual in every run:

| Area | Checks |
| --- | --- |
| RUN-01 | Submit returns `pending`, revision 2; one task assigned to V1's reviewer B and one `submit` event by A; a repeated submit returns the same event with `replayed: true` and writes nothing |
| AUTH-01 | Anonymous `Unauthenticated`; unrelated employee and V2's reviewer `RECORD_NOT_FOUND`; inactive member and second organization `APPLICATION_ACCESS_DENIED`; requester approving `REQUEST_SELF_REVIEW`; reviewer withdrawing `PERMISSION_DENIED`; malformed operation ID and stale revision refused; B submitting a request B reviews `REQUEST_SELF_REVIEW`. Each left all three tables unchanged. Only B's inbox lists the request; A's inbox is `PERMISSION_DENIED`; an unrelated member gets `null` from `get` and `history` |
| BYPASS-01 | Generic update and remove of a pending request `REQUEST_STATE_CONFLICT`; `state`, `reviewerMembershipId`, `requesterMembershipId`, `version` and `definitionVersionId` on submit `ArgumentValidationError`; `state` inside draft values `RECORD_FIELD_SERVER_OWNED` |
| RUN-02 | B approves one request and rejects another; the repeated approve returns the original event; the same ID for reject `RECORD_OPERATION_CONFLICT`; approve, reject, withdraw and remove on a terminal request `REQUEST_STATE_CONFLICT`; history lists `submit` by A then the decision by B; tasks `completed` with the outcome |
| VERSION-01 | After V2 names V, a pending V1 request and a V1 draft submitted later both keep B and version 1; a V2 request goes to V; V cannot decide the V1 request; inactive B is denied and the task stays pending; reactivated B and V each decide their own version's request |
| RACE-01 | 20 rounds of concurrent duplicate submits (one effect, one replay), approve against reject, and approve against withdraw (one accepted transition each, task status matching the winner) |
| Browser, en-US and zh-CN | Two signed-in sessions at once, keyboard only, recorded: the requester's submit appears in the reviewer's inbox without a reload; a request withdrawn while the reviewer has it open refuses 5 stale approvals with a focused alert and the button settles each time; "Show latest" hides the decision and shows the withdrawal; the reviewer sees the values read-only; the decision reaches the requester's list live; after both pages reload the history and the "Decided by me" list come back; no page errors |
| RESTART | Backend and Vite stopped and relaunched with the same storage; request, task and event rows byte-identical; the pending task is still in the inbox; the reviewer approves it in a new browser session |
| INVARIANTS | Every non-draft request has exactly one task and at least one event, and its revision equals its last event's; drafts have neither; pending tasks belong to pending requests and closed tasks to terminal ones |
| REPLAY-01 | Cleanup leaves 0 fixture requests, tasks, events, memberships and applications |

### Artifacts

`dist/review-journey/`: `results-full.json`, `results-backend.json`, `results-red.json`, `evidence-*.json`, per-session console logs, and these recordings and screenshots:

- `en-US-requester.webm`, `en-US-reviewer.webm`, `zh-CN-requester.webm`, `zh-CN-reviewer.webm`, `en-US-reviewer-after-restart.webm`
- `<locale>-requester-{2-submitted,3-decided-live,4-history-after-reload}.png`
- `<locale>-reviewer-{1-inbox-empty,2-inbox-live,3-stale-refused,4-review-open,5-completed-after-reload}.png`
- `en-US-reviewer-after-restart-1-approved-after-restart.png`

## Retained resources

- `storage/approval-17-bV72GS/`: the synthetic SQLite database and file store, private target configuration, run ID, password, backend and Vite logs, per-run results and regression logs. Do not upload it. After cleanup the fixture tables hold no review rows.
- The backend (3340/3341) and Vite (5203) relaunched by the last restart keep running until stopped by port.
- Better Auth keeps the synthetic users and sessions the journeys create.

## Not covered

- Reassigning or delegating a stranded task, reopening, multi-stage review and workflow graphs.
- Display names for memberships; the UI shows "Me" or "Member" plus six characters of the membership ID.
- A reader under the readers preset viewing a submitted request; that read path has unit evidence only.
- Protected attachments (#18).
