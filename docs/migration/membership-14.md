# M1.3 application membership and backend permissions

Issue: [#14](https://github.com/fpcMotif/fenbase/issues/14), parent [#1](https://github.com/fpcMotif/fenbase/issues/1). Decision record: [ADR-0005](../adr/0005-application-membership-and-capability-grants.md). Glossary: `CONTEXT.md`, "Application Membership".

## Current contracts

### Identity

- Better Auth owns sign-in and sessions. No second credential or session system exists.
- `requireApplicationPrincipal(ctx, applicationId)` in `convex/membershipModel.ts` resolves each call:
  1. `requireUser` runs first. Anonymous callers get `Unauthenticated`.
  2. It reads the caller's row from `memberships.by_auth_user_application` with `.unique()`. A duplicate row throws.
  3. A missing row, an inactive row or a missing application throws `APPLICATION_ACCESS_DENIED`. So does a row whose stored `organizationId` differs from its application's organization.
  4. It returns `{authUserId, membershipId, application, applicationId, organizationId, grants}`. Membership ID and grants come from the row. Application ID and organization come from the application document.
- `membershipId` is the principal that later tickets store. It is a different value from `authUserId`.

### Grants

| Capability | Meaning | Assignable through `assignGrant` |
| --- | --- | --- |
| `configureApplication` | Builder: configure and publish the application (#15 enforces it) | Yes |
| `submitRequests` | Employee/requester | Yes |
| `reviewRequests` | Reviewer | Yes |
| `readApplicationRecords` | Read other members' non-draft requests in the application, but only those whose policy preset is `requesterAssignedReviewerAndReaders` (#16 enforces it). Drafts stay private to their requester | Yes |
| `manageMembers` | Membership admin | No; fixture seed only |

`configureApplication` never implies `readApplicationRecords`.

### Public functions (`convex/memberships.ts`)

| Function | Who may call | Result or denial |
| --- | --- | --- |
| `listMine` | Any signed-in user | The caller's active memberships, read through `memberships.by_auth_user_status`; rows whose organization differs from their application's are skipped |
| `getMyAccess({applicationId})` | Active member | Membership ID, grants, organization, application, capability flags |
| `listMembers({applicationId})` | `manageMembers` | Membership ID, status, grants, `updatedAt`; no identity fields |
| `setMemberStatus`, `assignGrant`, `revokeGrant` | `manageMembers` | `PERMISSION_DENIED` without the grant or when the target holds `manageMembers`; `MEMBERSHIP_NOT_FOUND` for another application's or a missing membership; `SELF_ADMINISTRATION_DENIED` for the caller's own membership; `MEMBERSHIP_INACTIVE` when assigning to an inactive member |

All checks run before any write. Repeating a status or grant change writes nothing.

`listMine` and `listMembers` return at most 100 rows. Each reads 101 rows; a 101st row throws `MEMBERSHIP_LIST_LIMIT_EXCEEDED` instead of returning a truncated list. Inactive memberships do not count toward the `listMine` limit.

A membership admin cannot change a peer admin. Only the fixture seed changes a membership that holds `manageMembers`.

The demo frontend maps every membership error code to a `membershipErrors.*` key in `src/demo/i18n.ts`, in both en-US and zh-CN. No membership screen exists yet.

### Field ownership

- Memberships: `authUserId`, `applicationId`, `organizationId`, `updatedAt` and `manageMembers` are server-owned. Public validators accept none of them. `status` changes only through `setMemberStatus` by another admin.
- Requests (#16, see [records-16.md](records-16.md)): requester membership, organization, version, policy preset, state and revision are server-owned in the same way, and #17 adds decision fields. Fields of the pinned definition version are the only client-writable business fields.

### Request predicates

#16 implements the read and edit predicates in `convex/requests.ts`; #17 implements the decision predicate. Each ticket tests them against its real functions.

| Predicate | Rule | Ticket |
| --- | --- | --- |
| `canReadRequest` | Own request in any state; or `readApplicationRecords` when the request is not a draft and its own policy preset is `requesterAssignedReviewerAndReaders`; or (#17) an assigned submitted request | #16, #17 |
| `canEditBusinessFields` | Requester edits or deletes their own draft only, while holding `submitRequests`; no grant lets another member edit | #16 |
| `isEligibleReviewer` | Active member of the same application with `reviewRequests`. Built in #15 for definition save and publish; #17 re-checks it at submit and decision time | #15, #17 |
| `canDecideRequest` | Eligible reviewer, request pending and assigned to them, not their own request; decision fields only | #17 |

### Revocation

- Revocation is `setMemberStatus(inactive)` or `revokeGrant`. The Better Auth session stays valid.
- The next query or mutation from an inactive member returns `APPLICATION_ACCESS_DENIED`. A missing grant returns `PERMISSION_DENIED`.
- A subscribed query re-runs because it read the membership row. A mutation that read the row conflicts with a concurrent deactivation under Convex optimistic concurrency.
- Only another `manageMembers` holder can reactivate a member, and only the fixture seed can reactivate an admin. #7 verifies rendered subscription cleanup.

## Evidence

Revision exercised: `432ef9c6dc3d6a5af7e03a008cbf616d357659c3` on branch `integration/issue-14`, 2026-10-06. Later commits on the branch change documentation only. Target: a self-hosted Convex backend on loopback 3310/3311, instance `membership14`, with its own SQLite and file store under `storage/membership-14-*/`, set up with the [baseline runbook](baseline-13.md) (`convex deploy --env-file`, static JWKS). The same target served the earlier runs. Deploying this revision removed the `memberships.by_auth_user` index and added `memberships.by_auth_user_status`. Vite ran on 5173 against that target.

### Commands

```sh
bunx vitest run -c vitest.demo.config.ts
node_modules/.bin/tsc --noEmit -p convex/tsconfig.json
bun run demo:typecheck
node_modules/.bin/convex deploy --env-file "$TARGET_DIR/target.env" --typecheck=enable --codegen=disable -y
MEMBERSHIP_DIR="$TARGET_DIR" VITE_CONVEX_URL=http://127.0.0.1:3310 \
  VITE_CONVEX_SITE_URL=http://127.0.0.1:3311 bun run demo:membership-journey
```

The six owner-scoped journeys ran next with the same `VITE_CONVEX_*` values and `DEMO_APP_URL=http://localhost:5173`.

`MEMBERSHIP_DIR` holds `target.env`, `run-id` and `password` (mode 600, never printed). The journey signs in with real Better Auth and signs up only when the account does not exist. It seeds through `convex run fixtures:upsertMember` and writes `membership-14-results.json` with normalized IDs.

### Results

| Check | Outcome |
| --- | --- |
| Demo unit suite | 8 files, 141 tests passed: 54 in `memberships.test.ts`, 3 in `src/demo/__tests__/i18n.test.ts`, 2 in `scripts/__tests__/demo-membership-journey.test.ts` |
| Convex and demo typecheck | Passed |
| Membership journey | 66/66 checks passed, reusing the identities of earlier runs |
| Owner-scoped regressions | `demo:verify` 24, `demo:journey` 18, `demo:collection-journey` 31, `demo:record-journey` 37, `demo:isolation-journey` 57, `demo:browse-journey` 18 checks passed |

Unit tests in `memberships.test.ts` and `i18n.test.ts` cover the organization mismatch denial, the 100-row limit, the peer-admin denial and the `membershipErrors.*` keys. The journey does not exercise them on the live target.

Journey checks, expected equal to actual for every row. Each denial also compared `listMembers` snapshots for both organizations before and after the call.

| Area | Expected and actual |
| --- | --- |
| Identity | A, B, C, D, M and Z signed in; repeat runs created no new auth users |
| Fixtures | Repeat seed created nothing; 2 organizations, 2 applications, 6 memberships |
| Positive access | `listMine` and `getMyAccess` matched the capability matrix for all six actors; M listed exactly the 5 org-1 members; Z listed only Z; no identity fields returned |
| Anonymous | `Unauthenticated` on all six functions, state unchanged |
| Foreign organization and guessed IDs | `APPLICATION_ACCESS_DENIED` (Z on org 1; A on org 2; a deleted application ID); `MEMBERSHIP_NOT_FOUND` (Z's membership and a deleted membership ID through org 1), state unchanged |
| Self-escalation | A self-grant, A self-status, A changing C: `PERMISSION_DENIED`; B, C, D `listMembers`: `PERMISSION_DENIED`; M on itself: `SELF_ADMINISTRATION_DENIED` |
| Spoofed arguments | Extra `role`, `organizationId`, `authUserId`, `actorId`, `status`, a malformed ID and `capability: manageMembers` all failed argument validation, state unchanged |
| Builder separation | D: `readAllRecords` false, true after M's grant, false after revoke; `configureApplication` stayed true |
| Revocation | B's same signed-in client: allowed, then `APPLICATION_ACCESS_DENIED` for query and self-reactivation after M deactivated B; session still valid; allowed again after M reactivated; `reviewRequests` false after revoke |
| Cleanup | `removeOrganization` removed 1/1/5 (org 1), 1/1/1 (org 2) and 1/1/1 (disposable guessed-ID org); 0 fixture rows remained. After all seven journeys, direct table reads found 0 `organizations`, `applications`, `memberships`, `demoCollections`, `demoRecords`, `demoWorkflows` and `demoWorkflowRuns` rows |

## Retained resources

- `storage/membership-14-*/`: the synthetic database, file store, private target configuration, JWKS, run ID, password, logs and `membership-14-results.json`. Do not upload it. Deleting this directory removes all of it.
- Better Auth retained 34 synthetic users and 50 sessions on that target after the final runs: 6 users from the membership journey and the rest from the regression journeys across all runs. Sign-out does not delete every session.
- `dist/*-journey/` screenshots and results from the regression journeys. These are ignored build artifacts.
- The source `.env`, `.env.local` and `.convex/` were not used. Both servers were stopped and the ports checked after verification.

## Not covered

- Request-level predicates, listed above, belong to #16 and #17.
- No membership UI exists. The `membershipErrors.*` messages are ready for the first screen that shows these codes, but no rendered screen has displayed them.
- The owner-scoped demo is not gated by membership.

#15 built the minimal builder and immutable published definitions, gated by `configureApplication` ([evidence](definition-15.md)).
