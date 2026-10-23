// Tags, filters, scopes and layers: what a read reaches (found by tag, never by scanning), many scopes at once,
// relate kept within one tag set, layers in ranking and in the note, and purge by tag and by tag set.
import { describe, expect, test } from 'vitest';
import { api } from './_generated/api.js';
import type { Id } from './_generated/dataModel.js';
import { LIMITS } from './config.js';
import { choice, scriptWriter, SETTINGS } from './fakeGateway.testing.js';
import { context, current, getMemory, ingest, msg, recall, refusal, remember, scopeOf, settle, sid, tick, world, type World } from './harness.testing.js';
import { perScope } from './read.js';
import { canonicalTags, checkFilter, keyOf, matches, resolveScopes, type Layer, type TagFilter } from './scopes.js';

describe('filters', () => {
  const has = (f: TagFilter, ...tags: string[]) => matches(f, new Set(tags));

  test('all, any and not, nested', () => {
    expect(has('a', 'a', 'b')).toBe(true);
    expect(has('a', 'b')).toBe(false);
    expect(has({ all: ['a', 'b'] }, 'a', 'b', 'c')).toBe(true);
    expect(has({ all: ['a', 'b'] }, 'a')).toBe(false);
    expect(has({ any: ['a', 'b'] }, 'b')).toBe(true);
    expect(has({ any: ['a', 'b'] }, 'c')).toBe(false);
    expect(has({ any: ['a', 'b'], not: ['c'] }, 'a')).toBe(true);
    expect(has({ any: ['a', 'b'], not: ['c'] }, 'a', 'c')).toBe(false);
    const nested: TagFilter = { any: [{ all: ['team:eng', 'agent:review'] }, 'user:alice'], not: ['agent:sales'] };
    expect(has(nested, 'team:eng', 'agent:review')).toBe(true);
    expect(has(nested, 'team:eng')).toBe(false);
    expect(has(nested, 'user:alice', 'team:x')).toBe(true);
    expect(has(nested, 'user:alice', 'agent:sales')).toBe(false);
    expect(has({ all: ['company', { not: ['draft'], any: ['policy', 'faq'] }] }, 'company', 'faq')).toBe(true);
    expect(has({ all: ['company', { not: ['draft'], any: ['policy', 'faq'] }] }, 'company', 'faq', 'draft')).toBe(false);
  });

  test('a filter is checked: its shape, its tags, its depth and size; "not" alone is refused', () => {
    expect(checkFilter({ any: ['user:alice', 'team:eng'], not: ['agent:sales'] })).toEqual({ any: ['user:alice', 'team:eng'], not: ['agent:sales'] });
    const bad: unknown[] = [{ not: ['a'] }, {}, { any: [] }, { all: [] }, 'has space', '', ':x', 7, null, ['a'], { all: ['a'], also: ['b'] }, { all: 'a' }, 'x'.repeat(LIMITS.tagChars + 1)];
    for (const f of bad) expect(() => checkFilter(f), JSON.stringify(f)).toThrow();
    let deep: TagFilter = 'a';
    for (let i = 0; i < LIMITS.filterDepth; i++) deep = { all: [deep] };
    expect(() => checkFilter(deep)).toThrow(/nests at most/);
    expect(() => checkFilter({ any: Array.from({ length: LIMITS.filterNodes }, (_, i) => `t${i}`) })).toThrow(/at most/);
    expect(() => checkFilter({ any: Array.from({ length: LIMITS.filterNodes - 1 }, (_, i) => `t${i}`) })).not.toThrow();
  });

  test('a tag set is canonical: sorted, each tag once, 1 to LIMITS.scopeTags of them', () => {
    expect(canonicalTags(['team:eng', 'agent:review', 'team:eng'])).toEqual(['agent:review', 'team:eng']);
    expect(() => canonicalTags([])).toThrow();
    expect(() => canonicalTags(Array.from({ length: LIMITS.scopeTags + 1 }, (_, i) => `t${i}`))).toThrow();
    expect(() => canonicalTags(['ok', 'not ok'])).toThrow();
    expect(canonicalTags(['user:alice@example.com', 'org/team#1', 'a=b+c'])).toEqual(['a=b+c', 'org/team#1', 'user:alice@example.com']);
  });
});

/** Scopes made directly (no models), each with its tags. */
async function scopes(w: World, sets: string[][]): Promise<Id<'scopes'>[]> {
  return await w.t.run(async (ctx) => {
    const ids: Id<'scopes'>[] = [];
    for (const raw of sets) {
      const tags = canonicalTags(raw);
      const id = await ctx.db.insert('scopes', { tags, key: keyOf(tags), createdAt: Date.now() });
      for (const tag of tags) await ctx.db.insert('scopeTags', { tag, scope: id });
      ids.push(id);
    }
    return ids;
  });
}

describe('what a read reaches', () => {
  test('the scopes whose tags satisfy the filter, found through their tags', async () => {
    const w = await world();
    const [alice, eng, engReview, engSales, bob, company] = await scopes(w, [['user:alice'], ['team:eng'], ['team:eng', 'agent:review'], ['team:eng', 'agent:sales', 'agent:review'], ['user:bob'], ['company']]);
    const reach = (filter: TagFilter, layers: Layer[] = []) => w.t.run((ctx) => resolveScopes(ctx, filter, layers));
    const ids = async (f: TagFilter) => (await reach(f)).map((s) => s.id).sort();
    expect(await ids('team:eng')).toEqual([eng, engReview, engSales].sort());
    expect(await ids({ any: [{ all: ['team:eng', 'agent:review'] }, 'user:alice'], not: ['agent:sales'] })).toEqual([alice, engReview].sort());
    expect(await ids({ all: ['team:eng'], not: ['agent:review'] })).toEqual([eng]);
    expect(await ids({ any: ['user:bob', 'company'] })).toEqual([bob, company].sort());
    expect(await ids('user:nobody')).toEqual([]);
    // Layers: each scope is read as the first layer it matches; one matching none is left out.
    const layered = await reach({ any: ['user:alice', 'team:eng', 'company'] }, [
      { name: 'yours', filter: 'user:alice' },
      { name: 'team', filter: { all: ['team:eng'], not: ['agent:sales'] } },
      { name: 'company', filter: 'company' },
    ]);
    expect(layered.map((s) => [s.id, s.layer])).toEqual([
      [alice, 0],
      ...[eng, engReview].sort().map((id) => [id, 1]),
      [company, 2],
    ]);
  });

  test(`a filter reaching more than ${LIMITS.readScopes} tag sets is refused; a narrower one over the same tags is not`, async () => {
    const w = await world();
    await scopes(
      w,
      Array.from({ length: LIMITS.readScopes + 1 }, (_, i) => ['org', `team:t${i}`]),
    );
    scriptWriter(w.g, {});
    expect(await refusal(recall(w, { filter: 'org', query: 'standup' }))).toMatchObject({ code: 'invalid' });
    expect(await refusal(w.t.query(api.read.list, { filter: 'org', paginationOpts: { numItems: 5, cursor: null } }))).toMatchObject({ code: 'invalid' });
    // `all` is bounded by its smallest member.
    expect((await recall(w, { filter: { all: ['org', 'team:t7'] }, query: 'standup' })).memories).toEqual([]);
  });
});

describe('many scopes at once', () => {
  const N = LIMITS.vectorOr + 6; // past one vector search's `or` and two channel groups

  async function teams(w: World) {
    scriptWriter(w.g, {});
    w.g.decide = (q) => Object.fromEntries(Object.keys(q).map((k) => [k, choice('unrelated', 0.95)]));
    const ids: string[] = [];
    for (let i = 0; i < N; i++) {
      await tick();
      const r = await remember(w, { tags: ['org', `team:t${i}`], kind: 'fact', topic: 'team.standup', content: `Team t${i} holds its standup in room r${i}.` });
      ids.push(r.memory.id);
    }
    await settle(w.t);
    return ids;
  }

  test('recall, search and list read every scope the filter reaches, each memory once, and no other', async () => {
    const w = await world();
    const ids = await teams(w);
    const last = N - 1;
    scriptWriter(w.g, { analyze: { topics: [], terms: [`r${last}`], synonyms: [], hyde: `Team t${last} holds its standup in room r${last}.` } });
    const r = await recall(w, { filter: 'org', query: `Which room is r${last}?`, limit: 5 });
    expect(r.memories[0]!.id).toBe(ids[last]);
    expect(r.memories[0]!.tags).toEqual(['org', `team:t${last}`]);
    // The vector channels searched every group of scopes (the last team's scope is in the second): with nothing for
    // full text or topics to find, only the HyDE vector of its memory finds it.
    scriptWriter(w.g, { analyze: { topics: [], terms: [], synonyms: [], hyde: `Team t${last} holds its standup in room r${last}.` } });
    const byVector = await recall(w, { filter: 'org', query: 'zzzz', limit: 50 });
    expect(byVector.memories.map((m) => m.id)).toContain(ids[last]);
    const hits = await w.t.query(api.read.searchHistory, { filter: 'org', query: `r3 r${last}`, limit: 50 });
    expect(hits.hits.filter((h) => h.source === 'memory').map((h) => h.id)).toEqual(expect.arrayContaining([ids[3], ids[last]]));
    // Pages merge the scopes newest first, each memory once.
    const seen: string[] = [];
    let cursor: string | null = null;
    for (;;) {
      const p: { page: { id: string }[]; isDone: boolean; continueCursor: string } = await w.t.query(api.read.list, { filter: 'org', paginationOpts: { numItems: 25, cursor } });
      seen.push(...p.page.map((m) => m.id));
      if (p.isDone) break;
      cursor = p.continueCursor;
    }
    expect(seen).toEqual([...ids].reverse());
    // A filter that leaves one team out never returns it.
    const without = await recall(w, { filter: { all: ['org'], not: [`team:t${last}`] }, query: `room r${last}`, limit: 50 });
    expect(without.memories.map((m) => m.id)).not.toContain(ids[last]);
    expect(without.memories.every((m) => !m.tags.includes(`team:t${last}`))).toBe(true);
  });
});

describe("Convex's limits at the most scopes a read reaches", () => {
  test("each search reads a share of the channel's rows: all of them from a few scopes, a bounded total from many", () => {
    expect(perScope(20, 1)).toBe(20);
    expect(perScope(20, 4)).toBe(20);
    expect(perScope(20, LIMITS.readScopes)).toBe(LIMITS.rowsPerScope);
    expect(perScope(50, LIMITS.readScopes, 1)).toBe(1);
    // A message is at most LIMITS.messageChars (up to 3 bytes each in UTF-8 for most scripts); a query reads 16 MiB.
    const maxMessage = LIMITS.messageChars * 3;
    const mib16 = 16 * 1024 * 1024;
    // The actions' channel queries: LIMITS.scopesPerQuery scopes each, messages, full text and topics.
    expect(LIMITS.scopesPerQuery * perScope(20, LIMITS.readScopes) * maxMessage).toBeLessThan(mib16 / 2);
    // searchHistory, one query over every scope.
    expect(LIMITS.readScopes * perScope(50, LIMITS.readScopes, 1) * maxMessage).toBeLessThan(mib16);
    for (let n = 1; n <= LIMITS.readScopes; n++) expect(n * perScope(50, n, 1)).toBeLessThanOrEqual(Math.max(50, LIMITS.channelRows + n));
  });
});

describe('relate stays within one tag set', () => {
  test("a statement under one tag set never supersedes, refines or confirms another's memory", async () => {
    const w = await world();
    scriptWriter(w.g, {});
    const team = (await remember(w, { tags: ['team:eng'], kind: 'fact', topic: 'team.standup', content: 'The standup is at 9.' })).memory;
    await tick();
    // The decision model would call it an update: it is never even asked, since the team's memory is not a candidate.
    w.g.decide = (q) => Object.fromEntries(Object.keys(q).map((k) => [k, k.startsWith('r') ? choice('updates', 0.99) : choice('unrelated', 0.99)]));
    const mine = await remember(w, { tags: ['user:me', 'team:eng'], kind: 'fact', content: 'The standup is at 10.' });
    expect(mine.superseded).toEqual([]);
    expect(mine.memory.supersedes).toBeNull();
    // An edit of the same topic under another tag set is an edit of that set's topic only.
    const edit = await remember(w, { tags: ['user:me'], kind: 'fact', topic: 'team.standup', content: 'My standup is at 11.' });
    expect(edit.superseded).toEqual([]);
    scriptWriter(w.g, { items: [{ kind: 'fact', topic: 'team.standup', content: 'The standup is at 9.', quotes: ['The standup is at 9'], time: [], queries: [], lines: [] }] });
    await ingest(w, [msg('The standup is at 9, yes', { at: Date.now() })], { tags: ['user:me'] });
    expect(await getMemory(w, team.id, ['team:eng'])).toMatchObject({ supersededAt: null, sources: team.sources, confidence: team.confidence });
    expect((await current(w, ['team:eng'])).map((m) => m.memoryId)).toEqual([team.id]);
  });
});

describe('layers', () => {
  async function both(w: World) {
    scriptWriter(w.g, {});
    const mine = (await remember(w, { tags: ['user:me'], kind: 'fact', topic: 'person.tea', content: 'The person drinks green tea every morning.' })).memory;
    await tick();
    const ours = (await remember(w, { tags: ['company'], kind: 'fact', topic: 'company.kitchen', content: 'The office kitchen stocks green tea every morning.' })).memory;
    await settle(w.t);
    scriptWriter(w.g, { analyze: { topics: [], terms: ['green', 'tea'], synonyms: [], hyde: 'green tea every morning' } });
    return { mine, ours };
  }

  test('a layer weight orders what ranks equally; each hit names its layer', async () => {
    const w = await world();
    const { mine, ours } = await both(w);
    const filter = { any: ['user:me', 'company'] };
    const youFirst = await recall(w, { filter, layers: [{ name: 'yours', filter: 'user:me' }, { name: 'company', filter: 'company', weight: 0.01 }], query: 'green tea every morning' });
    expect(youFirst.memories.map((m) => [m.id, m.layer])).toEqual([
      [mine.id, 'yours'],
      [ours.id, 'company'],
    ]);
    const companyFirst = await recall(w, { filter, layers: [{ name: 'company', filter: 'company' }, { name: 'yours', filter: 'user:me', weight: 0.01 }], query: 'green tea every morning' });
    expect(companyFirst.memories.map((m) => m.id)).toEqual([ours.id, mine.id]);
    // A scope matching no layer is not read.
    const onlyMine = await recall(w, { filter, layers: [{ name: 'yours', filter: 'user:me' }], query: 'green tea every morning' });
    expect(onlyMine.memories.map((m) => m.id)).toEqual([mine.id]);
    expect(await refusal(recall(w, { filter, layers: [{ name: '', filter: 'user:me' }], query: 'x' }))).toMatchObject({ code: 'invalid' });
    expect(await refusal(recall(w, { filter, layers: [{ name: 'a', filter: 'user:me', weight: 0 }], query: 'x' }))).toMatchObject({ code: 'invalid' });
  });

  test("the note says each memory's layer, or its tags when the read has none", async () => {
    const w = await world();
    const { mine, ours } = await both(w);
    w.g.decide = (q) => Object.fromEntries(Object.keys(q).map((k) => [k, { type: 'noul' as const, noul: 0.9 }]));
    const layered = await context(w, { filter: { any: ['user:me', 'company'] }, layers: [{ name: 'yours', filter: 'user:me' }, { name: 'company', filter: 'company' }], turn: 'Is there green tea?', budgetTokens: 2000 });
    expect(layered.note).toContain(`[memory:${mine.id}] (fact, yours,`);
    expect(layered.note).toContain(`[memory:${ours.id}] (fact, company,`);
    const flat = await context(w, { filter: { any: ['user:me', 'company'] }, turn: 'Is there green tea?', budgetTokens: 2000 });
    expect(flat.note).toContain(`[memory:${mine.id}] (fact, user:me,`);
  });
});

describe('purge by tag and by tag set', () => {
  async function three(w: World) {
    scriptWriter(w.g, {});
    w.g.decide = (q) => Object.fromEntries(Object.keys(q).map((k) => [k, choice('unrelated', 0.95)]));
    const put = async (tags: string[], content: string) => {
      await tick();
      return (await remember(w, { tags, content, kind: 'fact' })).memory;
    };
    return {
      alone: await put(['user:alice'], 'Alice likes jazz.'),
      withTeam: await put(['user:alice', 'team:eng'], 'Alice reviews the eng releases.'),
      team: await put(['team:eng'], 'The eng team deploys on Tuesdays.'),
      bob: await put(['user:bob', 'team:eng'], 'Bob owns the eng on-call rota.'),
    };
  }

  test('by tag: every tag set holding it goes, and no write names it until it is reopened', async () => {
    const w = await world();
    const m = await three(w);
    expect(await w.t.mutation(api.purge.purge, { tag: 'user:alice' })).toEqual({ done: true });
    expect(await scopeOf(w, ['user:alice'])).toBeNull();
    expect(await scopeOf(w, ['user:alice', 'team:eng'])).toBeNull();
    const left = await w.t.query(api.read.list, { filter: 'team:eng', paginationOpts: { numItems: 10, cursor: null } });
    expect(left.page.map((x) => x.id).sort()).toEqual([m.team.id, m.bob.id].sort());
    expect(await refusal(remember(w, { tags: ['team:eng', 'user:alice'], content: 'Alice is back.' }))).toMatchObject({ code: 'forbidden' });
    expect(await refusal(w.t.mutation(api.ingest.ingest, { tags: ['user:alice'], session: 's', messages: [msg('hi')], settings: SETTINGS }))).toMatchObject({ code: 'forbidden' });
    expect(await w.t.mutation(api.purge.reopen, { tag: 'user:alice' })).toEqual({ reopened: true });
    expect(await w.t.mutation(api.purge.reopen, { tag: 'user:alice' })).toEqual({ reopened: false });
    expect((await remember(w, { tags: ['user:alice'], content: 'Alice is back.' })).memory.content).toBe('Alice is back.');
  });

  test('by tag set: exactly that scope goes; sets that hold more tags stay; reopen lets it be written again', async () => {
    const w = await world();
    const m = await three(w);
    const team = await sid(w, ['team:eng']);
    expect(await w.t.mutation(api.purge.purge, { tags: ['team:eng'] })).toEqual({ done: true });
    expect((await current(w, ['team:eng'])).length).toBe(0);
    expect((await w.t.run((ctx) => ctx.db.get(team)))!.purgedAt).toBeGreaterThan(0);
    const left = await w.t.query(api.read.list, { filter: 'team:eng', paginationOpts: { numItems: 10, cursor: null } });
    expect(left.page.map((x) => x.id).sort()).toEqual([m.withTeam.id, m.bob.id].sort());
    expect(await refusal(remember(w, { tags: ['team:eng'], content: 'The eng team deploys on Wednesdays.' }))).toMatchObject({ code: 'forbidden' });
    expect((await remember(w, { tags: ['team:eng', 'agent:deploy'], content: 'Deploys need two approvals.' })).memory.tags).toEqual(['agent:deploy', 'team:eng']);
    // A tag set never written can be purged ahead: it is closed to writes all the same.
    expect(await w.t.mutation(api.purge.purge, { tags: ['user:carol'] })).toEqual({ done: true });
    expect(await refusal(remember(w, { tags: ['user:carol'], content: 'Carol likes tea.' }))).toMatchObject({ code: 'forbidden' });
    expect(await w.t.mutation(api.purge.reopen, { tags: ['team:eng'] })).toEqual({ reopened: true });
    expect((await remember(w, { tags: ['team:eng'], content: 'The eng team deploys on Wednesdays.' })).memory.content).toBe('The eng team deploys on Wednesdays.');
  });

  test('a reopen while rows are still being erased is refused', async () => {
    const w = await world();
    await three(w);
    const scope = await sid(w, ['user:alice']);
    await w.t.run(async (ctx) => {
      for (let i = 0; i < 700; i++)
        await ctx.db.insert('messages', { scope, tags: ['user:alice'], messageId: i.toString(16).padStart(32, '0'), session: 's', role: 'user', author: 'alice', trust: 'trusted', content: `m${i}`, at: i, processed: true, withheld: false });
    });
    expect(await w.t.mutation(api.purge.purge, { tag: 'user:alice' })).toEqual({ done: false });
    expect(await refusal(w.t.mutation(api.purge.reopen, { tag: 'user:alice' }))).toMatchObject({ code: 'invalid' });
    await settle(w.t);
    expect(await w.t.run(async (ctx) => (await ctx.db.query('messages').collect()).filter((x) => x.tags.includes('user:alice')))).toEqual([]);
    expect(await w.t.mutation(api.purge.reopen, { tag: 'user:alice' })).toEqual({ reopened: true });
  });
});

describe('a purge in progress', () => {
  /** Rows enough that a purge needs more than one mutation. */
  const bulk = (w: World, scope: Id<'scopes'>, tags: string[]) =>
    w.t.run(async (ctx) => {
      for (let i = 0; i < 700; i++)
        await ctx.db.insert('messages', { scope, tags, messageId: i.toString(16).padStart(32, '0'), session: 's', role: 'user', author: 'alice', trust: 'trusted', content: `m${i}`, at: i, processed: true, withheld: false });
    });

  async function setup(w: World) {
    scriptWriter(w.g, {});
    w.g.decide = (q) => Object.fromEntries(Object.keys(q).map((k) => [k, choice('unrelated', 0.95)]));
    const put = async (tags: string[], content: string) => {
      await tick();
      return (await remember(w, { tags, content, kind: 'fact' })).memory;
    };
    const alone = await put(['user:alice'], 'Alice likes jazz.');
    const withTeam = await put(['user:alice', 'team:eng'], 'Alice reviews the eng releases.');
    const team = await put(['team:eng'], 'The eng team deploys on Tuesdays.');
    await bulk(w, await sid(w, ['user:alice']), ['user:alice']);
    return { alone, withTeam, team };
  }

  test('by tag: no read reaches a tag set holding the tag, though its rows are not erased yet', async () => {
    const w = await world();
    const m = await setup(w);
    expect(await w.t.mutation(api.purge.purge, { tag: 'user:alice' })).toEqual({ done: false });
    // The second tag set holding the tag is still in the table: every read leaves it out all the same.
    expect(await scopeOf(w, ['user:alice', 'team:eng'])).not.toBeNull();
    const listed = await w.t.query(api.read.list, { filter: 'team:eng', paginationOpts: { numItems: 10, cursor: null } });
    expect(listed.page.map((x) => x.id)).toEqual([m.team.id]);
    const found = await w.t.query(api.read.searchHistory, { filter: 'team:eng', query: 'eng releases' });
    expect(found.hits.map((h) => h.id)).not.toContain(m.withTeam.id);
    expect(await w.t.query(api.read.get, { tags: ['user:alice', 'team:eng'], id: m.withTeam.id })).toBeNull();
    expect(await w.t.query(api.read.get, { tags: ['user:alice'], id: m.alone.id })).toBeNull();
    expect((await w.t.query(api.read.history, { tags: ['user:alice', 'team:eng'], id: m.withTeam.id })).versions).toEqual([]);
    expect((await recall(w, { filter: { any: ['user:alice', 'team:eng'] }, query: 'eng releases jazz' })).memories.map((x) => x.id)).toEqual([m.team.id]);
    await settle(w.t);
    expect(await scopeOf(w, ['user:alice', 'team:eng'])).toBeNull();
  });

  test('by tag set: get and history of the purged set answer nothing', async () => {
    const w = await world();
    const m = await setup(w);
    expect(await w.t.mutation(api.purge.purge, { tags: ['user:alice'] })).toEqual({ done: false });
    expect(await w.t.query(api.read.get, { tags: ['user:alice'], id: m.alone.id })).toBeNull();
    expect((await w.t.query(api.read.history, { tags: ['user:alice'], id: m.alone.id })).versions).toEqual([]);
    // Other tag sets holding the tag are not purged by an exact-set purge.
    expect(await w.t.query(api.read.get, { tags: ['user:alice', 'team:eng'], id: m.withTeam.id })).not.toBeNull();
  });

  test("a tag's purge erases a bounded number of tag sets per mutation, the rest scheduled", async () => {
    const w = await world();
    const ids = await scopes(
      w,
      Array.from({ length: 120 }, (_, i) => ['org', `team:t${i}`]),
    );
    await w.t.run(async (ctx) => {
      for (const [i, scope] of ids.entries())
        await ctx.db.insert('messages', { scope, tags: ['org', `team:t${i}`], messageId: i.toString(16).padStart(32, '0'), session: 's', role: 'user', author: 'a', trust: 'trusted', content: `m${i}`, at: i, processed: true, withheld: false });
    });
    expect(await w.t.mutation(api.purge.purge, { tag: 'org' })).toEqual({ done: false });
    await settle(w.t);
    expect(await w.t.run((ctx) => ctx.db.query('scopes').collect())).toEqual([]);
    expect(await w.t.mutation(api.purge.reopen, { tag: 'org' })).toEqual({ reopened: true });
  });
});
