# Record browsing contract (demo collections)

`records.browse` (`convex/records.ts`) lists one owned collection's records with filters, a sort, and pages. The rules live in `convex/recordQuery.ts`, which the backend enforces and the demo client reuses for early validation.

## Filters

Every filter is combined with AND. At most 10 filters per query. Operators follow the NocoBase operators of the same name.

| Field type | Operators |
| --- | --- |
| text | `$includes`, `$notIncludes`, `$eq`, `$ne`, `$empty`, `$notEmpty` |
| number | `$eq`, `$ne`, `$gt`, `$gte`, `$lt`, `$lte`, `$empty`, `$notEmpty` |
| boolean | `$isTruly`, `$isFalsy` |

- `$includes` / `$notIncludes` ignore letter case, need a non-empty value, and skip records without a value.
- `$eq` on text is exact and case-sensitive.
- `$ne` and `$isFalsy` keep records without a value.
- Text `$empty` matches a missing value or `''`; number `$empty` matches a missing value.
- `$empty`, `$notEmpty`, `$isTruly`, and `$isFalsy` take no value. Other operators need a value of the field's type; text values are at most 4000 characters, numbers must be finite.

## Sort

One sort key: any field, or `_creationTime`. Direction `asc` or `desc`. Default: `_creationTime` descending (newest first).

- A missing value sorts as the largest value: last when ascending, first when descending. An empty text value `''` is a value and sorts first when ascending, like PostgreSQL.
- Text compares by lower-cased code units, then by exact text. No locale collation.
- Ties fall back to newest first, then record id, so page boundaries are stable.

## Pages

`page` is a positive integer; `pageSize` is 1–100 (default 20). The response carries `items`, `total` (matches), `collectionTotal` (all records), `page`, `pageSize`, and `pageCount`. A page past the end returns the last page instead, so a client on a page emptied by deletions moves back. No matches return one empty page.

## Limits

Convex cannot index the dynamic field names inside `values`, so the backend reads the collection's records through the bounded `by_owner_and_collection` index and filters in memory.

- A collection holds at most 1000 records. Creating one more fails with `RECORD_COLLECTION_FULL`.
- A collection above 1000 records (only possible through data written outside `records.create`) fails to browse with `RECORD_BROWSE_LIMIT_EXCEEDED`. Results are never silently truncated.
- Convex's per-function read limit (about 16 MiB, see https://docs.convex.dev/production/state/limits) also applies. Browsing and creating stay within it while records average under about 16 KB. A collection that exceeds it (for example 1000 records with several near-4000-character text fields) fails with a generic translated error instead of returning partial results. Lifting this needs a stored record count or a per-record size budget; neither is part of this slice.

## Errors

Input with the right shape but unsupported content fails with a coded `ConvexError` that the demo translates: `RECORD_QUERY_FIELD_UNKNOWN`, `RECORD_QUERY_OPERATOR_INVALID`, `RECORD_QUERY_VALUE_INVALID` (each with `field`), `RECORD_QUERY_FILTER_COUNT_INVALID`, `RECORD_QUERY_SORT_INVALID`, `RECORD_QUERY_PAGE_INVALID`. Input with the wrong shape (for example `value: null`, a missing `operator`, or a string `page`) is rejected by Convex argument validation with an untranslated error; the app never sends it. Unauthenticated calls fail; another user's collection fails with `COLLECTION_NOT_FOUND`.

## Verification

`bun run demo:browse-journey` (local Convex and Vite targets only) seeds 25 records, reconciles every page through the API and the app, and checks combined filters, tie order, page resets, translated errors, empty results, page boundaries after deletion and creation, and cross-user denial. Set `DEMO_CHROMIUM_PATH` to use a Chromium binary instead of installed Chrome.
