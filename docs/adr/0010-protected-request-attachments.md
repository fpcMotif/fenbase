# Protected request attachments behind authorized Convex functions

## Context

Issue #18 adds supporting documents to the leave request (ADR-0007, ADR-0009). A file is evidence: it must reach only the requester and the assigned reviewer, it must not change after submit, and access must end when membership or grants change. Convex file storage offers `getUrl`, whose URL works for anyone until the file is deleted, and `generateUploadUrl`, whose upload is not bound to a caller. Neither may be presented as protected access.

## Decision

1. **Request-scoped storage.** Files live in Convex file storage. Each blob belongs to one `requestAttachments` row (request, application, organization, field key, uploader membership, operation ID, storage ID, sanitized file name, size, detected type, hex SHA-256, time). Every `_storage` row belongs to `requestAttachments`. A future storage user must register its owner table with the orphan sweep.
2. **No storage URLs and no storage IDs at the API.** `requestAttachments.upload` is an action that receives the bytes, checks access and limits through an internal query, stores the blob and links it through an internal mutation in one call. `requestAttachments.download` is an action that checks access through an internal query on every call and returns the bytes. No public function accepts or returns a storage ID, and `getUrl` and `generateUploadUrl` are never called; a test enforces this.
3. **The server measures every file.** The size is the byte length, the type is detected from the leading bytes (PDF, PNG or JPEG) and must match the extension and the field's `accept` list, and the name is sanitized. Access is checked before any byte is hashed. The action passes the measured digest to `ctx.storage.store`, which verifies it (the backend takes it in base64). The link step reads `_storage` again and requires the same size and SHA-256. A mismatch, a missing blob or changed bytes on download fail with `ATTACHMENT_INTEGRITY_FAILED`. Client-supplied type, size, hash, owner or storage ID are rejected by the argument validators.
4. **Attachment field type.** A definition may hold one `attachment` field with `maxFiles` 1 to 5, `maxBytes` 1 KB to 2 MiB in whole KB (the builder edits KB, so any other value could not round-trip) and a non-empty `accept` subset. It cannot be a list column or a date-rule key, and its type is frozen once published. Files stay out of `values`; submit fails with `ATTACHMENT_REQUIRED` when a required field has no file.
5. **Reader rule.** Attachments are readable by the requester in every state and by the assigned reviewer of a submitted request while they hold `reviewRequests`. This is stricter than the request read rule: a readers-preset holder sees the request and an empty file list, and `configureApplication` grants nothing.
6. **Evidence is pinned at submit.** Attach and remove need the requester's own draft, `submitRequests` and the expected revision, and raise the request revision. After submit no command changes the set.
7. **Separate audit table.** `attachmentEvents` records attach and remove with the actor, file metadata, resulting revision and operation fingerprint. `requestEvents` and the ADR-0009 rules stay unchanged. Replays follow ADR-0009: access is checked before the replay lookup, and the request state and revision after it. A replayed upload whose file was removed since returns `removed: true`.
8. **Bounded cleanup.** A failed link deletes its blob. `requestAttachments.sweepOrphans` deletes unlinked blobs older than 15 minutes, 200 per page, and runs every 30 minutes from `convex/crons.ts`. The sweep refuses a negative grace window. A draft allows 20 attaches; removes do not count, and each remove follows an attach, so a draft holds at most 40 attachment events. Deleting a draft deletes its own rows, blobs and attachment events only, within that bound. `fixtures:removeRequestAttachments` removes fixture attachments in batches, and `fixtures:removeOrganization` refuses while any remain.

## Rejected options

- **`getUrl` links.** They cannot be revoked short of deleting the file.
- **`generateUploadUrl` plus a finalize mutation.** The server cannot prove who uploaded a storage ID, so a leaked fresh ID could be claimed by someone else.
- **HTTP action routes.** They add CORS, preflight and bearer-token handling. The authenticated Convex client already carries identity, and a 2 MiB action argument works on the local backend.
- **Reusing the request read rule for files.** It would give readers-preset holders the documents, which the issue does not list.
- **Writing attachment events into `requestEvents`.** Drafts would then have events, breaking the ADR-0009 invariant.

## Consequences

- Revocation applies to the next retrieval. One download that passed its access check before the revocation committed can still return its bytes, and bytes a user already saved cannot be recalled.
- After 20 attaches a draft takes no more files, even with none attached; the requester must create a new draft. The cap keeps the draft-delete cascade inside one bounded transaction.
- Attaching or removing a file in one tab gives another open tab of the same draft a revision conflict.
- The self-hosted local backend keeps a deleted blob's file on disk; the reconciliation accounts for those files as retained bytes.
- The spec owner still has to confirm three choices: readers-preset holders get no files, attach and remove raise the revision, and the 30-minute sweep with a 15-minute grace window.
