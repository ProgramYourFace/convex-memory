import { v, type Infer } from 'convex/values';
import { internal } from './_generated/api.js';
import type { Doc, Id } from './_generated/dataModel.js';
import { internalMutation, internalQuery, type MutationCtx, type QueryCtx } from './_generated/server.js';
import { INGEST, LIMITS, QUEUE } from './config.js';
import { checkFilter, checkLayers, ensureScope, fail, resolveScopes, scopeOfTags, writable, type ReadScope } from './scopes.js';
import { standsBelow, type StoredMemory } from './relate.js';
import { authorityValidator, filterValidator, kindValidator, settingsValidator, trustValidator, usageValidator, type MemoryHit, type MemoryItem, type MemorySettings, type MemoryUsage, type MessageHit } from './shapes.js';
import { hashId, messageId, normalizeTopic, topicsIn } from './text.js';

// The engine's reads and writes of its tables: the ingest queue (claim, release), the one transaction every write ends
// in (commit), the search channels reads use, the logs and the model settings. Actions (ingest.ts, read.ts, write.ts)
// call these; nothing here calls a model.

export type MemoryRow = Doc<'memories'>;
export type MessageRow = Doc<'messages'>;
export type ScopeId = Id<'scopes'>;

// ---------------------------------------------------------------- shapes out

export const itemOf = (m: MemoryRow): MemoryItem => ({
  id: m.memoryId,
  scope: m.scope,
  tags: m.tags,
  kind: m.kind,
  topic: m.topic ?? null,
  content: m.content,
  queries: m.queries,
  validFrom: m.validFrom ?? null,
  validTo: m.validTo ?? null,
  recordedAt: m.recordedAt,
  supersededAt: m.supersededAt ?? null,
  supersededBy: m.supersededBy ?? null,
  supersedes: m.supersedes ?? null,
  forgottenAt: m.forgottenAt ?? null,
  author: m.author,
  via: m.via ?? null,
  trust: m.trust,
  authority: m.authority ?? null,
  confidence: m.confidence,
  sources: m.sources,
});

export const storedOf = (m: MemoryRow): StoredMemory => ({
  id: m.memoryId,
  kind: m.kind,
  topic: m.topic ?? null,
  content: m.content,
  trust: m.trust,
  authority: m.authority ?? null,
  recordedAt: m.recordedAt,
  sources: m.sources,
  confidence: m.confidence,
});

export const hitOf = (m: MemoryRow, score: number): MemoryHit => ({
  id: m.memoryId,
  scope: m.scope,
  tags: m.tags,
  kind: m.kind,
  topic: m.topic ?? null,
  content: m.content,
  at: m.validFrom ?? m.recordedAt,
  trust: m.trust,
  confidence: m.confidence,
  score,
  sources: m.sources,
  author: m.author,
  via: m.via ?? null,
  layer: null,
});

export const messageHitOf = (m: MessageRow, score: number): MessageHit => ({
  id: m.messageId,
  scope: m.scope,
  tags: m.tags,
  session: m.session,
  role: m.role,
  author: m.author,
  trust: m.trust,
  content: m.content,
  at: m.at,
  score,
  layer: null,
});

/** A message as the pipeline reads it (text.ts Indexed without its index). */
export const pipelineMessageOf = (m: MessageRow) => ({
  id: m.messageId,
  role: m.role,
  author: m.author,
  ...(m.authorName ? { authorName: m.authorName } : {}),
  trust: m.trust,
  ...(m.authority ? { authority: m.authority } : {}),
  content: m.content,
  at: m.at,
  ...(m.tz ? { tz: m.tz } : {}),
});
export type PipelineMessage = ReturnType<typeof pipelineMessageOf>;

// ---------------------------------------------------------------- rows

export async function memoryDoc(ctx: Pick<QueryCtx, 'db'>, scope: ScopeId, id: string): Promise<MemoryRow | null> {
  return await ctx.db
    .query('memories')
    .withIndex('by_scope_memory', (q) => q.eq('scope', scope).eq('memoryId', id))
    .unique();
}

async function messageDoc(ctx: Pick<QueryCtx, 'db'>, scope: ScopeId, id: string): Promise<MessageRow | null> {
  return await ctx.db
    .query('messages')
    .withIndex('by_scope_message', (q) => q.eq('scope', scope).eq('messageId', id))
    .unique();
}

export async function scopeDoc(ctx: Pick<QueryCtx, 'db'>, id: ScopeId): Promise<Doc<'scopes'> | null> {
  return await ctx.db.get(id);
}

/** A scope that may still be written, or a refusal. */
export async function requireWritable(ctx: Pick<QueryCtx, 'db'>, id: ScopeId): Promise<Doc<'scopes'>> {
  const s = await scopeDoc(ctx, id);
  if (!(await writable(ctx, s))) fail('forbidden', 'Those tags were purged: reopen them to write to them again');
  return s!;
}

/** The newest version reachable forward from `id` (the chain's head). */
export async function headOf(ctx: Pick<QueryCtx, 'db'>, scope: ScopeId, id: string): Promise<MemoryRow | null> {
  let cur = await memoryDoc(ctx, scope, id);
  const seen = new Set<string>();
  while (cur?.supersededBy && !seen.has(cur.memoryId)) {
    seen.add(cur.memoryId);
    const next = await memoryDoc(ctx, scope, cur.supersededBy);
    if (!next) break;
    cur = next;
  }
  return cur;
}

/** `id` and every version before it (back through `supersedes`). */
export async function versionsBefore(ctx: Pick<QueryCtx, 'db'>, scope: ScopeId, id: string): Promise<MemoryRow[]> {
  const out: MemoryRow[] = [];
  const seen = new Set<string>();
  for (let cur = await memoryDoc(ctx, scope, id); cur && !seen.has(cur.memoryId); cur = cur.supersedes ? await memoryDoc(ctx, scope, cur.supersedes) : null) {
    seen.add(cur.memoryId);
    out.push(cur);
  }
  return out;
}

/** A memory's vector goes (it is no longer current). */
export async function dropVector(ctx: MutationCtx, m: MemoryRow): Promise<void> {
  if (!m.vectorized) return;
  for (const row of await ctx.db
    .query('vectors')
    .withIndex('by_memory', (q) => q.eq('memory', m._id))
    .collect())
    await ctx.db.delete(row._id);
}

/** `old` is no longer current: `byId` took its place at `at` (and ended its validity then). */
async function supersedeDoc(ctx: MutationCtx, old: MemoryRow, byId: string, at: number): Promise<void> {
  await dropVector(ctx, old);
  await ctx.db.patch(old._id, { supersededAt: at, supersededBy: byId, validTo: old.validTo ?? at, current: false, vectorized: false });
}

/** A topic the scope used now (the topic guess reads the most recently used). */
async function addTopic(ctx: MutationCtx, scope: ScopeId, topic: string): Promise<void> {
  const has = await ctx.db
    .query('topics')
    .withIndex('by_scope_topic', (q) => q.eq('scope', scope).eq('topic', topic))
    .first();
  if (has) await ctx.db.patch(has._id, { usedAt: Date.now() });
  else await ctx.db.insert('topics', { scope, topic, usedAt: Date.now() });
}

// ---------------------------------------------------------------- the logs

export const decisionValidator = v.object({
  stage: v.string(),
  model: v.string(),
  inputDigest: v.string(),
  /** JSON (relate.ts Decision's answer, stringified). */
  answer: v.string(),
  confidence: v.union(v.number(), v.null()),
  threshold: v.optional(v.union(v.number(), v.null())),
  memoryId: v.optional(v.union(v.string(), v.null())),
});
export type LoggedDecision = Infer<typeof decisionValidator>;

/** relate.ts Decision as logged: its answer as JSON, at most 4,000 characters. */
export const loggedOf = (d: { stage: string; model: string; inputDigest: string; answer: unknown; confidence: number | null; threshold?: number | null; memoryId?: string | null }): LoggedDecision => ({
  stage: d.stage,
  model: d.model,
  inputDigest: d.inputDigest,
  answer: JSON.stringify(d.answer ?? null).slice(0, 4_000),
  confidence: d.confidence,
  threshold: d.threshold ?? null,
  memoryId: d.memoryId ?? null,
});

export async function writeLogs(ctx: MutationCtx, scope: ScopeId, op: string, decisions: LoggedDecision[], usage: MemoryUsage | null): Promise<void> {
  const at = Date.now();
  for (const d of decisions)
    await ctx.db.insert('decisions', {
      scope,
      stage: d.stage,
      model: d.model,
      inputDigest: d.inputDigest,
      answer: d.answer,
      at,
      ...(d.confidence !== null ? { confidence: d.confidence } : {}),
      ...(d.threshold != null ? { threshold: d.threshold } : {}),
      ...(d.memoryId ? { memoryId: d.memoryId } : {}),
    });
  if (usage && usage.models.length) await ctx.db.insert('usage', { scope, op, models: usage.models, costMicros: usage.costMicros, at });
}

/**
 * A read's decisions and usage (context and recall log them after answering). A purged scope gets only its usage
 * (the spend): decisions about it would outlive its purge.
 */
export const logOp = internalMutation({
  args: { scope: v.id('scopes'), op: v.string(), decisions: v.array(decisionValidator), usage: v.union(usageValidator, v.null()) },
  handler: async (ctx, a) => writeLogs(ctx, a.scope, a.op, (await writable(ctx, await scopeDoc(ctx, a.scope))) ? a.decisions : [], a.usage),
});

// ---------------------------------------------------------------- the ingest queue

const leaseLive = (p: Doc<'scopes'>, now: number) => !!p.lease && p.lease.until > now;
const queueLive = (p: Doc<'scopes'>, now: number) => p.queuedAt !== undefined && p.queuedAt > now - QUEUE.leaseMs;

/** A drain for `p` at `at` (now by default), unless one holds it or is due already. */
export async function scheduleDrain(ctx: MutationCtx, p: Doc<'scopes'>, at = Date.now()): Promise<void> {
  const now = Date.now();
  if (leaseLive(p, now) || queueLive(p, now)) return;
  await ctx.scheduler.runAt(at, internal.ingest.drain, { scope: p._id });
  await ctx.db.patch(p._id, { queuedAt: at });
}

async function hasPending(ctx: Pick<QueryCtx, 'db'>, scope: ScopeId): Promise<boolean> {
  return !!(await ctx.db
    .query('messages')
    .withIndex('by_scope_pending', (q) => q.eq('scope', scope).eq('processed', false))
    .first());
}

/**
 * A drain takes the scope (the lease: one drain reads a scope's record at a time, so no two extract the same
 * messages) and its next batch: the oldest unread message's session, its unread messages in order (at most
 * INGEST.batchMessages and batchChars, the first always), and the messages said before it. Null when another drain
 * holds the scope, a retry is not due, or nothing is left to read. A lease that ran out is a drain that died or ran
 * past its time: it counts as a failure, so a batch that kills every drain is given up after QUEUE.maxFailures like one
 * that throws (and never spends on models forever).
 */
export const claim = internalMutation({
  args: { scope: v.id('scopes'), owner: v.string() },
  handler: async (ctx, { scope, owner }) => {
    const p = await scopeDoc(ctx, scope);
    const now = Date.now();
    if (!p || leaseLive(p, now) || (p.retryAt !== undefined && p.retryAt > now)) return null;
    // A purged scope's record is going; nothing more is learned from it.
    if (!(await writable(ctx, p))) {
      await ctx.db.patch(p._id, { queuedAt: undefined });
      return null;
    }
    const first = await ctx.db
      .query('messages')
      .withIndex('by_scope_pending', (q) => q.eq('scope', scope).eq('processed', false))
      .first();
    if (!first) {
      await ctx.db.patch(p._id, { queuedAt: undefined });
      return null;
    }
    const unread = await ctx.db
      .query('messages')
      .withIndex('by_scope_session', (q) => q.eq('scope', scope).eq('session', first.session).gte('at', first.at))
      .filter((q) => q.eq(q.field('processed'), false))
      .take(INGEST.batchMessages);
    const batch: MessageRow[] = [];
    let chars = 0;
    for (const m of unread) {
      if (batch.length && chars + m.content.length > INGEST.batchChars) break;
      batch.push(m);
      chars += m.content.length;
    }
    const failures = p.lease ? (p.failures ?? 0) + 1 : p.failures;
    if (failures !== undefined && failures >= QUEUE.maxFailures) {
      await giveUp(ctx, p, batch.map((m) => m.messageId), failures, 'lease ran out');
      return null;
    }
    const inBatch = new Set(batch.map((m) => m.messageId));
    const previous = (
      await ctx.db
        .query('messages')
        .withIndex('by_scope_session', (q) => q.eq('scope', scope).eq('session', first.session).lte('at', first.at))
        .order('desc')
        .filter((q) => q.eq(q.field('withheld'), false))
        .take(INGEST.previousMessages + batch.length)
    )
      .filter((m) => !inBatch.has(m.messageId))
      .slice(0, INGEST.previousMessages)
      .reverse();
    await ctx.db.patch(p._id, { lease: { owner, until: now + QUEUE.leaseMs }, queuedAt: undefined, ...(failures !== undefined ? { failures } : {}) });
    return { session: first.session, batch: batch.map(pipelineMessageOf), previous: previous.map(pipelineMessageOf) };
  },
});

/** The scope's next drain after this one: now while unread messages are left. */
async function releaseLease(ctx: MutationCtx, p: Doc<'scopes'>): Promise<void> {
  await ctx.db.patch(p._id, { lease: undefined, failures: undefined, retryAt: undefined });
  if (await hasPending(ctx, p._id)) await scheduleDrain(ctx, { ...p, lease: undefined, queuedAt: undefined });
}

/**
 * A drain that failed lets the scope go. The next try waits (1, 2, 4… minutes, at most an hour); after
 * QUEUE.maxFailures in a row its batch is marked read without memories (the record keeps it: recall's raw-message
 * channel still finds it) and logged, so one batch never holds the queue.
 */
export const release = internalMutation({
  args: { scope: v.id('scopes'), owner: v.string(), batch: v.array(v.string()), error: v.string() },
  handler: async (ctx, a) => {
    const p = await scopeDoc(ctx, a.scope);
    if (!p || p.lease?.owner !== a.owner) return;
    const failures = (p.failures ?? 0) + 1;
    if (failures >= QUEUE.maxFailures) {
      await giveUp(ctx, p, a.batch, failures, a.error);
      return;
    }
    const retryAt = Date.now() + Math.min(QUEUE.retryMaxMs, QUEUE.retryBaseMs * 2 ** (failures - 1));
    await ctx.db.patch(p._id, { lease: undefined, failures, retryAt, queuedAt: retryAt });
    await ctx.scheduler.runAt(retryAt, internal.ingest.drain, { scope: a.scope });
  },
});

/** A batch that failed QUEUE.maxFailures drains in a row is marked read without memories, logged, and the scope let go. */
async function giveUp(ctx: MutationCtx, p: Doc<'scopes'>, batch: string[], failures: number, error: string): Promise<void> {
  await markProcessed(ctx, p._id, batch);
  await writeLogs(ctx, p._id, 'ingest', [{ stage: 'ingest.gave_up', model: 'none', inputDigest: String(batch.length), answer: JSON.stringify({ failures, error: error.slice(0, 300) }), confidence: null }], null);
  await releaseLease(ctx, p);
}

async function markProcessed(ctx: MutationCtx, scope: ScopeId, ids: string[]): Promise<void> {
  for (const id of ids) {
    const m = await messageDoc(ctx, scope, id);
    if (m && !m.processed) await ctx.db.patch(m._id, { processed: true });
  }
}

// ---------------------------------------------------------------- the commit

export const rowValidator = v.object({
  /** text.ts memoryId of the row as planned (its `supersedes` the planned target). */
  id: v.string(),
  kind: kindValidator,
  topic: v.union(v.string(), v.null()),
  content: v.string(),
  queries: v.array(v.string()),
  sources: v.array(v.string()),
  author: v.string(),
  trust: trustValidator,
  validFrom: v.union(v.number(), v.null()),
  confidence: v.number(),
  authority: v.union(authorityValidator, v.null()),
  via: v.union(v.string(), v.null()),
  /** A stored memory id, or `row:<i>` of this commit. */
  supersedes: v.union(v.string(), v.null()),
  embedding: v.union(v.array(v.float64()), v.null()),
});
export type CommitRow = Infer<typeof rowValidator>;

/**
 * One write's transaction (ingest's batch, remember, restore): the new versions (a version already stored is left as
 * it is), what they supersede, sources and confidences, the vectors, the messages marked read, the logs. A version
 * supersedes the target it was planned against while that is still its chain's head; when another write moved the head
 * meanwhile (an edit, another drain), or the version stands below it, it is kept beside the head at the conflict
 * confidence: a plan made against an older state never silently replaces a newer one. A version resting on a withheld
 * message (a memory forgotten meanwhile: a merge of it would bring its words back) is not written. `also`: current versions
 * the first row replaces too (an edit over a topic's two current memories). With `owner` (a drain), the lease must
 * still be its own, and is let go. Refused (null) when the scope is gone (purged) or the lease is not the drain's.
 */
export const commit = internalMutation({
  args: {
    scope: v.id('scopes'),
    op: v.string(),
    owner: v.optional(v.string()),
    rows: v.array(rowValidator),
    also: v.optional(v.array(v.string())),
    confirm: v.array(v.object({ id: v.string(), sources: v.array(v.string()), step: v.number() })),
    confidence: v.array(v.object({ id: v.string(), value: v.number() })),
    outcome: v.array(v.union(v.object({ row: v.number() }), v.object({ existing: v.string() }))),
    processed: v.array(v.string()),
    decisions: v.array(decisionValidator),
    usage: usageValidator,
  },
  handler: async (ctx, a): Promise<{ ids: string[]; superseded: string[] } | null> => {
    const now = Date.now();
    const p = await scopeDoc(ctx, a.scope);
    if (!p || !(await writable(ctx, p))) return null;
    if (a.owner !== undefined && p.lease?.owner !== a.owner) return null;
    const ids = a.rows.map((r) => r.id);
    // A version said again after it was forgotten is a version of its own (its id is content-addressed, and the
    // forgotten row stays out of every read).
    for (const [i, id] of ids.entries()) if ((await memoryDoc(ctx, a.scope, id))?.forgottenAt !== undefined) ids[i] = await hashId(id, 'again', String(now));
    const superseded: string[] = [];
    const decisions = [...a.decisions];
    // Each source is looked up once per commit (a mutation reads at most 4,096 index ranges); the batch being marked
    // read is unread, so never withheld.
    const withheld = new Map<string, boolean>(a.processed.map((id) => [id, false]));
    for (const [i, r] of a.rows.entries()) {
      if (await restsOnWithheld(ctx, a.scope, r.sources, withheld)) {
        decisions.push({ stage: 'commit.withheld', model: 'none', inputDigest: r.id, answer: JSON.stringify({ supersedes: r.supersedes }), confidence: null });
        continue;
      }
      const local = r.supersedes?.startsWith('row:') ?? false;
      let sup = local ? ids[Number(r.supersedes!.slice(4))]! : r.supersedes;
      let confidence = r.confidence;
      if (sup && !local) {
        const head = await headOf(ctx, a.scope, sup);
        const below = !!head?.current && standsBelow(r, { trust: head.trust, authority: head.authority ?? null });
        const moved = !!head?.current && head.memoryId !== sup;
        sup = head?.current ? head.memoryId : null;
        if (below || moved) {
          // What it was planned against is no longer the head, or the head stands above it: kept beside it, unsure.
          decisions.push({ stage: below ? 'commit.below' : 'commit.moved', model: 'none', inputDigest: r.id, answer: JSON.stringify({ head: head!.memoryId, planned: r.supersedes }), confidence: null, memoryId: head!.memoryId });
          sup = null;
          confidence = Math.min(confidence, INGEST.conflictConfidence);
        }
      }
      // A version never supersedes itself (the same update written twice is one row).
      if (sup === ids[i]) sup = null;
      if (await memoryDoc(ctx, a.scope, ids[i]!)) continue;
      const by = a.rows.findIndex((x) => x.supersedes === `row:${i}`);
      const live = by < 0;
      const docId = await ctx.db.insert('memories', {
        scope: a.scope,
        tags: p.tags,
        memoryId: ids[i]!,
        kind: r.kind,
        ...(r.topic ? { topic: r.topic } : {}),
        content: r.content,
        queries: r.queries,
        searchText: [r.content, ...r.queries].join('\n'),
        ...(r.validFrom !== null ? { validFrom: r.validFrom } : {}),
        ...(live ? {} : { validTo: a.rows[by]!.validFrom ?? now, supersededAt: now, supersededBy: ids[by]! }),
        ...(sup ? { supersedes: sup } : {}),
        recordedAt: now,
        current: live,
        author: r.author,
        ...(r.via ? { via: r.via } : {}),
        trust: r.trust,
        ...(r.authority ? { authority: r.authority } : {}),
        confidence,
        sources: r.sources.slice(-INGEST.maxSources),
        vectorized: false,
      });
      if (r.topic) await addTopic(ctx, a.scope, r.topic);
      if (live && r.kind !== 'task' && r.embedding) {
        await ctx.db.insert('vectors', { scope: a.scope, kind: r.kind, memory: docId, embedding: r.embedding });
        await ctx.db.patch(docId, { vectorized: true });
      }
      if (sup && !local) {
        const old = await memoryDoc(ctx, a.scope, sup);
        if (old?.current) {
          await supersedeDoc(ctx, old, ids[i]!, r.validFrom ?? now);
          superseded.push(old.memoryId);
        }
      }
    }
    const first = a.rows[0];
    for (const id of a.also ?? []) {
      const old = await memoryDoc(ctx, a.scope, id);
      if (!first || !old?.current || old.memoryId === first.id || standsBelow(first, { trust: old.trust, authority: old.authority ?? null })) continue;
      await supersedeDoc(ctx, old, first.id, now);
      superseded.push(old.memoryId);
    }
    for (const c of a.confirm) {
      const m = await memoryDoc(ctx, a.scope, c.id);
      if (m) await ctx.db.patch(m._id, { sources: [...new Set([...m.sources, ...c.sources])].slice(-INGEST.maxSources), confidence: Math.min(1, m.confidence + c.step) });
    }
    for (const c of a.confidence) {
      const m = await memoryDoc(ctx, a.scope, c.id);
      if (m) await ctx.db.patch(m._id, { confidence: Math.max(0, Math.min(m.confidence, c.value)) });
    }
    await markProcessed(ctx, a.scope, a.processed);
    await writeLogs(ctx, a.scope, a.op, decisions, a.usage);
    if (a.owner !== undefined) await releaseLease(ctx, p);
    return { ids: [...new Set(a.outcome.map((o) => ('row' in o ? ids[o.row]! : o.existing)))], superseded };
  },
});

/** Whether any of `sources` is withheld (a source of a forgotten memory); `known` caches the answers. */
async function restsOnWithheld(ctx: Pick<QueryCtx, 'db'>, scope: ScopeId, sources: string[], known: Map<string, boolean>): Promise<boolean> {
  for (const id of sources) {
    if (!known.has(id)) known.set(id, !!(await messageDoc(ctx, scope, id))?.withheld);
    if (known.get(id)) return true;
  }
  return false;
}

// ---------------------------------------------------------------- what relate and the reads search

/** A scope's current memories under exactly `topic`. */
export const byTopic = internalQuery({
  args: { scope: v.id('scopes'), topic: v.string() },
  handler: async (ctx, { scope, topic }): Promise<StoredMemory[]> => {
    const rows = await ctx.db
      .query('memories')
      .withIndex('by_scope_topic', (q) => q.eq('scope', scope).eq('topic', topic))
      .order('desc')
      .filter((q) => q.eq(q.field('current'), true))
      .take(50);
    return rows.map(storedOf);
  },
});

async function searchCurrent(ctx: Pick<QueryCtx, 'db'>, scope: ScopeId, text: string, limit: number): Promise<MemoryRow[]> {
  return await ctx.db
    .query('memories')
    .withSearchIndex('search_text', (q) => q.search('searchText', text).eq('scope', scope).eq('current', true))
    .take(limit);
}

/** A scope's current memories matching `text` (text.ts searchText), best first. */
export const searchMemories = internalQuery({
  args: { scope: v.id('scopes'), text: v.string(), limit: v.number() },
  handler: async (ctx, { scope, text, limit }): Promise<StoredMemory[]> => (await searchCurrent(ctx, scope, text, limit)).map(storedOf),
});

/** Of vector search hits, the current memories of `scopes`, in order (a hit is always read back through the current view). */
export const hydrate = internalQuery({
  args: { vectors: v.array(v.id('vectors')), scopes: v.array(v.id('scopes')) },
  handler: async (ctx, a): Promise<MemoryRow[]> => {
    const out: MemoryRow[] = [];
    for (const id of a.vectors) {
      const vec = await ctx.db.get(id);
      const m = vec && (await ctx.db.get(vec.memory));
      if (m?.current && a.scopes.includes(m.scope)) out.push(m);
    }
    return out;
  },
});

/** Current memories under `topic` or a topic below it (`person.diet` finds `person.diet.allergies`), newest first. */
async function underTopic(ctx: Pick<QueryCtx, 'db'>, scope: ScopeId, topic: string, limit: number): Promise<MemoryRow[]> {
  const rows = await ctx.db
    .query('memories')
    .withIndex('by_scope_topic', (q) => q.eq('scope', scope).gte('topic', topic).lte('topic', `${topic}.￿`))
    .filter((q) => q.eq(q.field('current'), true))
    .take(limit * 4);
  return rows
    .filter((m) => m.topic === topic || m.topic!.startsWith(`${topic}.`))
    .sort((x, y) => y.recordedAt - x.recordedAt)
    .slice(0, limit);
}

export type Channels = { topic: MemoryRow[]; fts: MemoryRow[]; messages: MessageRow[]; instructions: MemoryRow[] };

/**
 * What each scope's search channels find: topics (given, and the cheap guess: of the scope's most recently used topics,
 * `topicLimit` of them, those whose words `guess` says), full text over current memories, full text over the record's
 * messages (never a withheld one), and the current standing instructions. No model. One answer per scope, in order.
 */
export const channels = internalQuery({
  args: {
    scopes: v.array(v.id('scopes')),
    topics: v.optional(v.array(v.string())),
    guess: v.optional(v.string()),
    topicLimit: v.optional(v.number()),
    text: v.optional(v.string()),
    messagesText: v.optional(v.string()),
    limit: v.number(),
    instructions: v.optional(v.number()),
  },
  handler: async (ctx, a): Promise<Channels[]> => {
    const given = (a.topics ?? []).map((t) => normalizeTopic(t)).filter((t): t is string => !!t);
    const out: Channels[] = [];
    for (const scope of a.scopes) {
      const topics = new Set(given);
      if (a.guess) {
        const known = await ctx.db
          .query('topics')
          .withIndex('by_scope_used', (q) => q.eq('scope', scope))
          .order('desc')
          .take(a.topicLimit ?? LIMITS.topics);
        for (const t of topicsIn(a.guess, known.map((k) => k.topic))) topics.add(t);
      }
      const topic: MemoryRow[] = [];
      const seen = new Set<string>();
      for (const t of topics)
        for (const m of await underTopic(ctx, scope, t, a.limit))
          if (!seen.has(m.memoryId) && topic.length < a.limit) {
            seen.add(m.memoryId);
            topic.push(m);
          }
      out.push({
        topic,
        fts: a.text ? await searchCurrent(ctx, scope, a.text, a.limit) : [],
        messages: a.messagesText
          ? await ctx.db
              .query('messages')
              .withSearchIndex('search_content', (q) => q.search('content', a.messagesText!).eq('scope', scope).eq('withheld', false))
              .take(a.limit)
          : [],
        instructions: a.instructions
          ? await ctx.db
              .query('memories')
              .withIndex('by_scope_kind', (q) => q.eq('scope', scope).eq('current', true).eq('kind', 'instruction'))
              .order('desc')
              .take(a.instructions)
          : [],
      });
    }
    return out;
  },
});

// ---------------------------------------------------------------- remember's and restore's reads

/**
 * What remember states goes into the record first (session `remember`), so its memory names a source like any other.
 * Words a forgotten memory rested on that the person states again are theirs to keep again: no longer withheld.
 */
export const recordStated = internalMutation({
  args: { tags: v.array(v.string()), content: v.string(), author: v.string(), authorName: v.optional(v.string()), trust: trustValidator, authority: v.optional(authorityValidator), settings: settingsValidator },
  handler: async (ctx, a): Promise<{ scope: ScopeId; source: string }> => {
    const scope = await ensureScope(ctx, a.tags);
    await saveSettings(ctx, a.settings);
    const id = await messageId('remember', 'user', a.content);
    const known = await messageDoc(ctx, scope._id, id);
    if (known?.withheld) await ctx.db.patch(known._id, { withheld: false });
    if (!known)
      await ctx.db.insert('messages', {
        scope: scope._id,
        tags: scope.tags,
        messageId: id,
        session: 'remember',
        role: 'user',
        author: a.author,
        ...(a.authorName ? { authorName: a.authorName } : {}),
        trust: a.trust,
        ...(a.authority ? { authority: a.authority } : {}),
        content: a.content,
        at: Date.now(),
        processed: true,
        withheld: false,
      });
    return { scope: scope._id, source: id };
  },
});

/** A scope's current memories of `kind` under exactly `topic` (an edit replaces them). */
export const currentOfTopic = internalQuery({
  args: { scope: v.id('scopes'), topic: v.string(), kind: kindValidator },
  handler: async (ctx, a): Promise<MemoryItem[]> => {
    const rows = await ctx.db
      .query('memories')
      .withIndex('by_scope_topic', (q) => q.eq('scope', a.scope).eq('topic', a.topic))
      .filter((q) => q.and(q.eq(q.field('current'), true), q.eq(q.field('kind'), a.kind)))
      .collect();
    return rows.sort((x, y) => y.recordedAt - x.recordedAt).map(itemOf);
  },
});

/**
 * A version, the head of its chain, and the other current memories of its topic and kind (what restoring it replaces).
 * The version's sources leave out withheld messages (another memory resting on them was forgotten).
 */
export const versionOf = internalQuery({
  args: { scope: v.id('scopes'), id: v.string() },
  handler: async (ctx, a): Promise<{ version: MemoryItem; head: MemoryItem | null; others: MemoryItem[] } | null> => {
    const m = await memoryDoc(ctx, a.scope, a.id);
    if (!m || m.forgottenAt !== undefined) return null;
    const head = await headOf(ctx, a.scope, m.memoryId);
    const keyed = m.kind === 'fact' || m.kind === 'instruction';
    const others = m.topic && keyed
      ? (
          await ctx.db
            .query('memories')
            .withIndex('by_scope_topic', (q) => q.eq('scope', a.scope).eq('topic', m.topic))
            .filter((q) => q.and(q.eq(q.field('current'), true), q.eq(q.field('kind'), m.kind)))
            .collect()
        ).filter((x) => x.memoryId !== head?.memoryId)
      : [];
    const sources: string[] = [];
    for (const id of m.sources) if ((await messageDoc(ctx, a.scope, id))?.withheld === false) sources.push(id);
    return { version: { ...itemOf(m), sources }, head: head?.current ? itemOf(head) : null, others: others.map(itemOf) };
  },
});

/** A memory by id (remember's and restore's answer). */
export const get = internalQuery({
  args: { scope: v.id('scopes'), id: v.string() },
  handler: async (ctx, a): Promise<MemoryItem | null> => {
    const m = await memoryDoc(ctx, a.scope, a.id);
    return m ? itemOf(m) : null;
  },
});

// ---------------------------------------------------------------- the model settings

/** Keeps the settings the app last sent, for the drains and the sweep it schedules (written only when they change). */
export async function saveSettings(ctx: MutationCtx, settings: MemorySettings): Promise<void> {
  const row = await ctx.db
    .query('settings')
    .withIndex('by_key', (q) => q.eq('key', 'models'))
    .unique();
  if (!row) await ctx.db.insert('settings', { key: 'models', value: settings });
  else if (JSON.stringify(row.value) !== JSON.stringify(settings)) await ctx.db.patch(row._id, { value: settings });
}

/** The settings the app last sent, or null when it never sent any. */
export const settings = internalQuery({
  args: {},
  handler: async (ctx): Promise<MemorySettings | null> =>
    (
      await ctx.db
        .query('settings')
        .withIndex('by_key', (q) => q.eq('key', 'models'))
        .unique()
    )?.value ?? null,
});

/** The scope of a tag set, or null when nothing was ever written under it. */
export const scopeOf = internalQuery({
  args: { tags: v.array(v.string()) },
  handler: async (ctx, a): Promise<ScopeId | null> => (await scopeOfTags(ctx, a.tags))?._id ?? null,
});

/** The scopes a read reaches (scopes.ts resolveScopes): its filter and layers, checked by the caller. */
export const resolve = internalQuery({
  args: { filter: filterValidator, layers: v.array(v.object({ name: v.string(), filter: filterValidator, weight: v.optional(v.number()) })) },
  handler: async (ctx, a): Promise<ReadScope[]> => await resolveScopes(ctx, checkFilter(a.filter), checkLayers(a.layers)),
});
