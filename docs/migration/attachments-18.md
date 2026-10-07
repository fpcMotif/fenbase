# Issue #18: protected attachments on the configured HR reference

Issue [#18](https://github.com/fpcMotif/fenbase/issues/18) adds supporting documents to leave requests. Files live in Convex file storage behind authorized functions; no storage URL or storage ID ever reaches a client. The decision record is [ADR-0010](../adr/0010-protected-request-attachments.md).

## Contract

### Limits

| Limit | Value | Where |
| --- | --- | --- |
| Allowed types | PDF, PNG, JPEG, detected from the leading bytes and matched to the extension | `convex/attachmentModel.ts` |
| File size | 1 byte to the field's `maxBytes`; server ceiling 2 MiB (2,097,152 bytes) | field bounds and `upload` |
| Files per field | the field's `maxFiles`, 1 to 5 | field bounds, `upload` and submit |
| Files per request | 5 | `upload` |
| Attach events per draft | attaching stops at 20 events; a draft holds at most 25 attachment events | `upload` and draft deletion |
| Attachment fields per definition | 1 | `validateDefinition` |
| File name | NFC, without control characters, path separators or leading dots, at most 120 code points | `sanitizeFileName` |

The HR reference (`scripts/leave-definition.ts`) has an optional `supportingDocument` field with `maxFiles` 2, `maxBytes` 2 MiB and all three types. The builder edits it with "Maximum files", "Maximum file size (KB)" and "Allowed file types".

### Functions

- `requestAttachments.upload` (action): `{applicationId, requestId, fieldKey, fileName, bytes, expectedRevision, operationId}`. It checks access, the replay, the draft state and revision, the field and the limits through the internal query `authorizeUpload`, then the size, name and detected type, then stores the blob and links it through the internal mutation `attach`. `attach` repeats every check, reads `_storage` and requires the same size and SHA-256. If linking throws, the action deletes the blob. It returns `{attachmentId, revision, replayed, fileName, size, contentType, sha256}`.
- `requestAttachments.remove` (mutation): `{applicationId, requestId, attachmentId, expectedRevision, operationId}`. It deletes the row and the blob and returns `{revision, replayed}`.
- `requestAttachments.list` (query): `null` when the caller cannot read the request, `[]` when they can read it but not its files, otherwise `{_id, fieldKey, fileName, size, contentType, sha256, createdAt}` per file.
- `requestAttachments.download` (action): `{applicationId, attachmentId}`. The internal query `authorizeDownload` returns the same `null` for a missing, foreign, cross-application or denied file, which the action reports as `RECORD_NOT_FOUND`. The action re-hashes the bytes and refuses to return them if they changed.
- `requestAttachments.sweepOrphans` (internal mutation): deletes unlinked blobs older than 15 minutes, 200 per page, and schedules the next page. `convex/crons.ts` runs it every 30 minutes.
- Fixtures: `fixtures:removeRequestAttachments` removes rows, blobs and events in batches of 100; `fixtures:removeOrganization` fails with `FIXTURE_ATTACHMENTS_REMAIN` until it is done. `fixtures:storeOrphanFile` stores an unlinked blob for the sweep check.

Attach and remove raise the request revision and write an `attachmentEvents` row. New error codes, in en-US and zh-CN: `ATTACHMENT_TOO_LARGE`, `ATTACHMENT_TYPE_NOT_ALLOWED`, `ATTACHMENT_LIMIT_REACHED`, `ATTACHMENT_REQUIRED`, `ATTACHMENT_NAME_INVALID`.

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
| A link leaks | No link exists; the browser saves the returned bytes through an object URL it revokes at once |
| Download after losing access | Every call re-checks the session, membership, grants and request state |
| Submitted evidence is edited | Attach and remove require a draft; submit pins the set |
| Orphan blobs | The action deletes the blob when linking throws; the sweep covers crashes |
| A draft delete removes shared files | Rows are request-scoped and each blob has one owner |
| The audit log leaks content | Events hold metadata only; a unit test and `AUDIT-01` check for bytes, storage IDs and URLs |

### Revocation

No bearer link exists, so there is no link lifetime. The first retrieval after a revocation commits is denied. The journey measured it from the moment the revoking call returned to the denied response: 55 ms when the reviewer lost `reviewRequests` (`RECORD_NOT_FOUND`), 49 ms when the requester was deactivated (`APPLICATION_ACCESS_DENIED`), and 44 ms after the reviewer signed out (`Unauthenticated`). The residual window is one download whose access check passed before the revocation committed; it can still return its bytes. Bytes a user already saved cannot be recalled. The dialog's file list unmounts on sign-out or account switch.

### Demo UI

The request dialog shows each attachment field below the form fields: the limits, a list of files with name, size and the first 12 characters of the SHA-256, Download for everyone who may read the files, and Remove behind a confirmation inside the dialog's focus trap for the requester's draft. "Attach file" opens the file picker; it is disabled with "Save the draft to attach files." until the draft exists. Oversize files and wrong extensions are refused before upload; the server decides everything else. Results go to the field's `aria-live` output and errors to a focused alert. An upload that loses its connection says the file is attached only once the list shows it. Uploads and removals update only the dialog's revision, so unsaved form edits stay.

## Runbook

The target is a fresh self-hosted backend set up like the [approval-17 runbook](approval-17.md#runbook) on loopback 3370/3371, instance `attachments18`, `SITE_URL` `http://localhost:5233`, with `--local-storage "$ATTACHMENT_DIR/files"`.

```sh
ATTACHMENT_DIR="$ATTACHMENT_DIR" ATTACHMENT_JOURNEY_MODE=full VITE_CONVEX_URL=http://127.0.0.1:3370 \
  VITE_CONVEX_SITE_URL=http://127.0.0.1:3371 DEMO_APP_URL=http://localhost:5233 bun run demo:attachment-journey
```

`ATTACHMENT_JOURNEY_MODE` is `red`, `backend` or `full` (default). Results go to `dist/attachment-journey/results-<mode>.json` and `evidence-<mode>.json`. The full mode opens keyboard-only requester, reviewer and reader sessions in en-US and zh-CN, recorded as `<locale>-<role>.webm`.

### Reconciliation

`scripts/demo-attachment-reconcile.ts` runs before and after cleanup. Every attachment row needs one `_storage` blob with the same size and SHA-256, and an event chain ending in an attach with the same metadata. Every blob older than the grace window needs an owner. Every live blob needs a file on disk with its size and hash. Retrieved bytes must match their rows. `_storage.sha256` is base64 on this backend; the row and events store hex, and both spellings of one digest match.

The local backend keeps a deleted blob's file on disk. The reconciliation counts files that match no live blob as retained bytes instead of problems.

## Evidence

Revision exercised: `59840984c2` on `claude/issue-18-impl`. Date: 2026-10-07. Target: `storage/attachments-18-0KNmvi/`.

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

`attachmentView.test.ts` and its module were written together, so it has no recorded red run.

### Results

| Check | Outcome |
| --- | --- |
| `bunx vitest run -c vitest.demo.config.ts` | 485 passed |
| `demo:attachment-journey` backend | 31/31 |
| `demo:attachment-journey` full | 45/45 |
| FILE-01 | A 4,096-byte PDF and a 2 MiB PNG round-trip through the actions with matching size and SHA-256 |
| FILE-02 | `attach` is not public; a storage ID as an attachment ID fails validation; another organization's file and another request's file are `RECORD_NOT_FOUND` |
| FILE-03 | One byte over 2 MiB, renamed HTML, a PNG named `.pdf` and a third file are refused; client `contentType`, `size`, `sha256`, `uploaderMembershipId` and `storageId` fail validation; nothing changes |
| FILE-04 | Upload and remove after submit and after approval get `REQUEST_STATE_CONFLICT` |
| FILE-05 | The read matrix above, on a pending request and a draft |
| FILE-06 | The first retrieval after each revocation is denied; access returns after restoring |
| FILE-07 | An orphan inside the grace window is kept; with a zero grace window it is swept |
| FILE-08 | Deleting a draft removes its row, event and blob and leaves another draft's file |
| FILE-09 | A replayed upload returns the first attachment and stores no blob |
| AUDIT-01, RECON-01, CLEANUP-01 | Metadata-only events; rows, blobs, disk files and retrieved bytes agree; no row or blob is left |
| `ui.en.*`, `ui.zh.*` | Attach, remove, reload, download hash, submit, reviewer download, reader sees no files, interrupted upload leaves nothing, no page errors |

Regressions on the same target, all passing: `demo:verify` 24, `demo:journey` 18, `demo:collection-journey` 31, `demo:record-journey` 39, `demo:isolation-journey` 57, `demo:browse-journey` 18, `demo:membership-journey` 66, `demo:definition-journey` 30, `demo:request-journey` 73, `demo:review-journey` full 67.

### Artifacts

`dist/attachment-journey/`: `results-{red,backend,full}.json`, `evidence-{red,backend,full}.json`, the videos `en-US-requester.webm`, `en-US-reviewer.webm`, `en-US-reader.webm`, `zh-CN-requester.webm`, `zh-CN-reviewer.webm`, `zh-CN-reader.webm`, screenshots `<locale>-<role>-<step>.png` and console logs.

## Retained resources

- `storage/attachments-18-0KNmvi/`: the synthetic SQLite database and file store, private target configuration, run ID, password and logs. Do not upload it. After the runs the attachment, event and `_storage` tables hold 0 rows. The file store keeps 38 files (8,506,560 bytes) of deleted synthetic blobs, all accounted for by the reconciliation; deleting the directory removes them.
- Better Auth keeps the synthetic users and sessions the journeys create.
- The backend (3370/3371) and Vite (5233) were stopped after the last run.

## Not covered

- R2 or external storage, Office or image preview, virus scanning, live documents and migrating historical files.
- More than one attachment field per definition, attachment filters, sorts and list columns.
- Signed or public URLs and HTTP upload routes.
- Garbage collection of deleted blob files on the self-hosted backend's disk.
- The spec owner's confirmation of three choices (ADR-0010): no files for readers-preset holders, the revision raise on attach and remove, and the sweep cadence.
