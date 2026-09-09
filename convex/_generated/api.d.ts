/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as ai from "../ai.js";
import type * as auth from "../auth.js";
import type * as crawl_cpsc from "../crawl/cpsc.js";
import type * as crawl_detail from "../crawl/detail.js";
import type * as crawl_extract from "../crawl/extract.js";
import type * as crawl_fda from "../crawl/fda.js";
import type * as crawl_feeds from "../crawl/feeds.js";
import type * as crawl_fsis from "../crawl/fsis.js";
import type * as crons from "../crons.js";
import type * as email from "../email.js";
import type * as emailParse from "../emailParse.js";
import type * as health from "../health.js";
import type * as http from "../http.js";
import type * as items from "../items.js";
import type * as mail from "../mail.js";
import type * as pools from "../pools.js";
import type * as recalls from "../recalls.js";
import type * as tags from "../tags.js";
import type * as users from "../users.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  ai: typeof ai;
  auth: typeof auth;
  "crawl/cpsc": typeof crawl_cpsc;
  "crawl/detail": typeof crawl_detail;
  "crawl/extract": typeof crawl_extract;
  "crawl/fda": typeof crawl_fda;
  "crawl/feeds": typeof crawl_feeds;
  "crawl/fsis": typeof crawl_fsis;
  crons: typeof crons;
  email: typeof email;
  emailParse: typeof emailParse;
  health: typeof health;
  http: typeof http;
  items: typeof items;
  mail: typeof mail;
  pools: typeof pools;
  recalls: typeof recalls;
  tags: typeof tags;
  users: typeof users;
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
  llmPool: import("@convex-dev/workpool/_generated/component.js").ComponentApi<"llmPool">;
  agentmail: import("@agentmail/convex/_generated/component.js").ComponentApi<"agentmail">;
};
