# M1.3 application membership and backend permissions

Issue: [#14](https://github.com/fpcMotif/fenbase/issues/14), parent [#1](https://github.com/fpcMotif/fenbase/issues/1). Decision record: [ADR-0005](../adr/0005-application-membership-and-capability-grants.md). Glossary: `CONTEXT.md`, "Application Membership".

## Current contracts

### Identity

- Better Auth owns sign-in and sessions. No second credential or session system exists.
- `requireApplicationPrincipal(ctx, applicationId)` in `convex/membershipModel.ts` resolves each call:
  1. `requireUser` runs first. Anonymous callers get `Unauthenticated`.
  2. It reads the caller's row from `memberships.by_auth_user_application` with `.unique()`. A duplicate row throws.
  3. A missing row, an inactive row or a missing application throws `APPLICATION_ACCESS_DENIED`.
  4. It returns `{authUserId, membershipId, applicationId, organizationId, grants}`, all taken from the row.
- `membershipId` is the principal that later tickets store. It is a different value from `authUserId`.

### Grants

| Capability | Meaning | Assignable through `assignGrant` |
| --- | --- | --- |
| `configureApplication` | Builder: configure and publish the application (#15 enforces it) | Yes |
| `submitRequests` | Employee/requester | Yes |
| `reviewRequests` | Reviewer | Yes |
| `readApplicationRecords` | Read every record in the application (#16 enforces it) | Yes |
| `manageMembers` | Membership admin | No; fixture seed only |

`configureApplication` never implies `readApplicationRecords`.

### Public functions (`convex/memberships.ts`)

| Function | Who may call | Result or denial |
| --- | --- | --- |
| `listMine` | Any signed-in user | The caller's active memberships only |
| `getMyAccess({applicationId})` | Active member | Membership ID, grants, organization, application, capability flags |
| `listMembers({applicationId})` | `manageMembers` | Up to 101 rows: membership ID, status, grants, `updatedAt`; no identity fields |
| `setMemberStatus`, `assignGrant`, `revokeGrant` | `manageMembers` | `PERMISSION_DENIED` without the grant; `MEMBERSHIP_NOT_FOUND` for another application's or a missing membership; `SELF_ADMINISTRATION_DENIED` for the caller's own membership; `MEMBERSHIP_INACTIVE` when assigning to an inactive member |

All checks run before any write. Repeating a status or grant change writes nothing.

### Field ownership

- Memberships: `authUserId`, `applicationId`, `organizationId`, `updatedAt` and `manageMembers` are server-owned. Public validators accept none of them. `status` changes only through `setMemberStatus` by another admin.
- Request records (#16, #17): requester membership, organization, state, version and decision fields must be server-owned in the same way. Application-configurable fields are the only client-writable business fields.

### Contracts still to build

These predicates need request facts that do not exist yet. Each ticket implements and tests them against its real functions.

| Predicate | Rule | Ticket |
| --- | --- | --- |
| `canReadRequest` | Own request, an assigned submitted request, or `readApplicationRecords` | #16 |
| `canEditBusinessFields` | Requester edits their own draft only; builders need an extra edit grant | #16 |
| `isEligibleReviewer` | Active member of the same application with `reviewRequests` | #17 |
| `canDecideRequest` | Eligible reviewer, request pending and assigned to them, not their own request; decision fields only | #17 |

### Revocation

- Revocation is `setMemberStatus(inactive)` or `revokeGrant`. The Better Auth session stays valid.
- The next query or mutation from an inactive member returns `APPLICATION_ACCESS_DENIED`. A missing grant returns `PERMISSION_DENIED`.
- A subscribed query re-runs because it read the membership row. A mutation that read the row conflicts with a concurrent deactivation under Convex optimistic concurrency.
- Only another `manageMembers` holder can reactivate a member. #7 verifies rendered subscription cleanup.

## Evidence

Revision exercised: `76d49a5ab6ada8ae0a13346d46f5a2708cc273bd` on branch `claude/issue-14-impl`, 2026-10-06. Target: a new self-hosted Convex backend on loopback 3310/3311, instance `membership14`, fresh SQLite and file store under `storage/membership-14-*/`, set up with the [baseline runbook](baseline-13.md) (`convex deploy --env-file`, static JWKS). Vite ran on 5173 against that target.

### Commands

```sh
node_modules/.bin/vitest run --config vitest.demo.config.ts
node_modules/.bin/tsc --noEmit -p convex/tsconfig.json
bun run demo:typecheck
bun run demo:build
MEMBERSHIP_DIR="$TARGET_DIR" VITE_CONVEX_URL=http://127.0.0.1:3310 \
  VITE_CONVEX_SITE_URL=http://127.0.0.1:3311 bun run demo:membership-journey
```

`MEMBERSHIP_DIR` holds `target.env`, `run-id` and `password` (mode 600, never printed). The journey signs in with real Better Auth and signs up only when the account does not exist. It seeds through `convex run fixtures:upsertMember` and writes `membership-14-results.json` with normalized IDs.

### Results

| Check | Outcome |
| --- | --- |
| Convex unit suite | 6 files, 126 tests passed (44 new in `memberships.test.ts`) |
| Convex and demo typecheck, demo build | Passed; existing >500 kB chunk warning |
| Membership journey | 66/66 checks passed on the last two runs, which reused the same identities. The first run failed 13 checks because the journey compared objects by key order; the comparison was fixed, not the backend |
| Owner-scoped regressions | `demo:verify` 24, `demo:journey` 18, `demo:collection-journey` 31, `demo:record-journey` 37, `demo:isolation-journey` 57, `demo:browse-journey` 18 checks passed |

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
| Cleanup | `removeOrganization` removed 1/1/5 (org 1), 1/1/1 (org 2) and 1/1/1 (disposable guessed-ID org); 0 fixture rows remained |

## Retained resources

- `storage/membership-14-*/`: the synthetic database, file store, private target configuration, JWKS, run ID, password, logs and `membership-14-results.json`. Do not upload it. Deleting this directory removes all of it.
- Better Auth retained 24 synthetic users and 32 sessions on that target: 6 from this journey and the rest from the regression journeys. Sign-out does not delete every session.
- `dist/*-journey/` screenshots and results from the regression journeys, and `dist/demo`. These are ignored build artifacts.
- The source `.env`, `.env.local` and `.convex/` were not used. Both servers were stopped and the ports checked after verification.

## Not covered

- Request-level predicates, listed above, belong to #16 and #17.
- No membership UI exists, so no i18n keys were added. The first UI that shows these error codes adds en-US and zh-CN messages.
- The owner-scoped demo is not gated by membership.

Next ticket: **#15**, the minimal builder and immutable published definitions, gated by `configureApplication`.
