import type { FunctionHandle } from 'convex/server';
import { CHARS_PER_TOKEN, DECISION_RESERVE_TOKENS, DECISION_WINDOW, DEFAULT_ROUTING, EMBED_BATCH, EMBEDDING_DIMENSIONS, ENDPOINTS, WRITER_REASONING } from './config.js';
import type { MemorySettings, MemoryUsage } from './shapes.js';
import { clip, estimateTokens } from './text.js';

// The engine's models: the decision model on `/alpha/decisions`, the writer on `/v1/chat/completions`, embeddings on
// `/v1/embeddings`. A component reads no environment and holds no key, so every request goes through the app's
// transport action (a function handle in the settings: the client's `defineModelTransport`), which adds the app's
// credentials and answers the response's status and text. Every call is counted in a `Usage` the op answers and
// records (the usage table).

export { ENDPOINTS };

/** The app's transport action: one request to a path, its status and body (status 0: no answer). */
export type TransportArgs = { path: string; body: Record<string, unknown>; keepDimensions?: number };
export type TransportResult = { status: number; text: string };

/** What a model call needs of its action's context. */
export type ModelCtx = { runAction: (ref: FunctionHandle<'action', TransportArgs, TransportResult>, args: TransportArgs) => Promise<TransportResult> };

/** A call the provider answered as failed. `usage`: what its answer says was billed, if anything. */
export class GatewayError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly usage: unknown = null,
  ) {
    super(message);
  }
}

/** One request through the app's transport: its JSON, or GatewayError. */
async function send(ctx: ModelCtx, settings: MemorySettings, path: string, body: Record<string, unknown>, keepDimensions?: number): Promise<Record<string, unknown>> {
  const res = await ctx.runAction(settings.transport as FunctionHandle<'action', TransportArgs, TransportResult>, { path, body, ...(keepDimensions ? { keepDimensions } : {}) });
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(res.text) as Record<string, unknown>;
  } catch {
    // not JSON: the status and text say what happened
  }
  const error = json.error as { message?: unknown } | undefined;
  if (res.status < 200 || res.status >= 300 || error) throw new GatewayError(`Model provider ${res.status}: ${String(error?.message ?? res.text).slice(0, 300)}`, res.status, json.usage ?? null);
  return json;
}

// ---------------------------------------------------------------- usage

type Counted = { calls: number; inputTokens: number; outputTokens: number; micros: number };

type Prices = MemorySettings['prices'];

/** What `model`'s tokens cost at `prices` ($ per million tokens), in micro-dollars. */
const listMicros = (prices: Prices, model: string, input: number, output: number): number => {
  const p = prices.find((x) => x.model === model);
  return p ? input * p.input + output * p.output : 0;
};

const count = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);

/** A call's tokens, when its usage says them (chat's names, or the Decisions endpoint's). */
export function tokensOf(u: unknown): { input: number; output: number } | null {
  const r = (u && typeof u === 'object' ? u : {}) as Record<string, unknown>;
  const input = count(r.prompt_tokens) ?? count(r.input_tokens);
  if (input === null) return null;
  return { input, output: count(r.completion_tokens) ?? count(r.output_tokens) ?? 0 };
}

/** What a call cost in micro-dollars, when its usage says (`cost`, USD). */
export function costOf(u: unknown): number | null {
  const usd = count((u && typeof u === 'object' ? (u as Record<string, unknown>) : {}).cost);
  return usd === null ? null : usd * 1e6;
}

export class Usage {
  private readonly models = new Map<string, Counted>();

  constructor(private readonly prices: Prices = []) {}

  /** One call: its tokens and what it cost (micro-dollars). */
  add(model: string, c: { input: number; output: number; micros: number }): void {
    const m = this.models.get(model) ?? { calls: 0, inputTokens: 0, outputTokens: 0, micros: 0 };
    m.calls++;
    m.inputTokens += Math.max(0, Math.round(c.input));
    m.outputTokens += Math.max(0, Math.round(c.output));
    m.micros += Math.max(0, c.micros);
    this.models.set(model, m);
  }

  /** A call that answered: its tokens (else `estimate`), at its `usage.cost` (else at the settings' prices). */
  addAnswered(model: string, u: unknown, estimate: { input: number; output: number }): void {
    const t = tokensOf(u) ?? estimate;
    this.add(model, { ...t, micros: costOf(u) ?? listMicros(this.prices, model, t.input, t.output) });
  }

  get empty(): boolean {
    return this.models.size === 0;
  }

  toJSON(): MemoryUsage {
    let cost = 0;
    const models: MemoryUsage['models'] = [];
    for (const [model, m] of this.models) {
      models.push({ model, calls: m.calls, inputTokens: m.inputTokens, outputTokens: m.outputTokens });
      cost += m.micros;
    }
    return { models, costMicros: Math.ceil(cost) };
  }
}

// ---------------------------------------------------------------- the decision model

/** A typed question of the Decisions endpoint. */
export type DecisionQuestion =
  | { type: 'noul'; instructions: string; criteria?: { true: string; false: string } }
  | { type: 'choice'; instructions: string; criteria: Record<string, string | null> }
  | { type: 'score'; instructions: string; criteria: string[] };
/** An answer as memory reads it: a choice among its question's options, a score among its levels, numbers in [0, 1]. */
export type DecisionAnswer =
  | { type: 'noul'; noul: number }
  | { type: 'choice'; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: 'score'; score: number; probabilities: Record<string, number>; confidence: number };

/** A probability: a finite number, held to [0, 1]; null when it is none. */
const prob = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : null);

function probabilitiesOf(raw: unknown, keys: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const k of keys) {
    const p = prob((raw as Record<string, unknown>)[k]);
    if (p !== null) out[k] = p;
  }
  return out;
}

/**
 * The decision model's answer to `q`, as memory reads it, or null when it is not one (the alpha endpoint's shape may
 * change: every field is checked, nothing is assumed): a noul's p(yes); a choice of one
 * of the options, with each option's probability and a confidence (the model's, else the choice's probability, else
 * 0); a score within the levels (by index, as the probabilities are keyed), likewise.
 */
export function answerOf(q: DecisionQuestion, raw: unknown): DecisionAnswer | null {
  if (!raw || typeof raw !== 'object') return null;
  const a = raw as Record<string, unknown>;
  // An answer that names another type is not this question's; one that names none is read by the question's type.
  if (a.type !== undefined && a.type !== q.type) return null;
  if (q.type === 'noul') {
    const p = prob(a.noul);
    return p === null ? null : { type: 'noul', noul: p };
  }
  if (q.type === 'choice') {
    const options = Object.keys(q.criteria);
    if (typeof a.choice !== 'string' || !options.includes(a.choice)) return null;
    const probabilities = probabilitiesOf(a.probabilities, options);
    return { type: 'choice', choice: a.choice, probabilities, confidence: prob(a.confidence) ?? probabilities[a.choice] ?? 0 };
  }
  if (typeof a.score !== 'number' || !Number.isFinite(a.score)) return null;
  const levels = q.criteria.map((_, i) => String(i));
  const score = Math.min(levels.length - 1, Math.max(0, a.score));
  const probabilities = probabilitiesOf(a.probabilities, levels);
  return { type: 'score', score, probabilities, confidence: prob(a.confidence) ?? probabilities[String(Math.round(score))] ?? 0 };
}

/** p(yes) of a yes/no answer; `unknown` when the model left it out: each caller says what an unknown means. */
export const pYes = (a: DecisionAnswer | undefined, unknown: number) => (a?.type === 'noul' ? a.noul : unknown);

// ---------------------------------------------------------------- the models of one op

/** A JSON Schema the writer answers, by name (strict: every property required, no other allowed). */
export type WriterSchema = { name: string; schema: Record<string, unknown> };

export class AiError extends Error {}

/** One op's models and its usage. */
export class Models {
  readonly usage: Usage;

  constructor(
    private readonly ctx: ModelCtx,
    readonly settings: MemorySettings,
  ) {
    this.usage = new Usage(settings.prices);
  }

  /** The models' names, as the decisions log names them. */
  get decisionModel(): string {
    return this.settings.decisionModel ?? 'none';
  }
  get writerModel(): string {
    return this.settings.writerModel;
  }

  /**
   * One call, counted. A failure the provider answered counts what it says it billed; one with no answer read may
   * have run, so its input is counted at the settings' prices. The gateway dialect routes every request by the
   * settings' routing (zero data retention and no data collection unless the app says otherwise).
   */
  private async call(path: string, model: string, body: Record<string, unknown>, input: number, keepDimensions?: number): Promise<Record<string, unknown>> {
    const { provider, ...rest } = body;
    const routed = this.settings.dialect === 'gateway' ? { provider: { ...(this.settings.routing ?? DEFAULT_ROUTING), ...((provider as object | undefined) ?? {}) } } : {};
    try {
      return await send(this.ctx, this.settings, path, { ...rest, model, ...routed }, keepDimensions);
    } catch (e) {
      if (e instanceof GatewayError && e.status !== 0) this.usage.add(model, { ...(tokensOf(e.usage) ?? { input: 0, output: 0 }), micros: costOf(e.usage) ?? 0 });
      else this.usage.add(model, { input, output: 0, micros: listMicros(this.settings.prices, model, input, 0) });
      throw e;
    }
  }

  /**
   * The decision model's answers, by question id: `state` (built to fit its context here: a long text keeps its `keep`
   * end) and 1 to 64 typed questions, in one call. Each answer is read for its question (answerOf); one that is not is
   * left out. Throws when the settings name no decision model: every caller treats that as a failed call.
   */
  async decide(state: unknown, questions: Record<string, DecisionQuestion>, o: { keep?: 'head' | 'tail' } = {}): Promise<Record<string, DecisionAnswer>> {
    const model = this.settings.decisionModel;
    if (!model) throw new AiError('No decision model is set');
    const ids = Object.keys(questions);
    if (ids.length < 1 || ids.length > 64) throw new AiError(`The decision model takes 1 to 64 questions, not ${ids.length}`);
    const qTokens = estimateTokens(JSON.stringify(questions));
    let text = typeof state === 'string' ? state : JSON.stringify(state ?? null);
    const room = Math.max(1_000, DECISION_WINDOW - DECISION_RESERVE_TOKENS - qTokens);
    let body: unknown = state;
    if (estimateTokens(text) > room) {
      text = clip(text, Math.floor(room * CHARS_PER_TOKEN), o.keep ?? 'tail');
      body = text;
    }
    const input = estimateTokens(text) + qTokens;
    const out = await this.call(ENDPOINTS.decisions, model, { state: body ?? '', questions }, input);
    this.usage.addAnswered(model, out.usage, { input, output: 0 });
    const raw = out.answers;
    if (!raw || typeof raw !== 'object') throw new AiError('The decision model answered nothing');
    const answers: Record<string, DecisionAnswer> = {};
    for (const [id, q] of Object.entries(questions)) {
      const a = answerOf(q, (raw as Record<string, unknown>)[id]);
      if (a) answers[id] = a;
    }
    // Answers none of which reads as its question's: the endpoint's shape changed. Callers treat each as unknown; say so.
    if (!Object.keys(answers).length) console.error(JSON.stringify({ memory: 'decision answers unreadable', sample: JSON.stringify(raw).slice(0, 300) }));
    return answers;
  }

  /**
   * The writer's text: `maxTokens` for its answer and WRITER_REASONING.tokens for its reasoning; null when it wrote
   * none (failed, refused, or cut off before any content: never its reasoning).
   */
  private async write(system: string, user: string, maxTokens: number, format?: WriterSchema): Promise<string | null> {
    const input = estimateTokens(system + user);
    const model = this.settings.writerModel;
    const effort = this.settings.writerReasoning;
    const gateway = this.settings.dialect === 'gateway';
    let out: Record<string, unknown>;
    try {
      out = await this.call(
        ENDPOINTS.chat,
        model,
        {
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          ...(format ? { response_format: { type: 'json_schema', json_schema: { name: format.name, strict: true, schema: format.schema } } } : {}),
          max_completion_tokens: maxTokens + (effort ? WRITER_REASONING.tokens : 0),
          ...(effort ? (gateway ? { reasoning: { effort } } : { reasoning_effort: effort }) : {}),
          // Only endpoints that honor the schema, the token budget and the effort.
          ...(gateway ? { provider: { require_parameters: true } } : {}),
        },
        input,
      );
    } catch (e) {
      console.error('memory writer', e instanceof Error ? e.message.slice(0, 300) : 'error');
      return null;
    }
    const content = contentOf(out);
    this.usage.addAnswered(model, out.usage, { input, output: estimateTokens(content ?? '') });
    return content;
  }

  /** The writer: a JSON object answering `schema`, or null when it could not write one (the caller keeps going without). */
  async json<T>(system: string, user: string, schema: WriterSchema, maxTokens: number): Promise<T | null> {
    return parseJson<T>(await this.write(system, user, maxTokens, schema));
  }

  /** Plain text from the writer (recall's answer); null when it wrote none. */
  async text(system: string, user: string, maxTokens: number): Promise<string | null> {
    return (await this.write(system, user, maxTokens))?.trim() || null;
  }

  /**
   * Embeddings of `texts`, in order (batches of EMBED_BATCH), each EMBEDDING_DIMENSIONS long and of unit length.
   * `query`: the texts are searches, and get the settings' query prefix (what is stored, and HyDE's would-be memories,
   * get none). The transport keeps only each vector's first EMBEDDING_DIMENSIONS values, so answers stay small.
   */
  async embed(texts: string[], o: { query?: boolean } = {}): Promise<number[][]> {
    const model = this.settings.embeddingModel;
    const prefix = o.query ? (this.settings.embeddingQueryPrefix ?? '') : '';
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += EMBED_BATCH) {
      const batch = texts
        .slice(i, i + EMBED_BATCH)
        .map((t) => clip(t, 8_000))
        .map((t) => `${prefix}${t}`);
      const input = batch.reduce((n, t) => n + estimateTokens(t), 0);
      const dims = this.settings.dialect === 'openai' ? { dimensions: EMBEDDING_DIMENSIONS } : {};
      const r = await this.call(ENDPOINTS.embeddings, model, { input: batch, ...dims }, input, EMBEDDING_DIMENSIONS);
      this.usage.addAnswered(model, r.usage, { input, output: 0 });
      const data = Array.isArray(r.data) ? (r.data as { embedding?: unknown; index?: unknown }[]) : [];
      const vectors = batch.map((_, j) => vectorOf((data.find((d) => d.index === j) ?? data[j])?.embedding));
      if (vectors.some((v) => !v)) throw new AiError(`The embedding model answered no ${EMBEDDING_DIMENSIONS}-dimensional vectors`);
      out.push(...(vectors as number[][]));
    }
    return out;
  }
}

/**
 * An embedding as the vector index holds it: its first EMBEDDING_DIMENSIONS values (a prefix of a Matryoshka-trained
 * embedding is itself one), scaled to unit length; null when it is not one.
 */
export function vectorOf(v: unknown): number[] | null {
  if (!Array.isArray(v) || v.length < EMBEDDING_DIMENSIONS) return null;
  const head = v.slice(0, EMBEDDING_DIMENSIONS);
  if (!head.every((x) => typeof x === 'number' && Number.isFinite(x))) return null;
  const norm = Math.hypot(...(head as number[]));
  return norm > 0 ? (head as number[]).map((x) => x / norm) : null;
}

/** The text of a chat completion's first choice (null when it has none: a refusal, or reasoning cut off). */
const contentOf = (out: Record<string, unknown>): string | null => {
  const c = (out.choices as { message?: { content?: unknown } }[] | undefined)?.[0]?.message?.content;
  return typeof c === 'string' ? c : null;
};

/** A writer's answer as an object: its JSON (in a code fence, or with text around it, at worst). */
function parseJson<T>(v: string | null): T | null {
  if (v === null) return null;
  const s = v
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```$/, '')
    .trim();
  try {
    return JSON.parse(s) as T;
  } catch {
    const start = s.indexOf('{');
    const end = s.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try {
      return JSON.parse(s.slice(start, end + 1)) as T;
    } catch {
      return null;
    }
  }
}
