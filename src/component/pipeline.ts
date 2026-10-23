import { internal } from './_generated/api.js';
import type { ActionCtx } from './_generated/server.js';
import { CHARS_PER_TOKEN, DECISION_RESERVE_TOKENS, DECISION_WINDOW, INGEST, THRESHOLDS } from './config.js';
import { extract, mergeItems, verifyItem, verifyItems, type Candidate } from './extract.js';
import { pYes, type Models } from './models.js';
import { GATE_QUESTIONS } from './prompts.js';
import { relate, type Decision, type Plan, type RelateDeps, type StoredMemory } from './relate.js';
import { loggedOf, storedOf, type ScopeId, type CommitRow, type LoggedDecision, type PipelineMessage } from './store.js';
import { digestOf, lineOf, memoryId, piecesOf, pool, searchText, type Indexed } from './text.js';

// Ingest stages 2 to 6 for one batch (a drain's), and what remember and restore share with it: relating candidates to
// what the scope holds, embedding the rows, and the commit's arguments. Runs in actions; reads go through store.ts.

/** What a scope's relate reads: its current memories by topic, by full text and by vector (read back through the current view). */
export function readerOf(ctx: ActionCtx, scope: ScopeId, models: Models, embeddings: (number[] | null)[] = []): RelateDeps {
  return {
    models,
    embeddings,
    byTopic: (topic) => ctx.runQuery(internal.store.byTopic, { scope, topic }),
    search: async (terms, limit) => {
      const text = searchText(terms);
      return text ? await ctx.runQuery(internal.store.searchMemories, { scope, text, limit }) : [];
    },
    nearest: async (vector, k) => {
      const hits = await ctx.vectorSearch('vectors', 'by_embedding', { vector, limit: k, filter: (q) => q.eq('scope', scope) });
      const rows = await ctx.runQuery(internal.store.hydrate, { vectors: hits.map((h) => h._id), scopes: [scope] });
      return rows.map(storedOf) satisfies StoredMemory[];
    },
  };
}

/** What a memory's vector embeds: the questions it answers, then its content (Agent Memory's order). */
export const embeddingTextOf = (m: { queries: string[]; content: string }) => [...m.queries, m.content].join('\n');

/** The embeddings of `texts`, or nulls when the model failed (a row without a vector is embedded later by the sweep). */
export async function embedOrNot(models: Models, texts: string[]): Promise<(number[] | null)[]> {
  if (!texts.length) return [];
  try {
    return await models.embed(texts);
  } catch (e) {
    console.error('memory embed', e instanceof Error ? e.message.slice(0, 200) : 'error');
    return texts.map(() => null);
  }
}

/** Embeds the candidates (not tasks) and relates them in order; each row keeps its candidate's vector, or is embedded again when relate changed its text. */
export async function relateAll(reader: (embeddings: (number[] | null)[]) => RelateDeps, models: Models, items: Candidate[]): Promise<Plan> {
  const texts = items.map((c) => (c.kind === 'task' ? null : embeddingTextOf(c)));
  const vectors = await embedOrNot(
    models,
    texts.filter((t): t is string => t !== null),
  );
  let k = 0;
  const embeddings = texts.map((t) => (t === null ? null : (vectors[k++] ?? null)));
  const plan = await relate(reader(embeddings), items);
  const byText = new Map<string, number[]>();
  texts.forEach((t, i) => t !== null && embeddings[i] && byText.set(t, embeddings[i]!));
  const pending: number[] = [];
  plan.rows.forEach((r, row) => {
    if (r.kind === 'task') return;
    const same = byText.get(embeddingTextOf(r));
    if (same) r.embedding = same;
    else pending.push(row);
  });
  const again = await embedOrNot(
    models,
    pending.map((row) => embeddingTextOf(plan.rows[row]!)),
  );
  pending.forEach((row, j) => (plan.rows[row]!.embedding = again[j] ?? null));
  return plan;
}

/** The plan as the commit takes it: each row's id (content-addressed, from the version it was planned to supersede), the decisions as logged. */
export async function commitArgsOf(plan: Plan): Promise<{ rows: CommitRow[]; confirm: Plan['confirm']; confidence: Plan['confidence']; outcome: Plan['outcome']; decisions: LoggedDecision[] }> {
  const ids: string[] = [];
  const rows: CommitRow[] = [];
  for (const r of plan.rows) {
    const sup = r.supersedes?.startsWith('row:') ? ids[Number(r.supersedes.slice(4))]! : r.supersedes;
    const id = await memoryId(r.kind, r.topic, r.content, sup);
    ids.push(id);
    rows.push({
      id,
      kind: r.kind,
      topic: r.topic,
      content: r.content,
      queries: r.queries,
      sources: r.sources,
      author: r.author,
      trust: r.trust,
      validFrom: r.validFrom,
      confidence: r.confidence,
      authority: r.authority,
      via: r.via,
      supersedes: r.supersedes,
      embedding: r.kind === 'task' ? null : r.embedding,
    });
  }
  return { rows, confirm: plan.confirm, confidence: plan.confidence, outcome: plan.outcome, decisions: plan.decisions.map(loggedOf) };
}

/**
 * One batch's plan: the gate (the decision model: anything worth remembering, and do the untrusted parts read like
 * instructions to an AI?), extraction and code's checks, the writer's checks, relate. A batch too long for one gate
 * call is read in pieces (remember: any piece; injection: any piece). Untrusted text stays out unless the gate read
 * all of it and found no injection: an unread or unanswered piece is an unknown, and unknown is out.
 */
export async function planIngest(ctx: ActionCtx, scope: ScopeId, models: Models, claimed: { batch: PipelineMessage[]; previous: PipelineMessage[] }): Promise<Plan> {
  const { batch, previous } = claimed;
  const indexed: Indexed[] = [...previous, ...batch].map((m, index) => ({ ...m, index }));
  const fresh = new Set(batch.map((m) => m.id));
  const decisions: Decision[] = [];
  const lines = indexed.map((m) => (m.index < previous.length ? `(earlier) ${lineOf(m)}` : lineOf(m)));
  const room = Math.floor((DECISION_WINDOW - DECISION_RESERVE_TOKENS - 600) * CHARS_PER_TOKEN);
  const pieces = piecesOf(lines, room);
  const read = pieces.slice(0, INGEST.gatePieces);
  const hasUntrusted = batch.some((m) => m.trust === 'untrusted');
  let remember = 0;
  let injection = 0;
  let unknown = pieces.length > read.length;
  await pool(read, INGEST.concurrency, async (text) => {
    const digest = await digestOf(text);
    try {
      const g = await models.decide(text, GATE_QUESTIONS);
      // An answer the model left out is an unknown: worth remembering, and an injection.
      const r = pYes(g.remember, 1);
      const i = hasUntrusted ? pYes(g.injection, 1) : 0;
      remember = Math.max(remember, r);
      injection = Math.max(injection, i);
      const kinds = g.kinds;
      decisions.push(
        { stage: 'gate.remember', model: models.decisionModel, inputDigest: digest, answer: { remember: r, kinds: kinds?.type === 'choice' ? kinds.choice : null }, confidence: r, threshold: THRESHOLDS.gateRemember },
        { stage: 'gate.injection', model: models.decisionModel, inputDigest: digest, answer: { injection: i }, confidence: i, threshold: THRESHOLDS.gateInjection },
      );
    } catch (e) {
      // A gate that could not answer lets the trusted text through (missing a memory costs more) and keeps the
      // untrusted text out (an unchecked injection costs more still).
      console.error('memory gate', e instanceof Error ? e.message.slice(0, 200) : 'error');
      remember = 1;
      unknown = true;
      decisions.push({ stage: 'gate.remember', model: models.decisionModel, inputDigest: digest, answer: { error: true }, confidence: null, threshold: THRESHOLDS.gateRemember });
    }
  });
  if (unknown) remember = 1;
  if (pieces.length > read.length) decisions.push({ stage: 'gate.injection', model: 'none', inputDigest: await digestOf(lines.join('\n')), answer: { unread: pieces.length - read.length }, confidence: null, threshold: THRESHOLDS.gateInjection });
  if (remember < THRESHOLDS.gateRemember) return { rows: [], supersede: [], confirm: [], confidence: [], decisions, outcome: [] };
  const keepUntrusted = hasUntrusted && !unknown && injection < THRESHOLDS.gateInjection;

  // Extract over the batch (with the messages before it for context), then code's checks.
  const readable = indexed.filter((m) => keepUntrusted || m.trust === 'trusted');
  const dropped = indexed.length - readable.length;
  if (dropped) decisions.push({ stage: 'gate.untrusted', model: 'none', inputDigest: await digestOf(String(dropped)), answer: { keptOut: dropped }, confidence: null });
  const raw = await extract(models, readable);
  const checked = mergeItems(raw.map((r) => verifyItem(r.item, r.scope, r.instructions)).filter((c): c is Candidate => !!c && c.sources.some((s) => fresh.has(s))));
  if (checked.length > INGEST.maxItems) decisions.push({ stage: 'extract.cap', model: 'none', inputDigest: await digestOf(String(checked.length)), answer: { dropped: checked.length - INGEST.maxItems }, confidence: null });
  const items = checked.slice(-INGEST.maxItems);
  // The writer's checks.
  const { kept, verdicts } = items.length ? await verifyItems(models, items, indexed) : { kept: [], verdicts: [] };
  const plan = await relateAll((embeddings) => readerOf(ctx, scope, models, embeddings), models, kept);
  const verified = await Promise.all(verdicts.map(async (v) => ({ stage: 'verify', model: models.writerModel, inputDigest: await digestOf(v.item.content), answer: { verdict: v.verdict }, confidence: null })));
  plan.decisions.unshift(...decisions, ...verified);
  return plan;
}
