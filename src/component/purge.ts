import { v } from 'convex/values';
import { internal } from './_generated/api.js';
import type { Id } from './_generated/dataModel.js';
import { internalMutation, mutation, type MutationCtx } from './_generated/server.js';
import { LIMITS } from './config.js';
import { canonicalTags, checkTag, fail, keyOf } from './scopes.js';

// Memory erased (README "Purge"): what the app calls when a person is deleted or asks to be forgotten.
//   by tag    `{ tag: "user:alice" }`: every scope whose tags include it, whatever else they hold. The tag is marked
//             purged first, so no write names it again (until the app reopens it); then each scope is erased and goes.
//   by scope  `{ tags: ["team:eng", "user:alice"] }`: exactly that tag set. Its scope becomes a tombstone first, so no
//             write reaches it again (until reopened); then its rows are erased.
// Either way a drain or a write in flight finds its scope purged and commits nothing. The record, memories, vectors,
// topics and decisions go, a page per mutation, the rest scheduled. Usage rows stay: they hold no content, and they
// are the app's spend.

const SCOPE_TABLES = ['messages', 'memories', 'vectors', 'topics', 'decisions'] as const;

async function page(ctx: MutationCtx, table: (typeof SCOPE_TABLES)[number], scope: Id<'scopes'>, n: number) {
  switch (table) {
    case 'messages':
      return await ctx.db
        .query('messages')
        .withIndex('by_scope_session', (q) => q.eq('scope', scope))
        .take(n);
    case 'memories':
      return await ctx.db
        .query('memories')
        .withIndex('by_scope_recorded', (q) => q.eq('scope', scope))
        .take(n);
    case 'vectors':
      return await ctx.db
        .query('vectors')
        .withIndex('by_scope', (q) => q.eq('scope', scope))
        .take(n);
    case 'topics':
      return await ctx.db
        .query('topics')
        .withIndex('by_scope_topic', (q) => q.eq('scope', scope))
        .take(n);
    case 'decisions':
      return await ctx.db
        .query('decisions')
        .withIndex('by_scope_at', (q) => q.eq('scope', scope))
        .take(n);
  }
}

/** Deletes up to `budget` of a scope's rows; answers what is left of the budget (0: maybe more to do). */
async function erase(ctx: MutationCtx, scope: Id<'scopes'>, budget: number): Promise<number> {
  let left = budget;
  for (const table of SCOPE_TABLES) {
    // A message may be 20,000 characters (up to ~80 KB): fewer of them per page keeps a mutation's reads under 16 MiB.
    const n = table === 'messages' ? Math.min(left, LIMITS.deleteMessagesPage) : left;
    const rows = await page(ctx, table, scope, n + 1);
    for (const row of rows.slice(0, n)) await ctx.db.delete(row._id);
    left -= Math.min(n, rows.length);
    if (rows.length > n || left === 0) return 0;
  }
  return left;
}

/** Whether a scope has no rows left. */
async function erased(ctx: MutationCtx, scope: Id<'scopes'>): Promise<boolean> {
  for (const table of SCOPE_TABLES) if ((await page(ctx, table, scope, 1)).length) return false;
  return true;
}

/** Marks a scope purged, letting its lease and queue go. */
async function tombstone(ctx: MutationCtx, id: Id<'scopes'>): Promise<void> {
  const s = (await ctx.db.get(id))!;
  if (s.purgedAt === undefined) await ctx.db.patch(id, { purgedAt: Date.now(), lease: undefined, queuedAt: undefined, failures: undefined, retryAt: undefined });
}

/** Removes a scope and its tag index rows. */
async function dropScope(ctx: MutationCtx, id: Id<'scopes'>): Promise<void> {
  for (const row of await ctx.db
    .query('scopeTags')
    .withIndex('by_scope', (q) => q.eq('scope', id))
    .collect())
    await ctx.db.delete(row._id);
  await ctx.db.delete(id);
}

/** One page of a tag's purge: scope after scope, each erased and removed; the rest scheduled. */
async function eraseTag(ctx: MutationCtx, tag: string): Promise<boolean> {
  let budget: number = LIMITS.deletePage;
  for (;;) {
    const ref = await ctx.db
      .query('scopeTags')
      .withIndex('by_tag', (q) => q.eq('tag', tag))
      .first();
    if (!ref) return true;
    // Each tag set costs index reads of its own whatever its rows (its tags, a page per table, its scope rows): charged
    // to the budget, so a tag held by many small tag sets stays within a mutation's 4,096 index ranges.
    budget -= LIMITS.scopeEraseCost;
    await tombstone(ctx, ref.scope);
    budget = budget > 0 ? await erase(ctx, ref.scope, budget) : 0;
    if (budget === 0) {
      await ctx.scheduler.runAfter(0, internal.purge.continuePurge, { tag });
      return false;
    }
    await dropScope(ctx, ref.scope);
  }
}

/** One page of a scope's purge; the rest scheduled. */
async function eraseScope(ctx: MutationCtx, scope: Id<'scopes'>): Promise<boolean> {
  if ((await erase(ctx, scope, LIMITS.deletePage)) > 0) return true;
  await ctx.scheduler.runAfter(0, internal.purge.continuePurge, { scope });
  return false;
}

const target = { tag: v.optional(v.string()), tags: v.optional(v.array(v.string())) };
const which = (a: { tag?: string; tags?: string[] }) => {
  if ((a.tag === undefined) === (a.tags === undefined)) fail('invalid', 'Give a tag or a tag set');
};

/**
 * Erases memory by tag (`{ tag }`: every scope holding it) or by exact tag set (`{ tags }`), and blocks writes to it
 * until `reopen`. Idempotent; answers whether it is all gone (else the rest is scheduled).
 */
export const purge = mutation({
  args: target,
  returns: v.object({ done: v.boolean() }),
  handler: async (ctx, a): Promise<{ done: boolean }> => {
    which(a);
    if (a.tag !== undefined) {
      checkTag(a.tag);
      const tag = a.tag;
      if (
        !(await ctx.db
          .query('purgedTags')
          .withIndex('by_tag', (q) => q.eq('tag', tag))
          .first())
      )
        await ctx.db.insert('purgedTags', { tag, at: Date.now() });
      return { done: await eraseTag(ctx, tag) };
    }
    const tags = canonicalTags(a.tags!);
    const key = keyOf(tags);
    const found = await ctx.db
      .query('scopes')
      .withIndex('by_key', (q) => q.eq('key', key))
      .unique();
    // A tag set never written is marked too, so nothing is written to it later.
    const id = found?._id ?? (await ctx.db.insert('scopes', { tags, key, createdAt: Date.now() }));
    if (!found) for (const tag of tags) await ctx.db.insert('scopeTags', { tag, scope: id });
    await tombstone(ctx, id);
    return { done: await eraseScope(ctx, id) };
  },
});

export const continuePurge = internalMutation({
  args: { tag: v.optional(v.string()), scope: v.optional(v.id('scopes')) },
  handler: async (ctx, a) => {
    if (a.tag !== undefined) await eraseTag(ctx, a.tag);
    else if (a.scope && (await ctx.db.get(a.scope))?.purgedAt !== undefined) await eraseScope(ctx, a.scope);
  },
});

/**
 * Lets a purged tag (`{ tag }`) or tag set (`{ tags }`) be written again (the person came back), once its purge has
 * finished. Refused while rows are still being erased, so nothing old survives into what is written next. One that was
 * never purged is left as it is.
 */
export const reopen = mutation({
  args: target,
  returns: v.object({ reopened: v.boolean() }),
  handler: async (ctx, a): Promise<{ reopened: boolean }> => {
    which(a);
    if (a.tag !== undefined) {
      checkTag(a.tag);
      const tag = a.tag;
      const mark = await ctx.db
        .query('purgedTags')
        .withIndex('by_tag', (q) => q.eq('tag', tag))
        .first();
      if (!mark) return { reopened: false };
      const left = await ctx.db
        .query('scopeTags')
        .withIndex('by_tag', (q) => q.eq('tag', tag))
        .first();
      if (left) fail('invalid', 'That tag is still being purged: try again in a moment');
      await ctx.db.delete(mark._id);
      return { reopened: true };
    }
    const key = keyOf(canonicalTags(a.tags!));
    const s = await ctx.db
      .query('scopes')
      .withIndex('by_key', (q) => q.eq('key', key))
      .unique();
    if (s?.purgedAt === undefined) return { reopened: false };
    if (!(await erased(ctx, s._id))) fail('invalid', 'That tag set is still being purged: try again in a moment');
    await dropScope(ctx, s._id);
    return { reopened: true };
  },
});
