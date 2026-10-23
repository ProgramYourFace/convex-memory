// The engine's models, scripted for tests: a transport action (as the app's `defineModelTransport` would be) that
// answers the decision model's /alpha/decisions, the writer's chat completions and the embeddings as the Convex AI
// Gateway does. Embeddings hash words into the first 1,024 of 4,096 dimensions, so texts that share words are near.

import { internalActionGeneric } from 'convex/server';
import { v } from 'convex/values';
import { settingsOf } from '../client/index.js';
import { DEFAULT_MODELS, ENDPOINTS } from './config.js';
import type { DecisionAnswer, DecisionQuestion, TransportResult } from './models.js';
import type { MemorySettings } from './shapes.js';
import { keywords } from './text.js';

/** What one decisions call, one writer call and one embedded text cost in the fake, in USD (usage.cost). */
export const DECISION_COST = 0.000042;
export const WRITER_COST = 0.0003;
export const EMBED_TOKENS = 10;

/** The fake transport's function handle in a test whose root is the component (convex-test's handle format). */
export const TRANSPORT = 'function://;fakeTransport:send';

/** The settings the client sends by default (gateway dialect), with the fake transport. */
export const SETTINGS: MemorySettings = { ...settingsOf({}), transport: TRANSPORT };

export type Call = { path: string; model: string; body: Record<string, unknown> };
/** The answers to give; a question left unscripted gets a default answer, and one scripted `null` gets none. */
type DecisionScript = (questions: Record<string, DecisionQuestion>, state: unknown) => Partial<Record<string, DecisionAnswer | null>> | undefined;
/** The writer's JSON by its system prompt; null answers nothing (content null); an Error is a failed call. */
type WriterScript = (system: string, user: string) => unknown;

export const noul = (p: number): DecisionAnswer => ({ type: 'noul', noul: p });
export const choice = (c: string, confidence = 0.9): DecisionAnswer => ({ type: 'choice', choice: c, probabilities: { [c]: confidence }, confidence });

/** A provider's failure: the status and usage it answers with. */
export class FakeFailure extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly usage: unknown = null,
  ) {
    super(message);
  }
}

/** An embedding as Qwen3 Embedding 8B shapes it: 4,096 dimensions, words hashed into the first 1,024 (the values kept); a query's instruction dropped. */
export function embedOf(text: string): number[] {
  text = text.replace(/^Instruct: [^\n]*\nQuery:/, '');
  const vec = new Array<number>(4096).fill(0);
  for (const w of keywords(text, 400)) {
    let h = 0;
    for (const ch of w) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    vec[h % 1024]! += 1;
  }
  const n = Math.hypot(...vec) || 1;
  return vec.map((x) => x / n);
}

function defaultAnswer(q: DecisionQuestion): DecisionAnswer {
  if (q.type === 'noul') return noul(0.9);
  if (q.type === 'choice') {
    const options = Object.keys(q.criteria);
    const rest = options.length > 1 ? 0.1 / (options.length - 1) : 0;
    return { type: 'choice', choice: options[0]!, probabilities: Object.fromEntries(options.map((o, i) => [o, i ? rest : 0.9])), confidence: 0.85 };
  }
  return { type: 'score', score: 0, probabilities: Object.fromEntries(q.criteria.map((_, i) => [String(i), i ? 0 : 1])), confidence: 0.9 };
}

const G = globalThis as { __memoryGateway?: FakeGateway };

export class FakeGateway {
  calls: Call[] = [];
  decide: DecisionScript = () => undefined;
  writer: WriterScript = () => null;
  /** Recall's answer (the writer's plain text). */
  synthesis = 'An answer.';
  /** Embeddings fail while set. */
  embeddingsDown = false;
  /** Every request fails with no answer (a network failure) while set. */
  offline = false;

  /** Makes this the gateway the fake transport answers with. */
  install(): this {
    G.__memoryGateway = this;
    return this;
  }

  answer(path: string, body: Record<string, unknown>): Record<string, unknown> {
    this.calls.push({ path, model: String(body.model), body });
    if (path === ENDPOINTS.decisions) {
      const questions = body.questions as Record<string, DecisionQuestion>;
      let scripted: Partial<Record<string, DecisionAnswer | null>>;
      try {
        scripted = this.decide(questions, body.state) ?? {};
      } catch (e) {
        throw new FakeFailure(e instanceof Error ? e.message : 'down', 503);
      }
      const answers: Record<string, DecisionAnswer> = {};
      for (const [id, q] of Object.entries(questions)) {
        if (scripted[id] === null) continue;
        answers[id] = scripted[id] ?? defaultAnswer(q);
      }
      return { id: 'dec_test', model: body.model, answers, usage: { input_tokens: 1000, output_tokens: 20, cost: DECISION_COST } };
    }
    if (path === ENDPOINTS.embeddings) {
      if (this.embeddingsDown) throw new FakeFailure('embeddings down', 503);
      const input = body.input as string[];
      const tokens = EMBED_TOKENS * input.length;
      return { object: 'list', data: input.map((t, index) => ({ object: 'embedding', embedding: embedOf(t), index })), model: body.model, usage: { prompt_tokens: tokens, total_tokens: tokens, cost: tokens * 1e-8 } };
    }
    if (path === ENDPOINTS.chat) {
      const messages = body.messages as { role: string; content: string }[];
      const out = body.response_format ? this.writer(messages[0]!.content, messages[1]!.content) : this.synthesis;
      if (out instanceof Error) throw new FakeFailure(out.message, 502);
      const content = out === null ? null : typeof out === 'string' ? out : JSON.stringify(out);
      return {
        id: 'chat_test',
        object: 'chat.completion',
        model: body.model,
        choices: [{ index: 0, finish_reason: content === null ? 'length' : 'stop', message: { role: 'assistant', content } }],
        usage: { prompt_tokens: 2000, completion_tokens: 200, total_tokens: 2200, cost: WRITER_COST },
      };
    }
    throw new FakeFailure('Not Found', 404);
  }

  writerCalls = () => this.calls.filter((c) => c.model === DEFAULT_MODELS.writer);
  decisionCalls = () => this.calls.filter((c) => c.model === DEFAULT_MODELS.decision);
  embeddingCalls = () => this.calls.filter((c) => c.model === DEFAULT_MODELS.embedding);
  /** The system prompts of the writer's calls. */
  writerSystems = () => this.writerCalls().map((c) => (c.body.messages as { content: string }[])[0]!.content);
  /** The user texts of the extraction passes. */
  extractInputs = () =>
    this.writerCalls()
      .filter((c) => (c.body.messages as { content: string }[])[0]!.content.startsWith('You extract'))
      .map((c) => (c.body.messages as { content: string }[])[1]!.content);
}

/** The fake transport: the installed FakeGateway's answer as a provider's status and text. */
export const send = internalActionGeneric({
  args: { path: v.string(), body: v.any(), keepDimensions: v.optional(v.number()) },
  returns: v.object({ status: v.number(), text: v.string() }),
  handler: async (_ctx, a): Promise<TransportResult> => {
    const g = G.__memoryGateway;
    if (!g) throw new Error('No FakeGateway installed');
    if (g.offline) return { status: 0, text: 'Network connection lost' };
    try {
      const json = g.answer(a.path, a.body as Record<string, unknown>);
      if (a.keepDimensions && Array.isArray(json.data)) for (const d of json.data as { embedding: number[] }[]) d.embedding = d.embedding.slice(0, a.keepDimensions);
      return { status: 200, text: JSON.stringify(json) };
    } catch (e) {
      if (e instanceof FakeFailure) return { status: e.status, text: JSON.stringify({ error: { message: e.message }, ...(e.usage ? { usage: e.usage } : {}) }) };
      throw e;
    }
  },
});

/** The writer's extraction item. */
export const item = (kind: string, topic: string, content: string, quotes: string[], o: { time?: string[]; lines?: number[]; queries?: string[] } = {}) => ({
  kind,
  topic,
  content,
  quotes,
  time: o.time ?? [],
  queries: o.queries ?? [`What about ${topic}?`],
  lines: o.lines ?? [],
});

/** A writer that extracts `items` on the full pass (none on the others), passes every check, and answers the rest. */
export function scriptWriter(g: FakeGateway, o: { items?: unknown[]; detail?: unknown[]; verify?: (user: string) => unknown; relation?: string; merge?: string; classify?: unknown; analyze?: unknown } = {}) {
  g.writer = (system, user) => {
    if (system.includes('This is the detail pass')) return { items: o.detail ?? [] };
    if (system.includes('This is the instructions pass')) return { items: (o.items ?? []).filter((i) => (i as { kind: string }).kind === 'instruction') };
    if (system.startsWith('You extract long-term memories')) return { items: o.items ?? [] };
    if (system.startsWith('You check memories')) return o.verify ? o.verify(user) : { results: [] };
    if (system.startsWith('Decide how a new memory relates')) return { relation: o.relation ?? 'unsure' };
    if (system.startsWith('Merge two memories')) return o.merge === undefined ? null : { content: o.merge, queries: ['merged?'] };
    if (system.startsWith('A person asked')) return o.classify ?? null;
    if (system.startsWith('Prepare a search')) return o.analyze ?? null;
    return null;
  };
}
