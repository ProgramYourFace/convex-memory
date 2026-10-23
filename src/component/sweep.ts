import { v } from 'convex/values';
import { internal } from './_generated/api.js';
import type { Doc, Id } from './_generated/dataModel.js';
import { internalAction, internalMutation, internalQuery, mutation, type QueryCtx } from './_generated/server.js';
import { LIMITS, QUEUE } from './config.js';
import { Models } from './models.js';
import { embedOrNot, embeddingTextOf } from './pipeline.js';
import { settingsValidator, usageValidator } from './shapes.js';
import { saveSettings, writeLogs } from './store.js';

// The sweep, which the app runs from its own crons.ts (every 15 minutes; README "Setup"): a scope with unread messages
// and no drain due gets one (a drain that died, or one whose schedule was lost); current memories whose embedding failed
// are embedded; decisions and usage past LIMITS.logKeepMs go.

const VECTOR_KINDS = ['fact', 'event', 'instruction'] as const;

export const run = mutation({
  args: { settings: v.optional(settingsValidator) },
  returns: v.null(),
  handler: async (ctx, a) => {
    if (a.settings) await saveSettings(ctx, a.settings);
    const now = Date.now();
    // The scopes with unread messages: found from the messages (indexed by unread), not by reading every scope.
    const unread = await ctx.db
      .query('messages')
      .withIndex('by_pending', (q) => q.eq('processed', false))
      .take(LIMITS.deletePage);
    for (const id of new Set(unread.map((m) => m.scope))) {
      const p = await ctx.db.get(id);
      if (!p || p.purgedAt !== undefined) continue;
      const busy = (p.lease && p.lease.until > now) || (p.queuedAt !== undefined && p.queuedAt > now - QUEUE.leaseMs);
      if (busy) continue;
      const at = Math.max(now, p.retryAt ?? now);
      await ctx.scheduler.runAt(at, internal.ingest.drain, { scope: p._id });
      // A lapsed lease stays: the drain's claim counts it as a failure (store.ts claim).
      await ctx.db.patch(p._id, { queuedAt: at });
    }
    for (const table of ['decisions', 'usage'] as const) {
      const old = await ctx.db
        .query(table)
        .withIndex('by_at', (q) => q.lt('at', now - LIMITS.logKeepMs))
        .take(LIMITS.deletePage);
      for (const row of old) await ctx.db.delete(row._id);
    }
    if ((await unvectorized(ctx, 1)).length) await ctx.scheduler.runAfter(0, internal.sweep.embedMissing, {});
    return null;
  },
});

async function unvectorized(ctx: Pick<QueryCtx, 'db'>, n: number): Promise<Doc<'memories'>[]> {
  const out: Doc<'memories'>[] = [];
  for (const kind of VECTOR_KINDS) {
    out.push(
      ...(await ctx.db
        .query('memories')
        .withIndex('by_unvectorized', (q) => q.eq('vectorized', false).eq('current', true).eq('kind', kind))
        .take(n - out.length)),
    );
    if (out.length >= n) break;
  }
  return out;
}

/** Current memories that have no vector (their embedding failed when they were written), a page. */
export const missingVectors = internalQuery({
  args: { limit: v.number() },
  handler: async (ctx, { limit }) => (await unvectorized(ctx, limit)).map((m) => ({ id: m._id, scope: m.scope, text: embeddingTextOf(m) })),
});

export const setVectors = internalMutation({
  args: { items: v.array(v.object({ id: v.id('memories'), embedding: v.array(v.float64()) })), scope: v.id('scopes'), usage: usageValidator },
  handler: async (ctx, a) => {
    for (const it of a.items) {
      const m = await ctx.db.get(it.id);
      if (!m?.current || m.vectorized || m.kind === 'task') continue;
      await ctx.db.insert('vectors', { scope: m.scope, kind: m.kind, memory: m._id, embedding: it.embedding });
      await ctx.db.patch(m._id, { vectorized: true });
    }
    await writeLogs(ctx, a.scope, 'embed', [], a.usage);
  },
});

/** Embeds a page of memories that have no vector, per scope (so each scope's usage is its own). */
export const embedMissing = internalAction({
  args: {},
  handler: async (ctx) => {
    const settings = await ctx.runQuery(internal.store.settings, {});
    if (!settings) return;
    const missing = await ctx.runQuery(internal.sweep.missingVectors, { limit: 64 });
    const byScope = new Map<Id<'scopes'>, typeof missing>();
    for (const m of missing) byScope.set(m.scope, [...(byScope.get(m.scope) ?? []), m]);
    for (const [scope, items] of byScope) {
      const models = new Models(ctx, settings);
      const vectors = await embedOrNot(
        models,
        items.map((m) => m.text),
      );
      const done = items.flatMap((m, i) => (vectors[i] ? [{ id: m.id, embedding: vectors[i]! }] : []));
      await ctx.runMutation(internal.sweep.setVectors, { items: done, scope, usage: models.usage.toJSON() });
    }
  },
});
