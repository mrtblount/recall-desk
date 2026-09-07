/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as crawl_cpsc from "../crawl/cpsc.js";
import type * as crawl_detail from "../crawl/detail.js";
import type * as crawl_extract from "../crawl/extract.js";
import type * as crawl_feeds from "../crawl/feeds.js";
import type * as crons from "../crons.js";
import type * as health from "../health.js";
import type * as http from "../http.js";
import type * as pools from "../pools.js";
import type * as recalls from "../recalls.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  "crawl/cpsc": typeof crawl_cpsc;
  "crawl/detail": typeof crawl_detail;
  "crawl/extract": typeof crawl_extract;
  "crawl/feeds": typeof crawl_feeds;
  crons: typeof crons;
  health: typeof health;
  http: typeof http;
  pools: typeof pools;
  recalls: typeof recalls;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {
  staticHosting: import("@convex-dev/static-hosting/_generated/component.js").ComponentApi<"staticHosting">;
  firecrawl: import("@firecrawl/firecrawl-convex/_generated/component.js").ComponentApi<"firecrawl">;
  crawlPool: import("@convex-dev/workpool/_generated/component.js").ComponentApi<"crawlPool">;
};
