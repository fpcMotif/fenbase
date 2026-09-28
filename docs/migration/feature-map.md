# Migration Feature Map

Migration path from NocoBase legacy client/server architecture to **TanStack Query** + **Effect-TS** (Frontend on **Cloudflare**) with **Convex** (Backend).

## Architecture Stack

| Layer | Technology | Role |
| :--- | :--- | :--- |
| **Backend / DB** | Convex (`convex`) | Reactive database, serverless queries/mutations, real-time sync |
| **Type & Error System** | Effect-TS (`effect`) | Typed RPC boundary, schema validation (`Schema`), error tagged unions |
| **Data Fetching & Cache** | TanStack Query (`@tanstack/react-query`) | Declarative hooks, query caching, invalidation, mutation tracking |
| **Edge Hosting** | Cloudflare Pages / Workers (`wrangler`) | Edge-rendered SPA bundle, edge functions, environment routing |

---

## Domain Entity Mapping

### 1. Auth & Users Subsystem
- **Legacy Subsystem**: `packages/core/auth`, `packages/plugins/@nocobase/plugin-auth`
- **Convex Target**: `convex/users.ts` (`viewer`, `login`, `register`, `getSession`)
- **Effect Schema**: `src/lib/effect/schemas/user.ts` (`UserSchema`, `AuthSessionSchema`, `AuthFailureError`)
- **TanStack Hook**: `useViewerQuery()`, `useLoginMutation()`
- **Edge Deployment**: Cloudflare JWT / cookie sessions via Pages Middleware

### 2. Collection & Data Modeling (ACL / Schema)
- **Legacy Subsystem**: `packages/core/database`, `packages/core/acl`
- **Convex Target**: `convex/schema.ts` (`defineSchema`, `defineTable`), `convex/collections.ts`
- **Effect Schema**: `src/lib/effect/schemas/collection.ts` (`RecordSchema`, `FilterRuleSchema`)
- **TanStack Hook**: `useCollectionRecordsQuery(name, filter)`, `useUpdateRecordMutation(name)`
- **Edge Deployment**: Real-time optimistic queries served over WebSocket to Cloudflare edge clients

### 3. Workflow Engine
- **Legacy Subsystem**: `packages/plugins/@nocobase/plugin-workflow`
- **Convex Target**: `convex/workflows.ts` (`triggerWorkflow`, `workflowExecutions`, `getExecutionLog`)
- **Effect Schema**: `src/lib/effect/schemas/workflow.ts` (`WorkflowExecutionSchema`, `StepResultSchema`)
- **TanStack Hook**: `useWorkflowExecutionsQuery()`, `useRunWorkflowMutation()`
- **Edge Deployment**: Webhook handlers hosted on Cloudflare Workers calling Convex internal mutations

### 4. File & Media Storage
- **Legacy Subsystem**: `packages/plugins/@nocobase/plugin-file-manager`
- **Convex Target**: `convex/files.ts` (`generateUploadUrl`, `saveFileMetadata`)
- **Effect Schema**: `src/lib/effect/schemas/file.ts` (`FileUploadResponseSchema`)
- **TanStack Hook**: `useUploadFileMutation()`, `useFileMetadataQuery()`
- **Edge Deployment**: Direct client upload to Convex File Storage or Cloudflare R2 bucket

---

## Migration Verification Matrix

| Check ID | Verification Dimension | Target Contract | Dry Run Behavior | Live Verification |
| :--- | :--- | :--- | :--- | :--- |
| `CHK-ENV` | Environment & Tooling | Bun/Bunx runtime, node engine >= 22 | Emits detected engines | Checks version strings |
| `CHK-DEP` | Dependencies | `convex`, `effect`, `@tanstack/react-query`, `wrangler` | Simulates package presence | Reads `package.json` |
| `CHK-CVX` | Convex Backend | `convex/schema.ts` valid definitions | Validates AST syntax | Verifies schema exports |
| `CHK-EFF` | Effect-TS Client | `src/lib/effect/client.ts` with error channels | Synthesizes sample pipe | Checks Effect module import |
| `CHK-TSQ` | TanStack Query Bridge | `useConvexEffectQuery` hook contract | Mock query execution | Validates hook signature |
| `CHK-CFL` | Cloudflare Config | `wrangler.jsonc` Pages config | Checks JSON schema | Validates output dir & compatibility |
