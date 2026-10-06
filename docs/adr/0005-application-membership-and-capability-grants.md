# Application membership and capability grants

## Context

Before issue #14, the Convex reference app scoped every row to its owner (`ownerId`). That model cannot let an employee, a reviewer and a builder share one application. The roadmap (#1) needs shared access without exposing unrelated users' records, and without trusting anything the client sends about identity, role or tenant.

The repository already had a root `users` table with a free-string `role` column. No code reads it. Better Auth owns the real identities and sessions.

## Decision

1. **Membership rows hold the grants.** A `memberships` row links one Better Auth user to one application. It carries `status` and `grants`, an array of capability literals. There is no separate role table and no policy language.
2. **`users.role` is not used.** The legacy `users` and `sessions` tables stay in place until consumer tracing proves they can be retired.
3. **`applicationId` is only a lookup key.** The server finds the caller's own membership for that application with `requireApplicationPrincipal`. Organization, grants and membership ID always come from that row. No public function accepts an actor, role, organization or auth user ID; strict argument validators reject extra keys.
4. **One denial code for every outsider.** Nonmember, inactive, foreign-organization and guessed applications all return `APPLICATION_ACCESS_DENIED`.
5. **No public member creation.** Only the internal `fixtures:upsertMember` seed creates organizations, applications and memberships in M1. This avoids an email-enumeration path.
6. **`manageMembers` is seed-only, and admins cannot administer themselves.** `assignGrant` and `revokeGrant` accept only the four assignable capabilities. Every admin mutation compares the target's `authUserId` with the caller's and returns `SELF_ADMINISTRATION_DENIED` on a match. A target in another application returns `MEMBERSHIP_NOT_FOUND`.
7. **Builder access is not record access.** `configureApplication` and `readApplicationRecords` are separate grants.
8. **Revocation is checked on every call.** The principal is resolved for every query and mutation and nothing is memoized or put in the session token.

## Consequences

- Later tickets (#15, #16, #17) call `requireApplicationPrincipal` and add their own bounded predicates, tested against their real functions.
- Widening the capability union, for example with `editApplicationRecords`, is a schema-compatible change.
- Without a public member-create function, a real deployment still needs an onboarding path. That is outside M1.
- The owner-scoped demo tables keep their `ownerId` model. They are a regression surface, not the company authorization model.
