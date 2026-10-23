// The client from an app: `new Memory(components.memory, …)` over the registered component, with the app's
// `defineModelTransport` sending each model request through `fetch` (stubbed here with the scripted provider).
import { defineTestApp } from 'convex-test';
import { defineSchema, makeFunctionReference } from 'convex/server';
import { v } from 'convex/values';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { FakeGateway, scriptWriter } from '../component/fakeGateway.testing.js';
import componentTest from '../test.js';
import { DEFAULT_MODELS, EMBEDDING_DIMENSIONS, Memory, defineModelTransport, settingsOf, type TransportReference } from './index.js';

const app = defineTestApp({ schema: defineSchema({}), components: { memory: componentTest } });
const transportRef = makeFunctionReference<'action'>('memory:transport') as unknown as TransportReference;
const memory = new Memory(app.components.memory, { transport: transportRef });

const { api, createTest } = app.defineModules({
  memory: {
    transport: defineModelTransport({ baseUrl: 'https://llm.example/', apiKey: () => 'test-key', headers: { 'X-App': 'tests' } }),
    ingest: app.mutation({
      args: { user: v.string(), text: v.string() },
      handler: async (ctx, a) => await memory.ingest(ctx, { tags: [`user:${a.user}`], session: 's1', messages: [{ role: 'user', author: a.user, trust: 'trusted', content: a.text, at: Date.now() }] }),
    }),
    remember: app.action({
      args: { user: v.string(), text: v.string() },
      handler: async (ctx, a) => await memory.remember(ctx, { tags: [`user:${a.user}`], content: a.text, author: a.user, trust: 'trusted' }),
    }),
    recall: app.action({
      args: { user: v.string(), query: v.string() },
      handler: async (ctx, a) => await memory.recall(ctx, { filter: { any: [`user:${a.user}`, 'company'] }, layers: [{ name: 'yours', filter: `user:${a.user}` }, { name: 'company', filter: 'company' }], query: a.query }),
    }),
    list: app.query({
      args: { user: v.string() },
      handler: async (ctx, a) => await memory.list(ctx, { filter: `user:${a.user}`, paginationOpts: { numItems: 10, cursor: null } }),
    }),
    purge: app.mutation({
      args: { user: v.string() },
      handler: async (ctx, a) => await memory.purge(ctx, { tag: `user:${a.user}` }),
    }),
    sweep: app.mutation({ args: {}, handler: async (ctx) => await memory.sweep(ctx) }),
  },
});

type Sent = { url: string; headers: Record<string, string>; body: Record<string, unknown> };
let g: FakeGateway;
let sent: Sent[];

beforeEach(() => {
  g = new FakeGateway();
  sent = [];
  vi.stubGlobal('fetch', async (url: string, init: { headers: Record<string, string>; body: string }) => {
    const body = JSON.parse(init.body) as Record<string, unknown>;
    sent.push({ url, headers: init.headers, body });
    const path = new URL(url).pathname;
    try {
      return new Response(JSON.stringify(g.answer(path, body)), { status: 200 });
    } catch (e) {
      return new Response(JSON.stringify({ error: { message: (e as Error).message } }), { status: (e as { status?: number }).status ?? 500 });
    }
  });
});
afterEach(() => vi.unstubAllGlobals());

/** Lets the component's background work (its drains, its logs) run: its schedule is its own, out of the app's sight. */
async function settle(t: ReturnType<typeof createTest>) {
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 5));
    await t.finishInProgressScheduledFunctions();
  }
}

describe('the client', () => {
  test('an app ingests, remembers, recalls, lists and purges through the component, its transport adding its key', async () => {
    const t = createTest();
    scriptWriter(g, { items: [{ kind: 'fact', topic: 'person.diet', content: 'The person is vegetarian.', quotes: ['I am vegetarian'], time: [], queries: ['What does the person eat?'], lines: [] }] });
    expect(await t.mutation(api.memory.ingest, { user: 'alice', text: 'I am vegetarian' })).toEqual({ stored: 1, skipped: 0 });
    await settle(t);
    const listed = await t.query(api.memory.list, { user: 'alice' });
    expect(listed.page.map((m) => [m.content, m.tags])).toEqual([['The person is vegetarian.', ['user:alice']]]);
    expect(sent.length).toBeGreaterThan(0);
    for (const s of sent) {
      expect(s.url.startsWith('https://llm.example/')).toBe(true);
      expect(s.headers).toMatchObject({ Authorization: 'Bearer test-key', 'X-App': 'tests', 'Content-Type': 'application/json' });
    }
    expect(sent.map((s) => s.body.model)).toEqual(expect.arrayContaining([DEFAULT_MODELS.decision, DEFAULT_MODELS.writer, DEFAULT_MODELS.embedding]));
    const r = await t.action(api.memory.recall, { user: 'alice', query: 'What does the person eat?' });
    expect(r.memories[0]).toMatchObject({ content: 'The person is vegetarian.', layer: 'yours', tags: ['user:alice'] });
    expect((await t.action(api.memory.recall, { user: 'bob', query: 'What does the person eat?' })).memories).toEqual([]);
    const kept = await t.action(api.memory.remember, { user: 'alice', text: 'Likes green tea.' });
    expect(kept.memory.tags).toEqual(['user:alice']);
    await t.mutation(api.memory.sweep, {});
    expect(await t.mutation(api.memory.purge, { user: 'alice' })).toEqual({ done: true });
    expect((await t.query(api.memory.list, { user: 'alice' })).page).toEqual([]);
  });

  test('the transport sends only the model paths and answers a failure as its status', async () => {
    const t = createTest();
    const transport = makeFunctionReference<'action', { path: string; body: unknown; keepDimensions?: number }, { status: number; text: string }>('memory:transport');
    expect((await t.action(transport, { path: '/v1/files', body: {} })).status).toBe(400);
    expect(sent).toEqual([]);
    const embedded = await t.action(transport, { path: '/v1/embeddings', body: { model: DEFAULT_MODELS.embedding, input: ['hello'] }, keepDimensions: EMBEDDING_DIMENSIONS });
    expect(embedded.status).toBe(200);
    expect((JSON.parse(embedded.text) as { data: { embedding: number[] }[] }).data[0]!.embedding).toHaveLength(EMBEDDING_DIMENSIONS);
    g.embeddingsDown = true;
    expect((await t.action(transport, { path: '/v1/embeddings', body: { input: ['x'] } })).status).toBe(503);
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('Network connection lost');
    });
    expect(await t.action(transport, { path: '/v1/chat/completions', body: {} })).toEqual({ status: 0, text: 'Network connection lost' });
  });

  test('settings: gateway defaults; the openai dialect needs its models and has no decision model unless named', () => {
    expect(settingsOf({})).toMatchObject({ dialect: 'gateway', decisionModel: DEFAULT_MODELS.decision, writerModel: DEFAULT_MODELS.writer, embeddingModel: DEFAULT_MODELS.embedding, writerReasoning: 'low', routing: { zdr: true, data_collection: 'deny' } });
    expect(() => settingsOf({ dialect: 'openai' })).toThrow(/needs models.writer and models.embedding/);
    expect(settingsOf({ dialect: 'openai', models: { writer: 'w', embedding: 'e' } })).toMatchObject({ decisionModel: null, writerReasoning: null, embeddingQueryPrefix: null, routing: null, prices: [] });
    expect(settingsOf({ models: { decision: null } }).decisionModel).toBeNull();
    expect(() => defineModelTransport({ baseUrl: 'https://api.openai.com' })).toThrow(/needs apiKey/);
    expect(() => defineModelTransport()).not.toThrow();
  });
});
