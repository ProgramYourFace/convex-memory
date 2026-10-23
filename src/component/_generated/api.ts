/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as config from "../config.js";
import type * as dates from "../dates.js";
import type * as extract from "../extract.js";
import type * as ingest from "../ingest.js";
import type * as models from "../models.js";
import type * as note from "../note.js";
import type * as pipeline from "../pipeline.js";
import type * as prompts from "../prompts.js";
import type * as purge from "../purge.js";
import type * as read from "../read.js";
import type * as redact from "../redact.js";
import type * as relate from "../relate.js";
import type * as rrf from "../rrf.js";
import type * as scopes from "../scopes.js";
import type * as shapes from "../shapes.js";
import type * as store from "../store.js";
import type * as sweep from "../sweep.js";
import type * as text from "../text.js";
import type * as write from "../write.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";
import { anyApi, componentsGeneric } from "convex/server";

const fullApi: ApiFromModules<{
  config: typeof config;
  dates: typeof dates;
  extract: typeof extract;
  ingest: typeof ingest;
  models: typeof models;
  note: typeof note;
  pipeline: typeof pipeline;
  prompts: typeof prompts;
  purge: typeof purge;
  read: typeof read;
  redact: typeof redact;
  relate: typeof relate;
  rrf: typeof rrf;
  scopes: typeof scopes;
  shapes: typeof shapes;
  store: typeof store;
  sweep: typeof sweep;
  text: typeof text;
  write: typeof write;
}> = anyApi as any;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
> = anyApi as any;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
> = anyApi as any;

export const components = componentsGeneric() as unknown as {};
