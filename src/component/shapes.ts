import { v, type Infer } from 'convex/values';

// The component's shapes: what callers send, what they get back, and the validators of both.

/**
 * Four kinds, after Cloudflare's Agent Memory: `fact` (keyed by topic; a newer one supersedes), `event` (time-anchored, never
 * supersedes), `instruction` (keyed; a standing rule for the assistant, only from trusted text) and `task` (work in
 * progress; full text only, never a vector).
 */
export const MEMORY_KINDS = ['fact', 'event', 'instruction', 'task'] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];
export const kindValidator = v.union(...MEMORY_KINDS.map((k) => v.literal(k)));

/** Who said it: a person, in their own words (`trusted`), or outside text (web, mail, apps, tool output: `untrusted`). */
export const TRUST = ['trusted', 'untrusted'] as const;
export type Trust = (typeof TRUST)[number];
export const trustValidator = v.union(...TRUST.map((t) => v.literal(t)));

/**
 * Standing on shared memory (a team's, a company's): `manager` or `member`, mapped by the app from its own roles. A
 * memory is a manager's only when every message it rests on is; what a member says never replaces what a manager set
 * (relate.ts `standsBelow`). Absent (a personal scope, the assistant's words) counts as a member's.
 */
export const AUTHORITY = ['manager', 'member'] as const;
export type Authority = (typeof AUTHORITY)[number];
export const authorityValidator = v.union(...AUTHORITY.map((a) => v.literal(a)));

export const ROLES = ['user', 'assistant', 'tool', 'system', 'note'] as const;
export type Role = (typeof ROLES)[number];

/** A dotted topic key: owner first, then subject, then detail (`person.diet`, `company.office.wifi`). */
export const TOPIC_RE = /^[a-z0-9][a-z0-9_-]*(?:\.[a-z0-9][a-z0-9_-]*){0,7}$/;
/** A memory version's or a message's id: the first 128 bits of a SHA-256, hex (text.ts). */
export const ID_RE = /^[0-9a-f]{32}$/;
/** An IANA time zone (`Europe/Lisbon`) or UTC. */
export const TZ_RE = /^(?:UTC|[A-Za-z]+(?:\/[A-Za-z0-9_+-]+){1,2})$/;
/** A speaker's display name: one line, no brackets (the writer reads it in quotes). */
export const NAME_RE = /^[^\r\n\u0000[\]"]{1,80}$/;

/** One message of an exchange, as ingest takes it. */
export const messageValidator = v.object({
  role: v.union(...ROLES.map((r) => v.literal(r))),
  /** Who wrote it: a user id, `assistant`, or a source (`web`, `mail`, `app:<slug>`). */
  author: v.string(),
  /** The speaker's display name, which memories name them by. */
  authorName: v.optional(v.string()),
  trust: trustValidator,
  /** Longer content is cut to LIMITS.messageChars. */
  content: v.string(),
  /** When it was said (ms): relative dates in it resolve against this. */
  at: v.number(),
  /** The speaker's IANA time zone: "yesterday" is their yesterday. Absent: UTC. */
  tz: v.optional(v.string()),
  /** Shared memory: the speaker's standing. */
  authority: v.optional(authorityValidator),
});
export type MemoryMessage = Infer<typeof messageValidator>;

/** Per model: calls and tokens; and what the op cost in micro-dollars (each call's `usage.cost`, else the settings' prices). */
export const usageValidator = v.object({
  models: v.array(v.object({ model: v.string(), calls: v.number(), inputTokens: v.number(), outputTokens: v.number() })),
  costMicros: v.number(),
});
export type MemoryUsage = Infer<typeof usageValidator>;

/** A memory version as callers see it (lists, history, remember's answer). */
export type MemoryItem = {
  id: string;
  /** The scope (one distinct tag set) it lives in, and its tags. */
  scope: string;
  tags: string[];
  kind: MemoryKind;
  topic: string | null;
  content: string;
  queries: string[];
  /** When it became true (an event's date, else when it was said). */
  validFrom: number | null;
  /** When a newer version replaced it. */
  validTo: number | null;
  recordedAt: number;
  supersededAt: number | null;
  supersededBy: string | null;
  supersedes: string | null;
  forgottenAt: number | null;
  author: string;
  via: string | null;
  trust: Trust;
  authority: Authority | null;
  confidence: number;
  /** The record's messages it came from (ids). */
  sources: string[];
};

/** A memory as a read finds it: ranked (`score`), dated (`at`: validFrom, else recordedAt). */
export type MemoryHit = Pick<MemoryItem, 'id' | 'scope' | 'tags' | 'kind' | 'topic' | 'content' | 'trust' | 'confidence' | 'sources' | 'author' | 'via'> & {
  at: number;
  score: number;
  /** The read's layer it came from (its name), or null for a read without layers. */
  layer: string | null;
};

/** A message of the record a read finds (recall's raw-message channel, searchHistory). */
export type MessageHit = { id: string; scope: string; tags: string[]; layer: string | null; session: string; role: Role; author: string; trust: Trust; content: string; at: number; score: number };


export const memoryItemValidator = v.object({
  id: v.string(),
  scope: v.string(),
  tags: v.array(v.string()),
  kind: kindValidator,
  topic: v.nullable(v.string()),
  content: v.string(),
  queries: v.array(v.string()),
  validFrom: v.nullable(v.number()),
  validTo: v.nullable(v.number()),
  recordedAt: v.number(),
  supersededAt: v.nullable(v.number()),
  supersededBy: v.nullable(v.string()),
  supersedes: v.nullable(v.string()),
  forgottenAt: v.nullable(v.number()),
  author: v.string(),
  via: v.nullable(v.string()),
  trust: trustValidator,
  authority: v.nullable(authorityValidator),
  confidence: v.number(),
  sources: v.array(v.string()),
});

const memoryHitFields = {
  id: v.string(),
  scope: v.string(),
  tags: v.array(v.string()),
  layer: v.nullable(v.string()),
  kind: kindValidator,
  topic: v.nullable(v.string()),
  content: v.string(),
  trust: trustValidator,
  confidence: v.number(),
  sources: v.array(v.string()),
  author: v.string(),
  via: v.nullable(v.string()),
  at: v.number(),
  score: v.number(),
};
export const memoryHitValidator = v.object(memoryHitFields);

const messageHitFields = {
  id: v.string(),
  scope: v.string(),
  tags: v.array(v.string()),
  layer: v.nullable(v.string()),
  session: v.string(),
  role: v.union(...ROLES.map((r) => v.literal(r))),
  author: v.string(),
  trust: trustValidator,
  content: v.string(),
  at: v.number(),
  score: v.number(),
};
export const messageHitValidator = v.object(messageHitFields);

/** searchHistory's hits: memories and messages, by `source`. */
export const historyHitValidator = v.union(v.object({ source: v.literal('memory'), ...memoryHitFields }), v.object({ source: v.literal('message'), ...messageHitFields }));

/**
 * How the component reaches its models (README "Models"). Nothing secret: `transport` is a function handle to an
 * action of the app's that sends each request with the app's credentials (the client's `defineModelTransport`), so no
 * key ever crosses into the component or rests in its tables.
 */
export const settingsValidator = v.object({
  /** A function handle (`createFunctionHandle`) to the app's transport action. */
  transport: v.string(),
  /**
   * `gateway`: the Convex AI Gateway's (OpenRouter-style) request shape: `provider` routing, `reasoning: { effort }`.
   * `openai`: plain OpenAI-compatible: no routing, `reasoning_effort`, and embeddings asked for their dimensions.
   */
  dialect: v.union(v.literal('gateway'), v.literal('openai')),
  /** The decision model on `/alpha/decisions`; null where there is none (the engine degrades: README "Models"). */
  decisionModel: v.nullable(v.string()),
  writerModel: v.string(),
  /** The writer's reasoning effort (`low` by default); null sends none. */
  writerReasoning: v.nullable(v.string()),
  embeddingModel: v.string(),
  /** Text put before a search's query when it is embedded (an instruction-tuned embedder's prompt); null for none. */
  embeddingQueryPrefix: v.nullable(v.string()),
  /** Routing fields merged into every request's `provider` (gateway dialect only). */
  routing: v.nullable(v.record(v.string(), v.any())),
  /** $ per million tokens [input, output] for calls whose answer reports no cost. */
  prices: v.array(v.object({ model: v.string(), input: v.number(), output: v.number() })),
});
export type MemorySettings = Infer<typeof settingsValidator>;

/** A tag filter (scopes.ts TagFilter): a tag, or { all?, any?, not? } of filters; checked in code (Convex validators are not recursive). */
export const filterValidator = v.any();
/** A read's layers, in order: each a name, a filter and an optional weight. */
export const layersValidator = v.optional(v.array(v.object({ name: v.string(), filter: filterValidator, weight: v.optional(v.number()) })));
