/// <reference types="vite/client" />
// The engine's test harness: the component as a convex-test app with the scripted model provider (fakeGateway.testing.ts)
// as its transport, and the helpers the tests share.
import { convexTest } from 'convex-test';
import { api, internal } from './_generated/api.js';
import type { Id } from './_generated/dataModel.js';
import { FakeGateway, scriptWriter, SETTINGS } from './fakeGateway.testing.js';
import schema from './schema.js';
import { keyOf } from './scopes.js';

const modules = { ...import.meta.glob('./**/*.ts'), './fakeTransport.ts': () => import('./fakeGateway.testing.js') };
export const newTest = () => convexTest(schema, modules);
export type T = ReturnType<typeof newTest>;

export const DAY = 86_400_000;
/** 2026-10-21T12:00:00Z, a Wednesday: when the test messages were said. */
export const SAID = Date.UTC(2026, 9, 21, 12);
/** A person's own memory, another person's, and what everyone shares. */
export const ME = ['user:me'];
export const BOSS = ['user:boss'];
export const COMPANY = ['company'];
export const LAYERS = [
  { name: 'yours', filter: 'user:me' },
  { name: 'company', filter: 'company' },
];

export async function world() {
  const t = newTest();
  const g = new FakeGateway().install();
  return { t, g };
}
export type World = Awaited<ReturnType<typeof world>>;

export type Msg = { role: 'user' | 'assistant' | 'tool'; author: string; trust: 'trusted' | 'untrusted'; content: string; at: number; tz?: string; authority?: 'manager' | 'member' };
export const msg = (content: string, o: Partial<Omit<Msg, 'content'>> = {}): Msg => ({ role: 'user', author: 'user_me', trust: 'trusted', at: SAID, ...o, content });
export const web = (content: string, at = SAID): Msg => msg(content, { role: 'tool', author: 'web', trust: 'untrusted', at });

/** Runs the scheduled work that is due (drains, logs) until none is left. */
export async function settle(t: T, ms = 10_000) {
  const start = Date.now();
  for (;;) {
    const due = await t.run(async (ctx) =>
      (await ctx.db.system.query('_scheduled_functions').collect()).filter((f) => (f.state.kind === 'pending' || f.state.kind === 'inProgress') && f.scheduledTime <= Date.now()),
    );
    if (!due.length) return;
    if (Date.now() - start > ms) throw new Error('timed out settling');
    await t.finishInProgressScheduledFunctions();
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** The scope of a tag set (null when none was written). */
export const scopeOf = (w: World, tags = ME) =>
  w.t.run(async (ctx) =>
    ctx.db
      .query('scopes')
      .withIndex('by_key', (q) => q.eq('key', keyOf([...new Set(tags)].sort())))
      .unique(),
  );
export const sid = async (w: World, tags = ME): Promise<Id<'scopes'>> => (await scopeOf(w, tags))!._id;

export const ingestRaw = (w: World, messages: Msg[], o: { session?: string; tags?: string[] } = {}) => w.t.mutation(api.ingest.ingest, { tags: o.tags ?? ME, session: o.session ?? 's1', messages, settings: SETTINGS });
export const ingest = async (w: World, messages: Msg[], o: { session?: string; tags?: string[] } = {}) => {
  const r = await ingestRaw(w, messages, o);
  await settle(w.t);
  return r;
};
export const current = async (w: World, tags = ME) => {
  const s = await scopeOf(w, tags);
  if (!s) return [];
  return await w.t.run(async (ctx) =>
    (
      await ctx.db
        .query('memories')
        .withIndex('by_scope_current', (q) => q.eq('scope', s._id).eq('current', true))
        .collect()
    ).sort((a, b) => a.recordedAt - b.recordedAt || a._creationTime - b._creationTime),
  );
};
export const decisions = async (w: World, tags = ME) => {
  const s = await scopeOf(w, tags);
  if (!s) return [];
  return await w.t.run((ctx) =>
    ctx.db
      .query('decisions')
      .withIndex('by_scope_at', (q) => q.eq('scope', s._id))
      .collect(),
  );
};
export const getMemory = async (w: World, id: string, tags = ME) => w.t.query(internal.store.get, { scope: await sid(w, tags), id });
export type RememberArgs = { content: string; tags?: string[]; kind?: 'fact' | 'event' | 'instruction' | 'task'; topic?: string; author?: string; trust?: 'trusted' | 'untrusted'; authority?: 'manager' | 'member'; via?: string };
export const remember = (w: World, a: RememberArgs) => w.t.action(api.write.remember, { ...a, tags: a.tags ?? ME, author: a.author ?? 'user_me', trust: a.trust ?? 'trusted', settings: SETTINGS });
export const tick = () => new Promise((r) => setTimeout(r, 3));
export const firstScope = (w: World) => w.t.run(async (ctx) => (await ctx.db.query('scopes').first())!);
export const firstMessage = (w: World) => w.t.run(async (ctx) => (await ctx.db.query('messages').first())!);
export const empty = { rows: [], confirm: [], confidence: [], outcome: [], decisions: [], usage: { models: [], costMicros: 0 } };

/** The `{ code, message }` an op was refused with (null when it was not). */
export async function refusal(p: Promise<unknown>): Promise<{ code: string; message: string } | null> {
  try {
    await p;
    return null;
  } catch (e) {
    const data = (e as { data?: unknown }).data;
    return (typeof data === 'string' ? JSON.parse(data) : data) as { code: string; message: string };
  }
}

/** Four memories: a diet fact and an instruction of the person's, a company fact, and an event. */
export async function seed(w: World) {
  scriptWriter(w.g, {});
  const r = async (tags: string[], kind: 'fact' | 'event' | 'instruction', topic: string, content: string) => {
    await tick();
    return (await remember(w, { tags, kind, topic, content })).memory;
  };
  const diet = await r(ME, 'fact', 'person.diet', 'The person is vegetarian and avoids mushrooms.');
  const french = await r(ME, 'instruction', 'person.language', 'Always answer in French.');
  const wifi = await r(COMPANY, 'fact', 'company.office.wifi', 'The office wifi network is Orchard.');
  const bike = await r(ME, 'event', 'person.trips.bike', 'The person rode to Sintra by bike.');
  await settle(w.t);
  return { diet, french, wifi, bike };
}
export const recall = (w: World, a: { filter: unknown; layers?: { name: string; filter: unknown; weight?: number }[]; query: string; limit?: number; synthesize?: boolean }) => w.t.action(api.read.recall, { ...a, settings: SETTINGS });
export const context = (w: World, a: { filter: unknown; layers?: { name: string; filter: unknown; weight?: number }[]; turn: string; budgetTokens: number }) => w.t.action(api.read.context, { ...a, settings: SETTINGS });

