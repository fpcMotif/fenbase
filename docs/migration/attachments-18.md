# Issue #18: protected attachments on the configured HR reference

Issue [#18](https://github.com/fpcMotif/fenbase/issues/18) adds supporting documents to leave requests. Files live in Convex file storage behind authorized functions; no storage URL or storage ID ever reaches a client. The decision record is [ADR-0010](../adr/0010-protected-request-attachments.md).

## Contract

### Limits

| Limit | Value | Where |
| --- | --- | --- |
| Allowed types | PDF, PNG, JPEG, detected from the leading bytes and matched to the extension | `convex/attachmentModel.ts` |
| File size | 1 byte to the field's `maxBytes`; `maxBytes` is 1 KB to 2 MiB (2,097,152 bytes) in whole KB | field bounds and `upload` |
| Files per field | the field's `maxFiles`, 1 to 5 | field bounds, `upload` and submit |
| Files per request | 5 | `upload` |
| Attaches per draft | 20; removes do not count, so a draft holds at most 40 attachment events | `upload` and draft deletion |
| Attachment fields per definition | 1 | `validateDefinition` |
| File name | NFC, without control characters, path separators or leading dots, at most 120 code points | `sanitizeFileName` |

The HR reference (`scripts/leave-definition.ts`) has an optional `supportingDocument` field with `maxFiles` 2, `maxBytes` 2 MiB and all three types. The builder edits it with "Maximum files", "Maximum file size (KB)" and "Allowed file types".

### Functions

- `requestAttachments.upload` (action): `{applicationId, requestId, fieldKey, fileName, bytes, expectedRevision, operationId}`. It checks access, the replay, the draft state and revision, the field and the limits through the internal query `authorizeUpload` before it hashes any byte. A replay is then confirmed by comparing the operation fingerprint. Next come the size, name and detected type. The action stores the blob with its measured digest, which the backend verifies, and links it through the internal mutation `attach`. `attach` repeats every check, reads `_storage` and requires the same size and SHA-256; a mismatch or an already linked blob fails with `ATTACHMENT_INTEGRITY_FAILED`. If linking throws, the action deletes the blob. It returns `{attachmentId, revision, replayed, removed, fileName, size, contentType, sha256}`; `removed` is `true` only for a replay whose file was removed since.
- `requestAttachments.remove` (mutation): `{applicationId, requestId, attachmentId, expectedRevision, operationId}`. It deletes the row and the blob and returns `{revision, replayed}`.
- `requestAttachments.list` (query): `null` when the caller cannot read the request, `[]` when they can read it but not its files, otherwise `{_id, fieldKey, fileName, size, contentType, sha256, createdAt}` per file.
- `requestAttachments.download` (action): `{applicationId, attachmentId}`. The internal query `authorizeDownload` returns the same `null` for a missing, foreign, cross-application or denied file, which the action reports as `RECORD_NOT_FOUND`. The action re-hashes the bytes; a missing blob or changed bytes fail with `ATTACHMENT_INTEGRITY_FAILED`.
- `requestAttachments.sweepOrphans` (internal mutation): deletes unlinked blobs older than 15 minutes, 200 per page, and schedules the next page. An `olderThanMs` override must not be negative. `convex/crons.ts` runs it every 30 minutes.
- Fixtures: `fixtures:removeRequestAttachments` removes rows, blobs and events in batches of 100; `fixtures:removeOrganization` fails with `FIXTURE_ATTACHMENTS_REMAIN` until it is done. `fixtures:storeOrphanFile` stores an unlinked blob for the sweep check.

Attach and remove raise the request revision and write an `attachmentEvents` row. New error codes, in en-US and zh-CN: `ATTACHMENT_TOO_LARGE`, `ATTACHMENT_TYPE_NOT_ALLOWED`, `ATTACHMENT_LIMIT_REACHED`, `ATTACHMENT_REQUIRED`, `ATTACHMENT_NAME_INVALID`, `ATTACHMENT_INTEGRITY_FAILED`. The UI states `ATTACHMENT_TOO_LARGE`'s limit as a file size ("2,048 KB"), not a byte count.

### Rules by state and role

| Caller | Draft | Pending | Approved, rejected or withdrawn |
| --- | --- | --- | --- |
| Requester with `submitRequests` | list, upload, remove, download | list, download | list, download |
| Requester without `submitRequests` | list, download; changes get `PERMISSION_DENIED` | list, download | list, download |
| Assigned reviewer with `reviewRequests` | `RECORD_NOT_FOUND` | list, download | list, download |
| Readers-preset holder | `RECORD_NOT_FOUND` | the request, `[]`, download `RECORD_NOT_FOUND` | same as pending |
| Builder only, unrelated member | `RECORD_NOT_FOUND` | same | same |
| Inactive member, other organization | `APPLICATION_ACCESS_DENIED` | same | same |
| Signed out | `Unauthenticated` | same | same |

Changes after submit fail with `REQUEST_STATE_CONFLICT`. Submit fails with `ATTACHMENT_REQUIRED` when a required attachment field has no file.

### Threats

| Threat | How it is closed |
| --- | --- |
| A client links someone else's storage ID | No public function takes or returns one; `attach` is internal; `by_storage` allows one row per blob |
| A client lies about type, size or owner | The owner is the caller's membership; size and hash are measured; the type is sniffed; extra arguments fail validation |
| Too many or too large files | Field and server limits, checked when authorizing and again when linking |
| A link leaks | No link exists; the browser saves the returned bytes through an object URL it revokes on the next task, so the download is not cancelled |
| A caller without access makes the server hash large bodies | `upload` authorizes before it hashes, and checks the field size before hashing a new file |
| Stored bytes differ from the measured bytes | `ctx.storage.store` verifies the digest; `attach` and `download` compare size and SHA-256 again |
| Download after losing access | Every call re-checks the session, membership, grants and request state |
| Submitted evidence is edited | Attach and remove require a draft; submit pins the set |
| Orphan blobs | The action deletes the blob when linking throws; the sweep covers crashes |
| A draft delete removes shared files | Rows are request-scoped and each blob has one owner |
| The audit log leaks content | Events hold metadata only; a unit test and `AUDIT-01` check for bytes, storage IDs and URLs |

### Revocation

No bearer link exists, so there is no link lifetime. The first retrieval after a revocation commits is denied. The journey measured it from the moment the revoking call returned to the denied response. Over the four full runs below it took 35 to 44 ms when the reviewer lost `reviewRequests` (`RECORD_NOT_FOUND`), 29 to 53 ms when the requester was deactivated (`APPLICATION_ACCESS_DENIED`), and 35 to 64 ms after the reviewer signed out (`Unauthenticated`). The residual window is one download whose access check passed before the revocation committed; it can still return its bytes. Bytes a user already saved cannot be recalled. The dialog's file list unmounts on sign-out or account switch.

### Demo UI

The request dialog shows each attachment field below the form fields: the limits, a list of files with name, size and the first 12 characters of the SHA-256, Download for everyone who may read the files, and Remove behind a confirmation inside the dialog's focus trap for the requester's draft. "Attach file" opens the file picker and is one keyboard stop: antd 5.24's `Upload` defaults `hasControlInside`, so its wrapper gets no `role` or `tabindex` around the button. It is disabled with "Save the draft to attach files." until the draft exists. Oversize files and wrong extensions are refused before upload; the server decides everything else. Results go to the field's `aria-live` output and errors to a focused alert. An upload that loses its connection says the file is attached only once the list shows it. Uploads and removals update only the dialog's revision, so unsaved form edits stay.

### Reference trace: plugin-file-manager

The reference's file behaviour lives in `packages/plugins/@nocobase/plugin-file-manager`. Nothing from it is transplanted. The table maps what the reference does to what `requestAttachments` does.

| Reference behaviour (source) | Here |
| --- | --- |
| `attachments` collection: `title`, `filename`, `extname`, `size`, `mimetype`, `path`, `meta`, `url`, a `storage` relation and `createdBy` (`src/common/collections/attachments.ts`) | `fileName` (sanitized), `size`, `contentType`, `sha256`, `storageId`, `uploaderMembershipId`, `createdAt`, plus request, application, organization and field key. No `path`, `url` or `meta`: the file is reached only through `download`. |
| Storages with `local`, S3, OSS and COS backends, `baseUrl`, `path`, `renameMode`, `paranoid` (`src/common/collections/storages.ts`, `src/server/storages`) | Convex file storage only. R2 and external storage are out of scope. |
| Per-storage `rules.size`, default 20 MiB, minimum 1 byte (`src/constants.ts`, `actions/attachments.ts`) | Per-field `maxBytes`, 1 KB to 2 MiB in whole KB, measured from the bytes. |
| Per-storage `rules.mimetype` pattern, the type sniffed from the first 4,100 bytes, and active content refused (`actions/attachments.ts`, `rules/mimetype.ts`) | Per-field `accept` of PDF, PNG and JPEG; the type is sniffed from the leading bytes and must match the extension. |
| Any signed-in user may `upload` and `create`; `update`, `create` and `destroy` are limited to `createdById` (`server.ts` ACL) | Upload and remove need the requester's own draft, `submitRequests` and the expected revision. |
| Reads go through collection ACL, the `/files/<app>/<dataSource>/<collection>/<id>` route and public storage URLs (`file-access.ts`) | Reads need `canReadAttachments` on every `list` and `download`; there is no route and no URL. |
| `createTemporaryURL` signs a JWT link that lives 5 to 10 minutes (`temporary-access.ts`) | Not ported: a bearer link could not be revoked, so no link exists. |

## Runbook

The target is a fresh self-hosted backend set up like the [approval-17 runbook](approval-17.md#runbook) on loopback 3380/3381, instance `attachments18fix`, `SITE_URL` `http://localhost:5243`, with `--local-storage "$ATTACHMENT_DIR/files"`. The target directory holds `target.env`, `instance-name`, `instance-secret`, `run-id` and `password` (mode 600). Run the backend with `precompiled-2026-09-28-5c7cb5b`: `demo:review-journey` full restarts it from that binary and `instance-name`, and without the file its restart cannot reconnect.

```sh
ATTACHMENT_DIR="$ATTACHMENT_DIR" ATTACHMENT_JOURNEY_MODE=full VITE_CONVEX_URL=http://127.0.0.1:3380 \
  VITE_CONVEX_SITE_URL=http://127.0.0.1:3381 DEMO_APP_URL=http://localhost:5243 bun run demo:attachment-journey
```

`ATTACHMENT_JOURNEY_MODE` is `red`, `backend` or `full` (default). Results go to `dist/attachment-journey/results-<mode>.json` and `evidence-<mode>.json`. The full mode opens keyboard-only requester, reviewer and reader sessions in en-US and zh-CN, recorded as `<locale>-<role>.webm`.

### Reconciliation

`scripts/demo-attachment-reconcile.ts` runs before and after cleanup. Every attachment row needs one `_storage` blob with the same size and SHA-256, and an event chain ending in an attach with the same metadata. Every blob older than the grace window needs an owner. Every live blob needs a file on disk with its size and hash. Retrieved bytes must match their rows. `_storage.sha256` is base64 on this backend; the row and events store hex, and both spellings of one digest match.

The local backend keeps a deleted blob's file on disk. The reconciliation counts files that match no live blob as retained bytes instead of problems.

## Evidence

Revision exercised: `55af8737e9` on `claude/issue-18-review-fixes`, which applies the code and security review fixes on top of `origin/integration/issue-18` (`9aba3a9d2c`). Date: 2026-10-07. Target: `storage/attachments-18-fix-cVYyuF/`. Full runs 1 to 3, the backend-mode run and the regressions up to `demo:request-journey` used backend binary `precompiled-2026-10-06-a3538c6`. The passing `demo:review-journey` run and full run 4 used `precompiled-2026-09-28-5c7cb5b` on the same database.

### Red before green

| Run | Outcome |
| --- | --- |
| `attachmentModel.test.ts` before `convex/attachmentModel.ts` | Suite failed to load the module |
| `definitionModel.test.ts` attachment cases | 12 failed until the field type existed |
| `requestValues.test.ts` attachment cases | 3 failed: a required attachment field, a boolean value and the new code |
| `requestAttachments.test.ts` before `convex/requestAttachments.ts` | Suite failed to load the module |
| First green attempt of `requestAttachments.test.ts` | 2 failed: the test registry could not stand in a failing `attach`, and the batched sweep test created blobs inside the grace window |
| `i18n.test.ts` | Failed until the five attachment codes had text |
| `definitionForm.test.ts`, `requestForm.test.ts` | The attachment round trip and the value exclusion failed until implemented |
| `demo-attachment-reconcile.test.ts` after the disk model changed | 6 failed until disk files were matched by size and hash |
| Journey `red` against functions deployed from `e77f1053c2` (origin/integration/issue-18) | 4/31 passed; the HR reference with an attachment field failed validation and every `requestAttachments` call failed with `FunctionNotFound`. The passing checks were the internal-attach denial, the audit and the empty reconciliation and cleanup |
| Journey backend, first green attempt | 27/31: a wrong expectation for a draft's file count, an empty CLI output from `fixtures:storeOrphanFile`, and the disk model (deleted blobs stay on disk) |
| Journey full, first attempt | 35 checks passed, then a wait for the requester's dialog timed out: submitting had already closed it |
| `demo:definition-journey` with the new HR reference | Failed until it filled the attachment field by keyboard and stopped using fixed field positions |

`attachmentView.test.ts` and its module were written together, so its first version has no recorded red run.

The review fixes on `claude/issue-18-review-fixes` each started from a failing test:

| Test, before the fix | Outcome |
| --- | --- |
| `requestAttachments.test.ts` "measures no bytes before the caller is allowed to upload them" | `crypto.subtle.digest` ran 6 times for a signed-out caller, a reader and an oversize file |
| "asks storage to verify the digest it measured" | `ctx.storage.store` was called without `{ sha256 }` |
| "says so when the replayed attachment was removed after the first call" | The result had no `removed` field |
| "counts only attaches against the draft budget, so removals never use it up" | The 11th attach after 10 attach/remove pairs failed with `ATTACHMENT_LIMIT_REACHED` |
| Two link and two download integrity tests | Plain `Error`s instead of `ATTACHMENT_INTEGRITY_FAILED` |
| "refuses a negative grace window" | The sweep deleted a fresh orphan |
| `definitionModel.test.ts` "a size the builder cannot show in whole KB" | `maxBytes` 1536 was accepted |
| `i18n.test.ts` size limit and code coverage | The message said "2,048 KB bytes"; `ATTACHMENT_INTEGRITY_FAILED` had no text |
| `attachmentView.test.ts` "keeps the object URL alive" | `URL.revokeObjectURL` ran in the same task as the click |

A probe action on the self-hosted backend showed that `ctx.storage.store` rejects a hex `sha256` with "invalid HTTP header" and accepts base64, so the action sends base64. The test storage double now behaves the same way.

### Results

| Check | Outcome |
| --- | --- |
| `bunx vitest run -c vitest.demo.config.ts` | 481 passed |
| `bun run demo:typecheck`, `bun run demo:build`, `bun run quality:check --base origin/main` | Pass; the quality gate reports 0 introduced diagnostics |
| `demo:attachment-journey` backend | 33/33 |
| `demo:attachment-journey` full, four runs, each from an empty `node_modules/.vite/deps` | 49/49 each |
| FILE-01 | A 4,096-byte PDF and a 2 MiB PNG round-trip through the actions with matching size and SHA-256 |
| FILE-02 | `attach` is not public; a storage ID as an attachment ID fails validation; another organization's file and another request's file are `RECORD_NOT_FOUND` |
| FILE-03 | One byte over 2 MiB, renamed HTML, a PNG named `.pdf` and a third file are refused; client `contentType`, `size`, `sha256`, `uploaderMembershipId` and `storageId` fail validation; nothing changes |
| FILE-04 | Upload and remove after submit and after approval get `REQUEST_STATE_CONFLICT` |
| FILE-05 | The read matrix above, on a pending request and a draft |
| FILE-06 | The first retrieval after each revocation is denied; access returns after restoring |
| FILE-07 | A negative grace window is refused and removes nothing; an orphan inside the grace window is kept; with a zero grace window it is swept |
| FILE-08 | Deleting a draft removes its row, event and blob and leaves another draft's file |
| FILE-09 | A replayed upload returns the first attachment with `removed: false` and stores no blob; a replay after the file was removed returns `removed: true` |
| AUDIT-01, RECON-01, CLEANUP-01 | Metadata-only events; rows, blobs, disk files and retrieved bytes agree; no row or blob is left |
| `ui.en.*`, `ui.zh.*` | The attach control is one tab stop; attach, remove, reload, download hash, submit, reviewer download, reader sees no files, interrupted upload leaves nothing, no page errors |

Regressions on the same target, all passing: `demo:verify` 24, `demo:journey` 18, `demo:collection-journey` 31, `demo:record-journey` 39, `demo:isolation-journey` 57, `demo:browse-journey` 18, `demo:membership-journey` 66, `demo:definition-journey` 30, `demo:request-journey` 73, `demo:review-journey` full 67.

The first `demo:review-journey` full run stopped after 62 checks: its RESTART step killed the backend and could not relaunch it, because the target had no `instance-name` file. After adding the file and relaunching the backend with the binary the step uses, a run with the same run ID failed on its own leftover operation IDs. A run with a fresh run ID passed 67/67. The runbook above now names both requirements.

### Artifacts

`dist/attachment-journey/` (git-ignored, from run 4): `results-{backend,full}.json`, `evidence-{backend,full}.json`, the videos `en-US-requester.webm`, `en-US-reviewer.webm`, `en-US-reader.webm`, `zh-CN-requester.webm`, `zh-CN-reviewer.webm`, `zh-CN-reader.webm`, screenshots `<locale>-<role>-<step>.png` and console logs. Each full run's `results-full.json` and `evidence-full.json` are kept in `storage/attachments-18-fix-cVYyuF/runs/full-<n>/`. These files are not yet attached to issue #18 or a pull request.

## Retained resources

- `storage/attachments-18-fix-cVYyuF/`: the synthetic SQLite database and file store, private target configuration, run ID, password, per-run results and logs. Do not upload it. After the last attachment run the attachment, event and `_storage` tables hold 0 rows. The file store keeps 76 files (12,820,243 bytes) of deleted synthetic blobs, all accounted for by the reconciliation; deleting the directory removes them. The interrupted `demo:review-journey` run left its fixture rows under the first run ID.
- Better Auth keeps the synthetic users and sessions the journeys create (56 users and 118 sessions after the last attachment run).
- The backend (3380/3381) and Vite (5243) were stopped after the last run, and the ports were checked free.

## Not covered

- R2 or external storage, Office or image preview, virus scanning, live documents and migrating historical files.
- More than one attachment field per definition, attachment filters, sorts and list columns.
- Signed or public URLs and HTTP upload routes.
- Garbage collection of deleted blob files on the self-hosted backend's disk.
- The spec owner's confirmation of three choices (ADR-0010): no files for readers-preset holders, the revision raise on attach and remove, and the sweep cadence.
- Attaching the English and Chinese videos and the reconciliation evidence to issue #18 or its pull request.
