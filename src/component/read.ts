import { paginationOptsValidator } from 'convex/server';
import { v } from 'convex/values';
import { mergedStream, stream } from 'convex-helpers/server/stream';
import { internal } from './_generated/api.js';
import type { Id } from './_generated/dataModel.js';
import { action, query, type ActionCtx, type QueryCtx } from './_generated/server.js';
import { CONTEXT, LIMITS, RECALL, THRESHOLDS, WRITER_ANSWER_TOKENS } from './config.js';
import { Models, pYes, type DecisionQuestion } from './models.js';
import { noteOf } from './note.js';
import { ANALYZE_SCHEMA, ANALYZE_SYSTEM, CONTEXT_GATE, SYNTHESIS_SYSTEM } from './prompts.js';
import type { Decision } from './relate.js';
import { fuse, interleave } from './rrf.js';
import schema from './schema.js';
import { checkFilter, checkLayers, fail, layerWeights, resolveScopes, scopeOfTags, type Layer, type ReadScope } from './scopes.js';
import {
  filterValidator,
  historyHitValidator,
  kindValidator,
  layersValidator,
  memoryHitValidator,
  memoryItemValidator,
  messageHitValidator,
  settingsValidator,
  usageValidator,
  type MemoryHit,
  type MemoryItem,
  type MemoryUsage,
  type MessageHit,
} from './shapes.js';
import { hitOf, itemOf, loggedOf, memoryDoc, messageHitOf, type Channels, type MemoryRow, type MessageRow, type ScopeId } from './store.js';
import { clip, digestOf, estimateTokens, keywords, searchText } from './text.js';

// The reads (README "Reading"): `context` before each turn (no language model: the decision model's gate, the cheap
// channels, its prune, the budget), `recall` for an assistant's recall tool (five channels fused, an optional answer),
// and the queries a memory screen and search use (no model at all). Each read names a tag filter and, optionally,
// layers: the scopes it reaches are found first (scopes.ts), then searched, and what each finds is weighted by its
// layer and labeled with it.

type Found = { kind: 'memory'; m: MemoryRow } | { kind: 'message'; m: MessageRow };
const keyOf = (f: Found) => `${f.kind === 'memory' ? 'm' : 'r'}:${f.m.scope}:${f.kind === 'memory' ? f.m.memoryId : f.m.messageId}`;
const atOf = (f: Found) => (f.kind === 'memory' ? f.m.recordedAt : f.m.at);
const memoriesOf = (rows: MemoryRow[]): Found[] => rows.map((m) => ({ kind: 'memory' as const, m }));

/** What a read reaches: its scopes (ordered by layer), each scope's layer, and the layers' names and weights. */
type Reach = { scopes: ReadScope[]; ids: ScopeId[]; layers: Layer[]; weights: number[]; layerOf: Map<string, number> };

const reachOf = (scopes: ReadScope[], layers: Layer[]): Reach => ({
  scopes,
  ids: scopes.map((s) => s.id),
  layers,
  weights: layers.length ? layerWeights(layers) : [1],
  layerOf: new Map(scopes.map((s) => [s.id as string, s.layer])),
});

/** A read's scopes, from an action (the filter and layers checked first). */
async function reach(ctx: ActionCtx, filter: unknown, rawLayers: unknown): Promise<Reach> {
  const f = checkFilter(filter);
  const layers = checkLayers(rawLayers);
  return reachOf(await ctx.runQuery(internal.store.resolve, { filter: f, layers }), layers);
}

/** A read's scopes, from a query. */
async function reachIn(ctx: QueryCtx, filter: unknown, rawLayers: unknown): Promise<Reach> {
  const layers = checkLayers(rawLayers);
  return reachOf(await resolveScopes(ctx, checkFilter(filter), layers), layers);
}

/** The layer a row's scope was read as: its name (null without layers) and weight. */
const layerName = (r: Reach, scope: string) => (r.layers.length ? r.layers[r.layerOf.get(scope) ?? 0]!.name : null);
const weightOf = (r: Reach, scope: string) => r.weights[r.layerOf.get(scope) ?? 0] ?? 1;

/** Fused results, each score scaled by its layer's weight, best first (ties to the more recent). */
function weighted(r: Reach, fused: { item: Found; score: number }[]): { item: Found; score: number }[] {
  return fused.map((f) => ({ item: f.item, score: f.score * weightOf(r, f.item.m.scope) })).sort((a, b) => b.score - a.score || atOf(b.item) - atOf(a.item));
}

const memoryHit = (r: Reach, m: MemoryRow, score: number): MemoryHit => ({ ...hitOf(m, score), layer: layerName(r, m.scope) });
const messageHit = (r: Reach, m: MessageRow, score: number): MessageHit => ({ ...messageHitOf(m, score), layer: layerName(r, m.scope) });

/** Each scope's channels, in order: the scopes in groups, a query per group, the groups at once. */
async function channelsOf(ctx: ActionCtx, r: Reach, a: { topics?: string[]; guess?: string; text?: string; messagesText?: string; limit: number; instructions?: number }): Promise<Channels[]> {
  const groups: ScopeId[][] = [];
  for (let i = 0; i < r.ids.length; i += LIMITS.scopesPerQuery) groups.push(r.ids.slice(i, i + LIMITS.scopesPerQuery));
  const topicLimit = Math.max(LIMITS.topicsPerScope, Math.floor(LIMITS.topics / Math.max(1, r.ids.length)));
  const out = await Promise.all(groups.map((scopes) => ctx.runQuery(internal.store.channels, { scopes, topicLimit, ...a })));
  return out.flat();
}

/**
 * Full-text results from many scopes as one list, best first. Each scope's search ranks only its own rows (Convex gives
 * no score to compare across searches), so the rows are ordered by how many of the search's words each holds, ties
 * kept in rank-interleaved order (each scope's first, then each one's second, ...).
 */
function byWords<T>(lists: T[][], text: string | undefined, textOf: (row: T) => string): T[] {
  const rows = interleave(lists);
  if (!text) return rows;
  const words = text.split(' ');
  const held = (row: T) => {
    const have = new Set(keywords(textOf(row), 400));
    return words.filter((w) => have.has(w)).length;
  };
  return rows
    .map((row, i) => ({ row, i, n: held(row) }))
    .sort((a, b) => b.n - a.n || a.i - b.i)
    .map((x) => x.row);
}
const memoryText = (m: MemoryRow) => m.searchText;
const messageText = (m: MessageRow) => m.content;

/** Rank-interleaved lists in layer order: a higher layer's lists all come before a lower one's. */
function byLayer<T>(r: Reach, lists: T[][]): T[] {
  const out: T[] = [];
  const layers = [...new Set(r.scopes.map((s) => s.layer))];
  for (const l of layers) out.push(...interleave(lists.filter((_, i) => r.scopes[i]!.layer === l)));
  return out;
}

/** The current memories of the read's scopes nearest to `vector`, read back through the current view. */
async function vectorChannel(ctx: ActionCtx, r: Reach, vector: number[] | null, limit: number): Promise<Found[]> {
  if (!vector || !r.ids.length) return [];
  const groups: ScopeId[][] = [];
  for (let i = 0; i < r.ids.length; i += LIMITS.vectorOr) groups.push(r.ids.slice(i, i + LIMITS.vectorOr));
  let hits: { _id: Id<'vectors'>; _score: number }[] = [];
  try {
    const found = await Promise.all(
      groups.map((g) =>
        ctx.vectorSearch('vectors', 'by_embedding', {
          vector,
          limit,
          filter: (q) => (g.length === 1 ? q.eq('scope', g[0]!) : q.or(...g.map((s) => q.eq('scope', s)))),
        }),
      ),
    );
    hits = found
      .flat()
      .sort((a, b) => b._score - a._score)
      .slice(0, limit);
  } catch (e) {
    console.error('memory vector search', e instanceof Error ? e.message.slice(0, 200) : 'error');
    return [];
  }
  return memoriesOf(await ctx.runQuery(internal.store.hydrate, { vectors: hits.map((h) => h._id), scopes: r.ids }));
}

const strs = (v: unknown, n = 8) =>
  Array.isArray(v)
    ? v
        .filter((x): x is string => typeof x === 'string')
        .map((x) => x.slice(0, 120))
        .slice(0, n)
    : [];

const readArgs = {
  /** Which tag sets the read reaches (scopes.ts TagFilter): `"user:alice"`, `{ any: ["user:alice", "company"] }`… */
  filter: filterValidator,
  /** Optional layers, highest first: each a name, a filter and a weight (default 1, 0.8, 0.64…). */
  layers: layersValidator,
};

/**
 * Before each model turn, with no language-model call: the standing instructions of the scopes read come first, layer
 * by layer (within the budget); the decision model's gate (does the turn need memory beyond the window?) → if not,
 * those alone (`gated`); else the cheap channels (topic guess by code, full text, the turn's vector) fused and weighted
 * by layer, the decision model's prune (relevant to this turn?), and what fits `budgetTokens`. Answers the window note
 * too, each memory labeled with its layer (or its tags, without layers).
 */
export const context = action({
  args: {
    ...readArgs,
    turn: v.string(),
    recent: v.optional(v.string()),
    budgetTokens: v.number(),
    /** The note's names: the reader's author id, display names by author id ("set by Sam"). */
    reader: v.optional(v.string()),
    names: v.optional(v.record(v.string(), v.string())),
    settings: settingsValidator,
  },
  returns: v.object({ note: v.string(), memories: v.array(memoryHitValidator), gated: v.boolean(), usage: usageValidator }),
  handler: async (ctx, a): Promise<{ note: string; memories: MemoryHit[]; gated: boolean; usage: MemoryUsage }> => {
    if (!a.turn.trim()) fail('invalid', 'A turn is needed');
    const r = await reach(ctx, a.filter, a.layers);
    const turn = clip(a.turn, LIMITS.turnChars, 'tail');
    const models = new Models(ctx, a.settings);
    const recent = a.recent ? clip(a.recent, CONTEXT.recentChars, 'tail') : '';
    const gateState = { recent, turn: clip(turn, 8_000, 'tail') };
    const per = CONTEXT.perChannel;
    const text = searchText([clip(turn, 2_000, 'tail')]) ?? undefined;
    // The gate, the turn's embedding and the scopes' cheap channels at once; the gate's no discards the rest.
    const [gate, vector, chans] = await Promise.all([
      // A gate that could not answer searches (null: logged as unanswered).
      models.decide(gateState, { needs: CONTEXT_GATE }).then(
        (g) => (g.needs ? pYes(g.needs, 1) : null),
        (e) => {
          console.error('memory context gate', e instanceof Error ? e.message.slice(0, 200) : 'error');
          return null;
        },
      ),
      models.embed([turn], { query: true }).then(
        (x) => x[0] ?? null,
        () => null,
      ),
      channelsOf(ctx, r, { guess: turn, ...(text ? { text } : {}), limit: per, instructions: CONTEXT.instructions }),
    ]);
    const decisions: Decision[] = [{ stage: 'context.gate', model: models.decisionModel, inputDigest: await digestOf(gateState), answer: { needs: gate }, confidence: gate, threshold: THRESHOLDS.contextGate }];
    const budget = Math.max(0, Math.min(20_000, Math.floor(a.budgetTokens)));
    let left = budget;
    const out: MemoryHit[] = [];
    const take = (m: MemoryRow, score: number) => {
      if (out.some((o) => o.id === m.memoryId && o.scope === m.scope)) return;
      const cost = estimateTokens(m.content) + 16;
      if (cost > left) return;
      left -= cost;
      out.push(memoryHit(r, m, score));
    };
    // Standing instructions come every turn, first, a higher layer's before a lower one's, within the budget.
    const instructions = byLayer(
      r,
      chans.map((c) => c.instructions),
    );
    for (const m of instructions) take(m, weightOf(r, m.scope));
    const finish = async (gated: boolean) => {
      const usage = models.usage.toJSON();
      if (r.ids.length) await ctx.scheduler.runAfter(0, internal.store.logOp, { scope: r.ids[0]!, op: 'context', decisions: decisions.map(loggedOf), usage });
      return { note: noteOf(out, { reader: a.reader, names: a.names }), memories: out, gated, usage };
    };
    if (gate !== null && gate < THRESHOLDS.contextGate) return await finish(true);

    const direct = await vectorChannel(ctx, r, vector, per);
    const mem = (pick: (c: Channels) => MemoryRow[]) => memoriesOf(interleave(chans.map(pick)));
    const fts = memoriesOf(byWords(chans.map((c) => c.fts), text, memoryText));
    const standing = new Set(instructions.map((m) => keyOf({ kind: 'memory', m })));
    const fused = weighted(
      r,
      fuse<Found>(
        [
          { channel: 'topic', items: mem((c) => c.topic) },
          { channel: 'fts', items: fts },
          { channel: 'vector', items: direct },
        ],
        keyOf,
        atOf,
        RECALL.weights,
      ),
    )
      .filter((f) => !standing.has(keyOf(f.item)))
      .slice(0, CONTEXT.pruneMax);
    if (!fused.length) return await finish(false);
    // The prune: one decision call, a question per candidate.
    const state = {
      recent,
      turn: clip(turn, 4_000, 'tail'),
      memories: fused.map((f, i) => {
        const m = f.item.m as MemoryRow;
        return { i, kind: m.kind, content: clip(m.content, 600), when: new Date(m.validFrom ?? m.recordedAt).toISOString().slice(0, 10) };
      }),
    };
    const questions: Record<string, DecisionQuestion> = Object.fromEntries(fused.map((_, i) => [`m${i}`, { type: 'noul' as const, instructions: `Is memory ${i} relevant to answering the latest turn?` }]));
    let keep: number[];
    try {
      const pr = await models.decide(state, questions, { keep: 'head' });
      // A candidate the model said nothing usable about is kept, as when the prune fails.
      keep = fused.map((_, i) => pYes(pr[`m${i}`], 1));
      decisions.push({ stage: 'context.prune', model: models.decisionModel, inputDigest: await digestOf(state), answer: { kept: keep.filter((p) => p >= THRESHOLDS.contextKeep).length, of: keep.length }, confidence: null, threshold: THRESHOLDS.contextKeep });
    } catch (e) {
      // A prune that could not answer keeps the best-ranked ones the budget allows.
      console.error('memory context prune', e instanceof Error ? e.message.slice(0, 200) : 'error');
      keep = fused.map(() => 1);
    }
    fused.forEach((f, i) => {
      if (keep[i]! >= THRESHOLDS.contextKeep) take(f.item.m as MemoryRow, f.score);
    });
    return await finish(false);
  },
});

/**
 * An assistant's `recall`: Agent Memory's five channels over the scopes read — the writer's query analysis (topic
 * keys, terms and synonyms, a would-be memory to embed: HyDE) at once with the raw query's embedding; then the topic
 * lookup, full text over memories, full text over the record's messages, the direct vector and the HyDE vector, fused
 * (weighted RRF) and weighted by layer. `synthesize` adds the writer's answer from what was found (`answerUntrusted`
 * when untrusted text was among it).
 */
export const recall = action({
  args: { ...readArgs, query: v.string(), limit: v.optional(v.number()), synthesize: v.optional(v.boolean()), settings: settingsValidator },
  returns: v.object({ memories: v.array(memoryHitValidator), messages: v.array(messageHitValidator), answer: v.union(v.string(), v.null()), answerUntrusted: v.boolean(), usage: usageValidator }),
  handler: async (ctx, a): Promise<{ memories: MemoryHit[]; messages: MessageHit[]; answer: string | null; answerUntrusted: boolean; usage: MemoryUsage }> => {
    const query = a.query.trim().slice(0, LIMITS.queryChars);
    if (!query) fail('invalid', 'A query is needed');
    const r = await reach(ctx, a.filter, a.layers);
    const limit = Math.max(1, Math.min(50, Math.floor(a.limit ?? 10)));
    const models = new Models(ctx, a.settings);
    const [analysis, raw] = await Promise.all([
      models.json<{ topics?: string[]; terms?: string[]; synonyms?: string[]; hyde?: string }>(ANALYZE_SYSTEM, query, ANALYZE_SCHEMA, WRITER_ANSWER_TOKENS.analyze),
      models.embed([query], { query: true }).then(
        (x) => x[0] ?? null,
        () => null,
      ),
    ]);
    const asked = keywords(query, 16);
    const text = searchText([...asked, ...strs(analysis?.terms), ...strs(analysis?.synonyms)]) ?? undefined;
    const messagesText = searchText([...asked, ...strs(analysis?.terms)]) ?? undefined;
    const hyde = typeof analysis?.hyde === 'string' && analysis.hyde.trim() ? analysis.hyde.trim().slice(0, 1_000) : null;
    const per = RECALL.perChannel;
    const [chans, direct, hyp] = await Promise.all([
      channelsOf(ctx, r, { topics: strs(analysis?.topics, 5), guess: query, ...(text ? { text } : {}), ...(messagesText ? { messagesText } : {}), limit: per }),
      vectorChannel(ctx, r, raw, per),
      hyde
        ? models.embed([hyde]).then(
            (x) => vectorChannel(ctx, r, x[0] ?? null, per),
            () => [] as Found[],
          )
        : Promise.resolve([] as Found[]),
    ]);
    const mem = (pick: (c: Channels) => MemoryRow[]) => memoriesOf(interleave(chans.map(pick)));
    const msgs: Found[] = byWords(chans.map((c) => c.messages), messagesText, messageText).map((m) => ({ kind: 'message' as const, m }));
    const fused = weighted(
      r,
      fuse<Found>(
        [
          { channel: 'topic', items: mem((c) => c.topic) },
          { channel: 'fts', items: memoriesOf(byWords(chans.map((c) => c.fts), text, memoryText)) },
          { channel: 'hyde', items: hyp },
          { channel: 'vector', items: direct },
          { channel: 'messages', items: msgs },
        ],
        keyOf,
        atOf,
        RECALL.weights,
      ),
    ).slice(0, limit);
    const memories = fused.flatMap((f) => (f.item.kind === 'memory' ? [memoryHit(r, f.item.m, f.score)] : []));
    const messages = fused.flatMap((f) => (f.item.kind === 'message' ? [messageHit(r, f.item.m, f.score)] : []));
    let answer: string | null = null;
    // The answer read untrusted text: it is information to show, never an instruction to follow.
    let answerUntrusted = false;
    if (a.synthesize && (memories.length || messages.length)) {
      answerUntrusted = [...memories.slice(0, RECALL.synthesisTop), ...messages.slice(0, 6)].some((m) => m.trust === 'untrusted');
      const user = `Question: ${query}\n\nMemories:\n${memories
        .slice(0, RECALL.synthesisTop)
        .map((m) => `[${m.id}] (${m.kind}, ${new Date(m.at).toISOString().slice(0, 10)}${m.trust === 'untrusted' ? ', untrusted' : ''}) ${m.content}`)
        .join('\n')}\n\nMessages:\n${messages
        .slice(0, 6)
        .map((m) => `(${m.author}, ${new Date(m.at).toISOString().slice(0, 10)}${m.trust === 'untrusted' ? ', untrusted' : ''}) ${clip(m.content, 1_200)}`)
        .join('\n')}`;
      answer = await models.text(SYNTHESIS_SYSTEM, user, WRITER_ANSWER_TOKENS.synthesis);
    }
    const usage = models.usage.toJSON();
    if (r.ids.length) await ctx.scheduler.runAfter(0, internal.store.logOp, { scope: r.ids[0]!, op: 'recall', decisions: [], usage });
    return { memories, messages, answer, answerUntrusted, usage };
  },
});

/**
 * Full-text search over the record and current memories of the scopes a filter reaches, with no model (an assistant's
 * `search_history` tool, a memory screen's search): memories and messages fused by rank and weighted by layer, newest
 * first on ties. Withheld messages (the sources of forgotten memories) are never found.
 */
export const searchHistory = query({
  args: { ...readArgs, query: v.string(), limit: v.optional(v.number()) },
  returns: v.object({ hits: v.array(historyHitValidator) }),
  handler: async (ctx, a): Promise<{ hits: (({ source: 'memory' } & MemoryHit) | ({ source: 'message' } & MessageHit))[] }> => {
    const r = await reachIn(ctx, a.filter, a.layers);
    const text = searchText([a.query.slice(0, LIMITS.queryChars)]);
    if (!text) return { hits: [] };
    const limit = Math.max(1, Math.min(50, Math.floor(a.limit ?? 20)));
    const lists = await Promise.all(
      r.ids.map(async (scope) => ({
        memories: await ctx.db
          .query('memories')
          .withSearchIndex('search_text', (q) => q.search('searchText', text).eq('scope', scope).eq('current', true))
          .take(limit),
        messages: await ctx.db
          .query('messages')
          .withSearchIndex('search_content', (q) => q.search('content', text).eq('scope', scope).eq('withheld', false))
          .take(limit),
      })),
    );
    const fused = weighted(
      r,
      fuse<Found>(
        [
          { channel: 'fts', items: memoriesOf(byWords(lists.map((l) => l.memories), text, memoryText)) },
          { channel: 'messages', items: byWords(lists.map((l) => l.messages), text, messageText).map((m) => ({ kind: 'message' as const, m })) },
        ],
        keyOf,
        atOf,
        { fts: 1, messages: 1 },
      ),
    ).slice(0, limit);
    return {
      hits: fused.map((f) => (f.item.kind === 'memory' ? { source: 'memory' as const, ...memoryHit(r, f.item.m, f.score) } : { source: 'message' as const, ...messageHit(r, f.item.m, f.score) })),
    };
  },
});

/**
 * A page of the memories of the scopes a filter reaches, newest first, merged across scopes: current ones, or with
 * `includeHistory` every version that is not forgotten; by `kind` and `topic` when given.
 */
export const list = query({
  args: { filter: filterValidator, kind: v.optional(kindValidator), topic: v.optional(v.string()), includeHistory: v.optional(v.boolean()), paginationOpts: paginationOptsValidator },
  returns: v.object({ page: v.array(memoryItemValidator), isDone: v.boolean(), continueCursor: v.string() }),
  handler: async (ctx, a): Promise<{ page: MemoryItem[]; isDone: boolean; continueCursor: string }> => {
    const r = await reachIn(ctx, a.filter, undefined);
    if (!r.ids.length) return { page: [], isDone: true, continueCursor: '' };
    const history = a.includeHistory ?? false;
    const db = stream(ctx.db, schema);
    const streams = r.ids.map((scope) => {
      const q = db.query('memories');
      const indexed = a.topic
        ? q.withIndex('by_scope_topic', (x) => x.eq('scope', scope).eq('topic', a.topic))
        : a.kind && !history
          ? q.withIndex('by_scope_kind', (x) => x.eq('scope', scope).eq('current', true).eq('kind', a.kind!))
          : history
            ? q.withIndex('by_scope_recorded', (x) => x.eq('scope', scope))
            : q.withIndex('by_scope_current', (x) => x.eq('scope', scope).eq('current', true));
      return indexed.order('desc');
    });
    const page = await mergedStream(streams, ['recordedAt', '_creationTime', '_id'])
      .filterWith(async (m) => (history ? m.forgottenAt === undefined : m.current) && (!a.kind || m.kind === a.kind))
      .paginate(a.paginationOpts);
    return { page: page.page.map(itemOf), isDone: page.isDone, continueCursor: page.continueCursor };
  },
});

/** Every version of a topic, or of the chain a version is in, in the scope of `tags`, newest first (forgotten ones never). */
export const history = query({
  args: { tags: v.array(v.string()), id: v.optional(v.string()), topic: v.optional(v.string()) },
  returns: v.object({ versions: v.array(memoryItemValidator) }),
  handler: async (ctx, a): Promise<{ versions: MemoryItem[] }> => {
    if (!a.id === !a.topic) fail('invalid', 'Give a topic or an id');
    const s = await scopeOfTags(ctx, a.tags);
    if (!s) return { versions: [] };
    const scope = s._id;
    if (a.topic) {
      const rows = await ctx.db
        .query('memories')
        .withIndex('by_scope_topic', (q) => q.eq('scope', scope).eq('topic', a.topic))
        .order('desc')
        .filter((q) => q.eq(q.field('forgottenAt'), undefined))
        .take(200);
      return { versions: rows.map(itemOf) };
    }
    const start = await memoryDoc(ctx, scope, a.id!);
    if (!start) return { versions: [] };
    const out = new Map<string, MemoryRow>([[start.memoryId, start]]);
    for (let cur = start; cur.supersedes && !out.has(cur.supersedes); ) {
      const prev = await memoryDoc(ctx, scope, cur.supersedes);
      if (!prev) break;
      out.set(prev.memoryId, prev);
      cur = prev;
    }
    for (let cur = start; cur.supersededBy && !out.has(cur.supersededBy); ) {
      const next = await memoryDoc(ctx, scope, cur.supersededBy);
      if (!next) break;
      out.set(next.memoryId, next);
      cur = next;
    }
    return {
      versions: [...out.values()]
        .filter((m) => m.forgottenAt === undefined)
        .sort((x, y) => y.recordedAt - x.recordedAt)
        .map(itemOf),
    };
  },
});

/** A memory version by id in the scope of `tags`, current or superseded; null for a forgotten one (it left every read). */
export const get = query({
  args: { tags: v.array(v.string()), id: v.string() },
  returns: v.union(memoryItemValidator, v.null()),
  handler: async (ctx, a): Promise<MemoryItem | null> => {
    const s = await scopeOfTags(ctx, a.tags);
    const m = s && (await memoryDoc(ctx, s._id, a.id));
    return m && m.forgottenAt === undefined ? itemOf(m) : null;
  },
});
