import { createFunctionHandle, getServiceToken, getServiceUrl, internalActionGeneric } from 'convex/server';
import type { FunctionArgs, FunctionReference, FunctionReturnType, GenericActionCtx, GenericDataModel, GenericMutationCtx, GenericQueryCtx } from 'convex/server';
import { v } from 'convex/values';
import type { ComponentApi } from '../component/_generated/component.js';
import { DEFAULT_EMBEDDING_QUERY_PREFIX, DEFAULT_MODELS, DEFAULT_PRICES, DEFAULT_ROUTING, EMBEDDING_DIMENSIONS, ENDPOINTS } from '../component/config.js';
import type { TransportArgs, TransportResult } from '../component/models.js';
import type { MemorySettings } from '../component/shapes.js';

export { DEFAULT_MODELS, DEFAULT_PRICES, EMBEDDING_DIMENSIONS };
export type { MemorySettings, TransportArgs, TransportResult };
export type { MemoryHit, MemoryItem, MemoryKind, MemoryMessage, MemoryUsage, MessageHit, Authority, Trust, Role } from '../component/shapes.js';

import type { Layer, TagFilter } from '../component/scopes.js';
export type { Layer, TagFilter };

type RunQueryCtx = Pick<GenericQueryCtx<GenericDataModel>, 'runQuery'>;
type RunMutationCtx = Pick<GenericMutationCtx<GenericDataModel>, 'runQuery' | 'runMutation'>;
type RunActionCtx = Pick<GenericActionCtx<GenericDataModel>, 'runQuery' | 'runMutation' | 'runAction'>;

/** The app's transport action, as `defineModelTransport` defines it. */
export type TransportReference = FunctionReference<'action', 'internal' | 'public', TransportArgs, TransportResult>;

export type MemoryOptions = {
  /**
   * The app's transport action (`export const memoryTransport = defineModelTransport(…)` in the app's convex/ folder,
   * passed here as `internal.<file>.memoryTransport`). Every model request goes through it with the app's credentials.
   */
  transport: TransportReference;
  /**
   * `gateway` (default): the Convex AI Gateway's request shape (OpenRouter-style `provider` routing, `reasoning`), with
   * the decision model. `openai`: a plain OpenAI-compatible API (no routing; `reasoning_effort`; embeddings asked for
   * EMBEDDING_DIMENSIONS); no decision model unless one is named.
   */
  dialect?: 'gateway' | 'openai';
  /** The models by role. `decision: null` runs without a decision model (README "Models": what degrades). */
  models?: { decision?: string | null; writer?: string; embedding?: string };
  /** The writer's reasoning effort (gateway default `low`; openai default none). */
  writerReasoning?: string | null;
  /** Put before a search query when it is embedded (default: Qwen3 Embedding's instruction on the gateway, none on openai). */
  embeddingQueryPrefix?: string | null;
  /** Gateway routing merged into every request's `provider` (default: zero data retention, no data collection). */
  routing?: Record<string, unknown> | null;
  /** $ per million tokens for calls whose answer reports no cost (default: the default models' gateway prices). */
  prices?: { model: string; input: number; output: number }[];
};

/** The settings `options` stand for, but the transport's handle. */
export function settingsOf(options: Omit<MemoryOptions, 'transport'>): Omit<MemorySettings, 'transport'> {
  const dialect = options.dialect ?? 'gateway';
  const gateway = dialect === 'gateway';
  const writer = options.models?.writer ?? (gateway ? DEFAULT_MODELS.writer : undefined);
  const embedding = options.models?.embedding ?? (gateway ? DEFAULT_MODELS.embedding : undefined);
  if (!writer || !embedding) throw new Error('convex-memory: the openai dialect needs models.writer and models.embedding');
  return {
    dialect,
    decisionModel: options.models?.decision !== undefined ? options.models.decision : gateway ? DEFAULT_MODELS.decision : null,
    writerModel: writer,
    writerReasoning: options.writerReasoning !== undefined ? options.writerReasoning : gateway ? 'low' : null,
    embeddingModel: embedding,
    embeddingQueryPrefix: options.embeddingQueryPrefix !== undefined ? options.embeddingQueryPrefix : gateway ? DEFAULT_EMBEDDING_QUERY_PREFIX : null,
    routing: options.routing !== undefined ? options.routing : gateway ? { ...DEFAULT_ROUTING } : null,
    prices: options.prices ?? (gateway ? [...DEFAULT_PRICES] : []),
  };
}

type Api = ComponentApi;
type Without<F extends FunctionReference<any, any, any, any, any>, K extends string> = Omit<FunctionArgs<F>, K>;
/** A read's arguments, its filter and layers typed (the component checks them: Convex validators are not recursive). */
type Filtered<F extends FunctionReference<any, any, any, any, any>, K extends string = never> = Omit<FunctionArgs<F>, K | 'filter' | 'layers'> & { filter: TagFilter; layers?: Layer[] };

/**
 * Layered long-term memory for AI agents. Construct once per app:
 *
 * ```ts
 * const memory = new Memory(components.memory, { transport: internal.memory.transport });
 * ```
 *
 * Every method trusts its arguments: the app decides which tags a caller may write and which filters it may read, and
 * with what trust and authority (README "Security: what your app must enforce"). Never expose these calls to clients without that check.
 */
export class Memory {
  private readonly base: Omit<MemorySettings, 'transport'>;

  constructor(
    public readonly component: Api,
    private readonly options: MemoryOptions,
  ) {
    this.base = settingsOf(options);
  }

  /** The settings sent to the component: the transport as a function handle, and the models. */
  async settings(): Promise<MemorySettings> {
    return { ...this.base, transport: await createFunctionHandle(this.options.transport) };
  }

  /** Stores an exchange under a tag set (one scope); memories are derived in the background. Calls no model. */
  async ingest(ctx: RunMutationCtx, args: Without<Api['ingest']['ingest'], 'settings'>): Promise<FunctionReturnType<Api['ingest']['ingest']>> {
    return await ctx.runMutation(this.component.ingest.ingest, { ...args, settings: await this.settings() });
  }

  /** What to put in the model's window before a turn: standing instructions and relevant memories within a budget. */
  async context(ctx: RunActionCtx, args: Filtered<Api['read']['context'], 'settings'>): Promise<FunctionReturnType<Api['read']['context']>> {
    return await ctx.runAction(this.component.read.context, { ...args, settings: await this.settings() });
  }

  /** A deliberate search (an assistant's recall tool): five channels fused, and optionally an answer. */
  async recall(ctx: RunActionCtx, args: Filtered<Api['read']['recall'], 'settings'>): Promise<FunctionReturnType<Api['read']['recall']>> {
    return await ctx.runAction(this.component.read.recall, { ...args, settings: await this.settings() });
  }

  /** Remembers a statement (an edit when a topic is given on a fact or instruction). */
  async remember(ctx: RunActionCtx, args: Without<Api['write']['remember'], 'settings'>): Promise<FunctionReturnType<Api['write']['remember']>> {
    return await ctx.runAction(this.component.write.remember, { ...args, settings: await this.settings() });
  }

  /** Makes an older version current again (a new version copying it). */
  async restore(ctx: RunActionCtx, args: Without<Api['write']['restore'], 'settings'>): Promise<FunctionReturnType<Api['write']['restore']>> {
    return await ctx.runAction(this.component.write.restore, { ...args, settings: await this.settings() });
  }

  /** Forgets a memory and every version before it; their source messages are withheld from every read. */
  async forget(ctx: RunMutationCtx, args: FunctionArgs<Api['write']['forget']>): Promise<FunctionReturnType<Api['write']['forget']>> {
    return await ctx.runMutation(this.component.write.forget, args);
  }

  /** Full-text search over the record and current memories; no model. */
  async searchHistory(ctx: RunQueryCtx, args: Filtered<Api['read']['searchHistory']>): Promise<FunctionReturnType<Api['read']['searchHistory']>> {
    return await ctx.runQuery(this.component.read.searchHistory, args);
  }

  /** A page of the memories a filter reaches, newest first. */
  async list(ctx: RunQueryCtx, args: Omit<FunctionArgs<Api['read']['list']>, 'filter'> & { filter: TagFilter }): Promise<FunctionReturnType<Api['read']['list']>> {
    return await ctx.runQuery(this.component.read.list, args);
  }

  /** Every version of a topic, or of a version's chain. */
  async history(ctx: RunQueryCtx, args: FunctionArgs<Api['read']['history']>): Promise<FunctionReturnType<Api['read']['history']>> {
    return await ctx.runQuery(this.component.read.history, args);
  }

  /** A memory version by id in the scope of `tags` (null when there is none, or it was forgotten). */
  async get(ctx: RunQueryCtx, args: FunctionArgs<Api['read']['get']>): Promise<FunctionReturnType<Api['read']['get']>> {
    return await ctx.runQuery(this.component.read.get, args);
  }

  /** Erases memory by tag (`{ tag }`: every tag set holding it) or exact tag set (`{ tags }`); blocks writes to it until `reopen`. */
  async purge(ctx: RunMutationCtx, args: FunctionArgs<Api['purge']['purge']>): Promise<FunctionReturnType<Api['purge']['purge']>> {
    return await ctx.runMutation(this.component.purge.purge, args);
  }

  /** Lets a purged tag or tag set be written again once its purge has finished. */
  async reopen(ctx: RunMutationCtx, args: FunctionArgs<Api['purge']['reopen']>): Promise<FunctionReturnType<Api['purge']['reopen']>> {
    return await ctx.runMutation(this.component.purge.reopen, args);
  }

  /** The maintenance pass: run it from the app's crons every 15 minutes (README "Setup"). */
  async sweep(ctx: RunMutationCtx): Promise<null> {
    return await ctx.runMutation(this.component.sweep.run, { settings: await this.settings() });
  }
}

const PATHS: readonly string[] = Object.values(ENDPOINTS);

export type ModelTransportOptions = {
  /** The provider's base URL, without `/v1` (default: the Convex AI Gateway, at the deployment's `getServiceUrl('ai-gateway')`). */
  baseUrl?: string;
  /**
   * The bearer token, read inside the action (e.g. `() => process.env.OPENAI_API_KEY!`). Default on the gateway: the
   * deployment's short-lived `getServiceToken('ai-gateway')`. Required for any other base URL.
   */
  apiKey?: (ctx: GenericActionCtx<GenericDataModel>) => string | Promise<string>;
  /** Extra headers on every request. */
  headers?: Record<string, string>;
  /** How long one request may take (default 90 s). */
  timeoutMs?: number;
};

/**
 * The app's transport action: define it in your convex/ folder and pass its reference to `new Memory(…)`. It sends the
 * component's model requests (only the chat, embeddings and decisions paths) with the app's credentials, which never
 * leave this action, and answers each response's status and text (status 0 when no response came).
 *
 * ```ts
 * // convex/memory.ts
 * export const transport = defineModelTransport(); // the Convex AI Gateway
 * ```
 */
export function defineModelTransport(options: ModelTransportOptions = {}) {
  const fixed = options.baseUrl?.replace(/\/+$/, '');
  if (fixed !== undefined && !options.apiKey) throw new Error('convex-memory: defineModelTransport needs apiKey with a baseUrl (the deployment token is for the Convex AI Gateway only)');
  return internalActionGeneric({
    args: { path: v.string(), body: v.any(), keepDimensions: v.optional(v.number()) },
    returns: v.object({ status: v.number(), text: v.string() }),
    handler: async (ctx, a): Promise<TransportResult> => {
      if (!PATHS.includes(a.path)) return { status: 400, text: JSON.stringify({ error: { message: `Not a model path: ${a.path.slice(0, 80)}` } }) };
      // The gateway's address and a short-lived token for it, read here and never passed on.
      const base = fixed ?? (await getServiceUrl('ai-gateway'));
      const key = options.apiKey ? await options.apiKey(ctx) : await getServiceToken('ai-gateway');
      let res: Response;
      try {
        res = await fetch(`${base}${a.path}`, {
          method: 'POST',
          headers: { ...options.headers, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(a.body),
          signal: AbortSignal.timeout(options.timeoutMs ?? 90_000),
        });
      } catch (e) {
        return { status: 0, text: e instanceof Error ? e.message.slice(0, 300) : 'no response' };
      }
      let text = await res.text();
      // Only the head of each vector is kept by the component: send no more than that back.
      if (a.keepDimensions && res.ok && a.path === ENDPOINTS.embeddings) {
        try {
          const json = JSON.parse(text) as { data?: { embedding?: unknown }[] };
          for (const d of json.data ?? []) if (Array.isArray(d.embedding)) d.embedding = d.embedding.slice(0, a.keepDimensions);
          text = JSON.stringify(json);
        } catch {
          // not JSON: the component reports it
        }
      }
      return { status: res.status, text };
    },
  });
}
