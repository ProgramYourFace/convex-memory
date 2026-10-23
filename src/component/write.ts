import { v } from 'convex/values';
import { holdsSecret, SECRET_IN_MEMORY } from './redact.js';
import { internal } from './_generated/api.js';
import { action, mutation } from './_generated/server.js';
import { INGEST, LIMITS, WRITER_ANSWER_TOKENS } from './config.js';
import type { Candidate } from './extract.js';
import { Models } from './models.js';
import { commitArgsOf, embedOrNot, embeddingTextOf, readerOf, relateAll } from './pipeline.js';
import { canonicalTags, fail, scopeOfTags } from './scopes.js';
import { CLASSIFY_SCHEMA, CLASSIFY_SYSTEM } from './prompts.js';
import { emptyPlan, standsBelow, type Plan } from './relate.js';
import { authorityValidator, kindValidator, MEMORY_KINDS, memoryItemValidator, NAME_RE, settingsValidator, TOPIC_RE, trustValidator, usageValidator, type MemoryItem, type MemoryKind, type MemoryUsage } from './shapes.js';
import { dropVector, memoryDoc, versionsBefore, writeLogs, type ScopeId } from './store.js';
import { digestOf, normalizeTopic } from './text.js';

// What people (and the assistant for them) do to memory directly (README "Remember, forget, restore"):
// remember a statement, forget a memory, restore an older version. Each ends in the same commit as ingest (store.ts),
// which re-checks standing against what is current when it writes.

const KEYED: readonly MemoryKind[] = ['fact', 'instruction'];
const VIA_RE = /^[\p{L}\p{N} .:_-]{1,80}$/u;

/** Plan → commit → the committed first row (null when the scope was purged meanwhile). */
async function commitPlan(ctx: Parameters<typeof readerOf>[0], scope: ScopeId, op: string, plan: Plan, models: Models, extra: { also?: string[]; processed?: string[] } = {}) {
  const r = await ctx.runMutation(internal.store.commit, { scope, op, ...(await commitArgsOf(plan)), also: extra.also ?? [], processed: extra.processed ?? [], usage: models.usage.toJSON() });
  if (!r || !r.ids[0]) fail('not_found', 'Those tags were purged meanwhile');
  const memory = await ctx.runQuery(internal.store.get, { scope, id: r!.ids[0]! });
  return { memory: memory!, superseded: r!.superseded };
}

/**
 * A memory someone states (an assistant's `remember` tool, a memory screen). The statement goes into the record (session
 * `remember`) as its source; the writer classifies it (kind, topic, the questions it answers) unless given. With a
 * `topic` on a keyed kind it is an edit: it replaces that topic's current memories, except those it stands below (an
 * untrusted edit beside a trusted one, a member's beside a manager's), which it is kept beside. Otherwise it is related
 * like an ingested memory. Untrusted text never sets an instruction; a key or token is never kept.
 */
const writeResult = v.object({ memory: memoryItemValidator, superseded: v.array(v.string()), usage: usageValidator });

export const remember = action({
  args: {
    /** The tag set it is remembered under (one scope: `["user:alice"]`). */
    tags: v.array(v.string()),
    content: v.string(),
    author: v.string(),
    authorName: v.optional(v.string()),
    /** The outside agent that kept it for the author (an MCP client), shown with it. */
    via: v.optional(v.string()),
    kind: v.optional(kindValidator),
    topic: v.optional(v.string()),
    /**
     * Whether the person's own words say it (`trusted`) or it came from outside text (`untrusted`): the caller always
     * says, since an agent asked to remember something may be repeating what a page or a mail told it.
     */
    trust: trustValidator,
    authority: v.optional(authorityValidator),
    settings: settingsValidator,
  },
  returns: writeResult,
  handler: async (ctx, a): Promise<{ memory: MemoryItem; superseded: string[]; usage: MemoryUsage }> => {
    const tags = canonicalTags(a.tags);
    const content = a.content.trim();
    const trust = a.trust;
    if (!content || content.length > LIMITS.rememberChars) fail('invalid', `A memory is 1 to ${LIMITS.rememberChars} characters`);
    if (!a.author || a.author.length > 128) fail('invalid', 'A memory needs its author');
    if (a.topic !== undefined && !TOPIC_RE.test(a.topic)) fail('invalid', 'A topic is a dotted key like person.diet');
    if (a.authorName !== undefined && !NAME_RE.test(a.authorName)) fail('invalid', 'A name is one line of at most 80 characters, no brackets or quotes');
    if (a.via !== undefined && !VIA_RE.test(a.via)) fail('invalid', 'A via is letters, digits, spaces and . : _ - only');
    if (trust === 'untrusted' && a.kind === 'instruction') fail('forbidden', 'Untrusted text cannot set an instruction');
    if (holdsSecret(content)) fail('invalid', SECRET_IN_MEMORY);
    const { scope, source } = await ctx.runMutation(internal.store.recordStated, {
      tags,
      content,
      author: a.author,
      trust,
      ...(a.authorName ? { authorName: a.authorName } : {}),
      ...(a.authority ? { authority: a.authority } : {}),
      settings: a.settings,
    });
    const models = new Models(ctx, a.settings);
    const given = `${a.kind ? `Kind: ${a.kind}\n` : ''}${a.topic ? `Topic: ${a.topic}\n` : ''}To remember: ${content}`;
    const c = await models.json<{ kind?: string; topic?: string; queries?: string[] }>(CLASSIFY_SYSTEM, given, CLASSIFY_SCHEMA, WRITER_ANSWER_TOKENS.classify);
    let kind: MemoryKind = a.kind ?? MEMORY_KINDS.find((k) => k === c?.kind) ?? 'fact';
    // Untrusted text is stored as a fact at most.
    if (trust === 'untrusted' && kind === 'instruction') kind = 'fact';
    const topic = a.topic ?? normalizeTopic(c?.topic);
    const queries = Array.isArray(c?.queries)
      ? c.queries
          .filter((q): q is string => typeof q === 'string')
          .map((q) => q.trim().slice(0, 200))
          .filter(Boolean)
          .slice(0, 5)
      : [];
    const now = Date.now();
    const cand: Candidate = {
      kind,
      topic,
      content,
      queries,
      sources: [source],
      author: a.author,
      trust,
      validFrom: now,
      at: now,
      confidence: trust === 'trusted' ? INGEST.rememberedConfidence : INGEST.newConfidence,
      authority: a.authority ?? null,
      via: a.via ?? null,
    };
    if (a.topic && KEYED.includes(kind)) {
      const current = await ctx.runQuery(internal.store.currentOfTopic, { scope, topic: a.topic, kind });
      const replace = current.filter((m) => !standsBelow(cand, m));
      const plan = emptyPlan();
      const conflicted = current.length > replace.length;
      const [embedding] = kind === 'task' ? [null] : await embedOrNot(models, [embeddingTextOf(cand)]);
      plan.rows.push({ ...cand, confidence: conflicted ? INGEST.conflictConfidence : cand.confidence, supersedes: replace[0]?.id ?? null, embedding: embedding ?? null });
      plan.outcome.push({ row: 0 });
      plan.decisions.push({ stage: 'remember.edit', model: 'none', inputDigest: await digestOf(content), answer: { topic: a.topic, replaced: replace.map((m) => m.id) }, confidence: null });
      return { ...(await commitPlan(ctx, scope, 'remember', plan, models, { also: replace.slice(1).map((m) => m.id) })), usage: models.usage.toJSON() };
    }
    const plan = await relateAll((embeddings) => readerOf(ctx, scope, models, embeddings), models, [cand]);
    return { ...(await commitPlan(ctx, scope, 'remember', plan, models)), usage: models.usage.toJSON() };
  },
});

/**
 * Forgets a memory: that version and every version before it leave the current view (and every read), their vectors
 * go, and the messages they came from are withheld (no read uses them again; the record keeps them). `authority`:
 * who asks, on a shared scope; unless a manager, a chain with a manager's version in it is refused.
 */
export const forget = mutation({
  args: { tags: v.array(v.string()), id: v.string(), authority: v.optional(authorityValidator) },
  returns: v.object({ forgotten: v.array(v.string()) }),
  handler: async (ctx, a): Promise<{ forgotten: string[] }> => {
    const s = await scopeOfTags(ctx, a.tags);
    const scope = s?._id;
    const m = scope && (await memoryDoc(ctx, scope, a.id));
    if (!m || m.forgottenAt !== undefined) fail('not_found', 'No such memory');
    const chain = await versionsBefore(ctx, scope!, a.id);
    if (a.authority !== 'manager' && chain.some((x) => x.authority === 'manager')) fail('forbidden', 'Only a manager may forget what a manager set');
    const now = Date.now();
    for (const x of chain) {
      await dropVector(ctx, x);
      await ctx.db.patch(x._id, { forgottenAt: x.forgottenAt ?? now, current: false, vectorized: false });
    }
    // Each source once: a chain of refinements repeats its sources version after version, and a mutation reads at most
    // 4,096 index ranges.
    for (const id of new Set(chain.flatMap((x) => x.sources))) {
      const msg = await ctx.db
        .query('messages')
        .withIndex('by_scope_message', (q) => q.eq('scope', scope!).eq('messageId', id))
        .unique();
      if (msg && !msg.withheld) await ctx.db.patch(msg._id, { withheld: true });
    }
    const forgotten = chain.map((x) => x.memoryId);
    await writeLogs(ctx, scope!, 'forget', [{ stage: 'forget', model: 'none', inputDigest: a.id, answer: JSON.stringify({ forgotten }), confidence: null, memoryId: a.id }], null);
    return { forgotten };
  },
});

/**
 * A new current version copying an older one (or a forgotten one's survivor), superseding what is current in its
 * chain and its topic. `authority`: who asks, on a shared scope; unless a manager, replacing a manager's current
 * version is refused.
 */
export const restore = action({
  args: { tags: v.array(v.string()), versionId: v.string(), authority: v.optional(authorityValidator), settings: settingsValidator },
  returns: writeResult,
  handler: async (ctx, a): Promise<{ memory: MemoryItem; superseded: string[]; usage: MemoryUsage }> => {
    const scope = await ctx.runQuery(internal.store.scopeOf, { tags: a.tags });
    const models = new Models(ctx, a.settings);
    const found = scope && (await ctx.runQuery(internal.store.versionOf, { scope, id: a.versionId }));
    if (!found) fail('not_found', 'No such version');
    const { version, head, others } = found!;
    if (head?.id === version.id) return { memory: version, superseded: [], usage: models.usage.toJSON() };
    if (a.authority !== 'manager' && [...(head ? [head] : []), ...others].some((m) => m.authority === 'manager')) fail('forbidden', 'Only a manager may replace what a manager set');
    const plan = emptyPlan();
    const [embedding] = version.kind === 'task' ? [null] : await embedOrNot(models, [embeddingTextOf(version)]);
    plan.rows.push({
      kind: version.kind,
      topic: version.topic,
      content: version.content,
      queries: version.queries,
      sources: version.sources,
      author: version.author,
      trust: version.trust,
      validFrom: version.validFrom,
      at: Date.now(),
      confidence: version.confidence,
      authority: version.authority,
      via: version.via,
      supersedes: head?.id ?? null,
      embedding: embedding ?? null,
    });
    plan.outcome.push({ row: 0 });
    plan.decisions.push({ stage: 'restore', model: 'none', inputDigest: version.id, answer: { from: version.id, replaced: head?.id ?? null }, confidence: null, memoryId: version.id });
    return { ...(await commitPlan(ctx, scope!, 'restore', plan, models, { also: others.map((m) => m.id) })), usage: models.usage.toJSON() };
  },
});
