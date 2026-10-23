import { ConvexError } from 'convex/values';
import type { Doc, Id } from './_generated/dataModel.js';
import type { MutationCtx, QueryCtx } from './_generated/server.js';
import { LIMITS } from './config.js';

// Tags and scopes. The app tags every write with a set of opaque tags it chooses (`user:alice`, `team:eng`,
// `agent:support`, `company`); each distinct set is a scope, and every row of the record and of memory names its scope.
// A read names a tag filter (all / any / not, nested); the scopes whose tags satisfy it are what it reads. Which tags a
// caller may write and which filters it may read is the app's to decide and enforce (README "Security"): the component
// trusts its arguments and never infers access.
//
// Convex's vector and search indexes filter by equality only (a vector filter may `or` equalities), so they cannot test
// "this row's tags include X". Partitioning by tag set makes every index filter an equality on `scope`: a read first
// finds the matching scopes through `scopeTags` (by tag, never a scan of every scope), then searches each scope (vectors:
// `or`s of up to LIMITS.vectorOr scopes per search) and merges.

/** A tag: 1 to LIMITS.tagChars letters, digits and `: . _ @ / # = + -`, starting with a letter or digit. */
export const TAG_RE = /^[A-Za-z0-9][A-Za-z0-9:._@/#=+-]*$/;

/** A tag filter: a tag, or `{ all?, any?, not? }` of filters (all of `all`, at least one of `any`, none of `not`). */
export type TagFilter = string | { all?: TagFilter[]; any?: TagFilter[]; not?: TagFilter[] };

/** Why an op was refused, as callers match it: `ConvexError` data `{ code, message }`. */
export type FailCode = 'invalid' | 'not_found' | 'forbidden';
export const fail = (code: FailCode, message: string): never => {
  throw new ConvexError({ code, message });
};

export function checkTag(tag: unknown): asserts tag is string {
  if (typeof tag !== 'string' || !tag.length || tag.length > LIMITS.tagChars || !TAG_RE.test(tag)) fail('invalid', `Not a tag: ${String(tag).slice(0, 80)}`);
}

/** A tag set as a scope holds it: each tag valid, sorted, once; 1 to LIMITS.scopeTags of them. */
export function canonicalTags(tags: string[]): string[] {
  tags.forEach(checkTag);
  const out = [...new Set(tags)].sort();
  if (!out.length || out.length > LIMITS.scopeTags) fail('invalid', `A write names 1 to ${LIMITS.scopeTags} tags`);
  return out;
}

export const keyOf = (tags: string[]) => tags.join('\u0000');

/**
 * A filter as reads take it: checked (its shape, its tags, at most LIMITS.filterDepth deep and LIMITS.filterNodes
 * nodes) and bounded: it must name tags a matching scope has to hold (a bare `not` would match every scope there is,
 * and finding those would read them all).
 */
export function checkFilter(f: unknown): TagFilter {
  let nodes = 0;
  const walk = (x: unknown, depth: number): void => {
    if (++nodes > LIMITS.filterNodes) fail('invalid', `A filter has at most ${LIMITS.filterNodes} nodes`);
    if (depth > LIMITS.filterDepth) fail('invalid', `A filter nests at most ${LIMITS.filterDepth} deep`);
    if (typeof x === 'string') return checkTag(x);
    if (!x || typeof x !== 'object' || Array.isArray(x)) return fail('invalid', 'A filter is a tag or { all?, any?, not? }');
    const o = x as Record<string, unknown>;
    for (const k of Object.keys(o)) if (k !== 'all' && k !== 'any' && k !== 'not') fail('invalid', `A filter has no "${k.slice(0, 20)}"`);
    for (const k of ['all', 'any', 'not'] as const) {
      if (o[k] === undefined) continue;
      if (!Array.isArray(o[k])) fail('invalid', `A filter's "${k}" is a list`);
      for (const c of o[k] as unknown[]) walk(c, depth + 1);
    }
    if (!(o.all as unknown[] | undefined)?.length && !(o.any as unknown[] | undefined)?.length) fail('invalid', 'A filter needs "all" or "any": "not" alone would match everything');
  };
  walk(f, 1);
  if (!bounded(f as TagFilter)) fail('invalid', 'A filter must name tags every match holds: give each "any" only bounded filters, or put one in "all"');
  return f as TagFilter;
}

/** Whether every scope matching `f` holds some tag `f` names positively (so its matches can be found by tag). */
function bounded(f: TagFilter): boolean {
  if (typeof f === 'string') return true;
  if (f.all?.some(bounded)) return true;
  return !!f.any?.length && f.any.every(bounded);
}

/** Whether a scope's tags satisfy `f`. */
export function matches(f: TagFilter, tags: ReadonlySet<string>): boolean {
  if (typeof f === 'string') return tags.has(f);
  if (f.all && !f.all.every((c) => matches(c, tags))) return false;
  if (f.any?.length && !f.any.some((c) => matches(c, tags))) return false;
  if (f.not?.some((c) => matches(c, tags))) return false;
  return true;
}

/** The scopes holding `tag`, or null when more than `cap` do. */
async function scopesWithTag(ctx: Pick<QueryCtx, 'db'>, tag: string, cap: number): Promise<Id<'scopes'>[] | null> {
  const rows = await ctx.db
    .query('scopeTags')
    .withIndex('by_tag', (q) => q.eq('tag', tag))
    .take(cap + 1);
  return rows.length > cap ? null : rows.map((r) => r.scope);
}

/**
 * Scopes that may match a bounded filter, found by its positive tags (a superset of its matches); null when more than
 * `cap` would have to be read.
 */
async function candidates(ctx: Pick<QueryCtx, 'db'>, f: TagFilter, cap: number): Promise<Set<Id<'scopes'>> | null> {
  if (typeof f === 'string') {
    const ids = await scopesWithTag(ctx, f, cap);
    return ids && new Set(ids);
  }
  const all = (f.all ?? []).filter(bounded);
  if (all.length) {
    // The smallest bounded member of `all` bounds the whole.
    let best: Set<Id<'scopes'>> | null = null;
    for (const c of all) {
      const s = await candidates(ctx, c, cap);
      if (s && (!best || s.size < best.size)) best = s;
    }
    return best;
  }
  const out = new Set<Id<'scopes'>>();
  for (const c of f.any ?? []) {
    const s = await candidates(ctx, c, cap);
    if (!s) return null;
    for (const id of s) out.add(id);
    if (out.size > cap) return null;
  }
  return out;
}

/** A scope a read reaches, and the layer it is read as. */
export type ReadScope = { id: Id<'scopes'>; tags: string[]; layer: number };

/** A read's layers: each a name, a filter and a weight; earlier layers come first. */
export type Layer = { name: string; filter: TagFilter; weight?: number };

/**
 * The scopes a read reaches: those matching `filter`, and when there are layers, the first layer each matches (one
 * matching no layer is not read). At most LIMITS.readScopes: a broader read is refused (README "Limits"). Purged scopes
 * are never read.
 */
export async function resolveScopes(ctx: Pick<QueryCtx, 'db'>, filter: TagFilter, layers: Layer[] = []): Promise<ReadScope[]> {
  const cap = LIMITS.readScopes;
  const found = await candidates(ctx, filter, cap);
  if (!found) return fail('invalid', `That filter reaches more than ${cap} tag sets: narrow it (README "Limits")`);
  const out: ReadScope[] = [];
  for (const id of found) {
    const s = await ctx.db.get(id);
    if (!s || s.purgedAt !== undefined) continue;
    const tags = new Set(s.tags);
    if (!matches(filter, tags)) continue;
    const layer = layers.length ? layers.findIndex((l) => matches(l.filter, tags)) : 0;
    if (layer < 0) continue;
    out.push({ id, tags: s.tags, layer });
  }
  return out.sort((a, b) => a.layer - b.layer || (a.id < b.id ? -1 : 1));
}

/** Checks a read's layers: at most LIMITS.layers, each named, its filter checked, its weight positive. */
export function checkLayers(layers: unknown): Layer[] {
  if (layers === undefined) return [];
  if (!Array.isArray(layers) || layers.length > LIMITS.layers) fail('invalid', `A read has at most ${LIMITS.layers} layers`);
  return (layers as Layer[]).map((l) => {
    if (!l || typeof l.name !== 'string' || !l.name.trim() || l.name.length > 40) fail('invalid', 'A layer needs a name of at most 40 characters');
    if (l.weight !== undefined && !(Number.isFinite(l.weight) && l.weight > 0)) fail('invalid', 'A layer weight is a positive number');
    return { name: l.name, filter: checkFilter(l.filter), ...(l.weight !== undefined ? { weight: l.weight } : {}) };
  });
}

/** Each layer's weight: as given, else 1, 0.8, 0.64… by order. */
export const layerWeights = (layers: Layer[]) => layers.map((l, i) => l.weight ?? 0.8 ** i);

/** The scope of a tag set, or null when none was ever written. */
export async function scopeOfTags(ctx: Pick<QueryCtx, 'db'>, tags: string[]): Promise<Doc<'scopes'> | null> {
  return await ctx.db
    .query('scopes')
    .withIndex('by_key', (q) => q.eq('key', keyOf(canonicalTags(tags))))
    .unique();
}

/** Whether any of `tags` was purged as a whole. */
async function anyPurgedTag(ctx: Pick<QueryCtx, 'db'>, tags: string[]): Promise<boolean> {
  for (const tag of tags)
    if (
      await ctx.db
        .query('purgedTags')
        .withIndex('by_tag', (q) => q.eq('tag', tag))
        .first()
    )
      return true;
  return false;
}

/** Whether a scope may be written: not purged, and none of its tags purged. */
export async function writable(ctx: Pick<QueryCtx, 'db'>, scope: Doc<'scopes'> | null): Promise<boolean> {
  return !!scope && scope.purgedAt === undefined && !(await anyPurgedTag(ctx, scope.tags));
}

/** The scope of a tag set, made when new; refused when it, or any of its tags, was purged (until reopened). */
export async function ensureScope(ctx: MutationCtx, raw: string[]): Promise<Doc<'scopes'>> {
  const tags = canonicalTags(raw);
  const key = keyOf(tags);
  const found = await ctx.db
    .query('scopes')
    .withIndex('by_key', (q) => q.eq('key', key))
    .unique();
  if (found?.purgedAt !== undefined || (await anyPurgedTag(ctx, tags))) fail('forbidden', 'Those tags were purged: reopen them to write to them again');
  if (found) return found;
  const id = await ctx.db.insert('scopes', { tags, key, createdAt: Date.now() });
  for (const tag of tags) await ctx.db.insert('scopeTags', { tag, scope: id });
  return (await ctx.db.get(id))!;
}

/** A scope by its tag set, refused when there is none. */
export async function requireScope(ctx: Pick<QueryCtx, 'db'>, tags: string[]): Promise<Doc<'scopes'>> {
  const s = await scopeOfTags(ctx, tags);
  if (!s) fail('not_found', 'Nothing was ever written under those tags');
  return s!;
}
