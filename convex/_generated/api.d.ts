/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as __tests___helpers from '../__tests__/helpers.js';
import type * as auth from '../auth.js';
import type * as collections from '../collections.js';
import type * as demo from '../demo.js';
import type * as demoValidation from '../demoValidation.js';
import type * as fixtures from '../fixtures.js';
import type * as http from '../http.js';
import type * as membershipModel from '../membershipModel.js';
import type * as membershipValidators from '../membershipValidators.js';
import type * as memberships from '../memberships.js';
import type * as recordQuery from '../recordQuery.js';
import type * as records from '../records.js';
import type * as users from '../users.js';
import type * as workflows from '../workflows.js';

import type { ApiFromModules, FilterApi, FunctionReference } from 'convex/server';

declare const fullApi: ApiFromModules<{
  '__tests__/helpers': typeof __tests___helpers;
  auth: typeof auth;
  collections: typeof collections;
  demo: typeof demo;
  demoValidation: typeof demoValidation;
  fixtures: typeof fixtures;
  http: typeof http;
  membershipModel: typeof membershipModel;
  membershipValidators: typeof membershipValidators;
  memberships: typeof memberships;
  recordQuery: typeof recordQuery;
  records: typeof records;
  users: typeof users;
  workflows: typeof workflows;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<typeof fullApi, FunctionReference<any, 'public'>>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<typeof fullApi, FunctionReference<any, 'internal'>>;

export declare const components: {
  betterAuth: import('@convex-dev/better-auth/_generated/component.js').ComponentApi<'betterAuth'>;
};
