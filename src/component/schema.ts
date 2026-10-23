import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';
import { EMBEDDING_DIMENSIONS } from './config.js';
import { authorityValidator, kindValidator, ROLES, settingsValidator, trustValidator } from './shapes.js';

// The component's own tables (README "Storage"). Memory is partitioned by tag set: every message, memory, vector,
// topic and decision row names its `scope`, one distinct canonical set of the app's tags (`user:alice`, `team:eng`,
// `company`…). A read turns its tag filter into the scopes that match (through `scopeTags`), then searches those.
//   scopes      one per distinct tag set: its tags and key, its ingest lease and queue state (store.ts claim/release),
//               or its purge tombstone
//   scopeTags   one per (tag, scope): how a filter finds the scopes holding a tag without reading every scope
//   purgedTags  tags purged as a whole (a person deleted): no write names them until the app reopens them
//   messages    the record: every message ingested, once (content-addressed), the truth memories derive from
//   memories    versioned memories; the current view is `current` (not superseded, not forgotten)
//   vectors     one embedding per current, non-task memory (kept apart so reading memories never reads vectors)
//   topics      the topics a scope has used, and when last (the cheap topic guess reads the most recent ones)
//   decisions   every decision with its input's digest, answer, confidence, model and threshold
//   usage       what each op's model calls used and cost
//   settings    the last model settings the app sent (background drains and the sweep use them)

export default defineSchema({
  scopes: defineTable({
    /** The tag set, sorted and deduplicated (scopes.ts canonicalTags). */
    tags: v.array(v.string()),
    /** The tags joined by NUL: one scope per tag set. */
    key: v.string(),
    createdAt: v.number(),
    /** A drain is reading this scope's record: no other may until `until` (a drain that died frees it then). */
    lease: v.optional(v.object({ owner: v.string(), until: v.number() })),
    /** A drain is scheduled for then and has not claimed yet. */
    queuedAt: v.optional(v.number()),
    /** Drains that failed in a row, and when the next may run. */
    failures: v.optional(v.number()),
    retryAt: v.optional(v.number()),
    /** The scope was purged: nothing is written to it until the app reopens it (purge.ts). */
    purgedAt: v.optional(v.number()),
  }).index('by_key', ['key']),

  scopeTags: defineTable({ tag: v.string(), scope: v.id('scopes') })
    .index('by_tag', ['tag'])
    .index('by_scope', ['scope']),

  purgedTags: defineTable({ tag: v.string(), at: v.number() }).index('by_tag', ['tag']),

  messages: defineTable({
    scope: v.id('scopes'),
    /** The scope's tags (kept on the row, so a read answers them without another read). */
    tags: v.array(v.string()),
    /** text.ts messageId: session, role and content hashed. */
    messageId: v.string(),
    session: v.string(),
    role: v.union(...ROLES.map((r) => v.literal(r))),
    author: v.string(),
    authorName: v.optional(v.string()),
    trust: trustValidator,
    authority: v.optional(authorityValidator),
    content: v.string(),
    at: v.number(),
    tz: v.optional(v.string()),
    /** Memories were derived from it (or the gate found nothing in it): a drain never reads it again. */
    processed: v.boolean(),
    /** A source of a forgotten memory: no read uses it again (the record keeps it). */
    withheld: v.boolean(),
  })
    .index('by_scope_message', ['scope', 'messageId'])
    .index('by_scope_session', ['scope', 'session', 'at'])
    .index('by_scope_pending', ['scope', 'processed', 'at'])
    .index('by_pending', ['processed', 'at'])
    .searchIndex('search_content', { searchField: 'content', filterFields: ['scope', 'withheld'] }),

  memories: defineTable({
    scope: v.id('scopes'),
    tags: v.array(v.string()),
    /** text.ts memoryId: kind, topic, content and the version it supersedes, hashed. */
    memoryId: v.string(),
    kind: kindValidator,
    topic: v.optional(v.string()),
    content: v.string(),
    /** Questions it answers (searched with it, embedded with it). */
    queries: v.array(v.string()),
    /** What full text searches: content and queries (Convex searches one field). */
    searchText: v.string(),
    validFrom: v.optional(v.number()),
    validTo: v.optional(v.number()),
    recordedAt: v.number(),
    supersededAt: v.optional(v.number()),
    supersededBy: v.optional(v.string()),
    supersedes: v.optional(v.string()),
    forgottenAt: v.optional(v.number()),
    /** Neither superseded nor forgotten: what every read sees. */
    current: v.boolean(),
    author: v.string(),
    via: v.optional(v.string()),
    trust: trustValidator,
    authority: v.optional(authorityValidator),
    confidence: v.number(),
    /** The record's messages it rests on (message ids, the newest INGEST.maxSources). */
    sources: v.array(v.string()),
    /** It has a vectors row. */
    vectorized: v.boolean(),
  })
    .index('by_scope_memory', ['scope', 'memoryId'])
    .index('by_scope_current', ['scope', 'current', 'recordedAt'])
    .index('by_scope_kind', ['scope', 'current', 'kind', 'recordedAt'])
    .index('by_scope_topic', ['scope', 'topic', 'recordedAt'])
    .index('by_scope_recorded', ['scope', 'recordedAt'])
    .index('by_unvectorized', ['vectorized', 'current', 'kind'])
    .searchIndex('search_text', { searchField: 'searchText', filterFields: ['scope', 'current'] }),

  vectors: defineTable({
    scope: v.id('scopes'),
    kind: kindValidator,
    memory: v.id('memories'),
    embedding: v.array(v.float64()),
  })
    .index('by_memory', ['memory'])
    .index('by_scope', ['scope'])
    .vectorIndex('by_embedding', { vectorField: 'embedding', dimensions: EMBEDDING_DIMENSIONS, filterFields: ['scope', 'kind'] }),

  topics: defineTable({ scope: v.id('scopes'), topic: v.string(), usedAt: v.number() })
    .index('by_scope_topic', ['scope', 'topic'])
    .index('by_scope_used', ['scope', 'usedAt']),

  decisions: defineTable({
    scope: v.id('scopes'),
    stage: v.string(),
    model: v.string(),
    inputDigest: v.string(),
    /** The answer as JSON (at most 4,000 characters). */
    answer: v.string(),
    confidence: v.optional(v.number()),
    threshold: v.optional(v.number()),
    memoryId: v.optional(v.string()),
    at: v.number(),
  })
    .index('by_scope_at', ['scope', 'at'])
    .index('by_at', ['at']),

  usage: defineTable({
    scope: v.id('scopes'),
    op: v.string(),
    models: v.array(v.object({ model: v.string(), calls: v.number(), inputTokens: v.number(), outputTokens: v.number() })),
    costMicros: v.number(),
    at: v.number(),
  })
    .index('by_scope_at', ['scope', 'at'])
    .index('by_at', ['at']),

  settings: defineTable({ key: v.literal('models'), value: settingsValidator }).index('by_key', ['key']),
});
