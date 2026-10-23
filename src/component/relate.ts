import { holdsSecret } from './redact.js';
import { INGEST, THRESHOLDS, WRITER_ANSWER_TOKENS } from './config.js';
import { authorityOf, type Candidate } from './extract.js';
import type { Models } from './models.js';
import { MERGE_SCHEMA, MERGE_SYSTEM, RELATE_SCHEMA, RELATE_SYSTEM, RELATION_CRITERIA } from './prompts.js';
import type { Authority, MemoryKind, Trust } from './shapes.js';
import { digestOf, keywords } from './text.js';

// Ingest stage 6: how each new keyed memory (fact, instruction) relates to what the scope holds. The decision model
// decides per pair (same | updates | refines | conflicts | unrelated); below the threshold the writer decides; still
// unsure, both are kept. Code applies the answer:
//   same       the existing one gains the sources (and confidence, when the new one is as trusted);
//   updates    a new version: the existing one is superseded (supersededAt, supersededBy, validTo);
//   refines    the writer merges both into one sentence (code checks it kept both), a new version as above, as trusted
//              as the less trusted of the two;
//   conflicts  both kept, both at the conflict confidence;
//   unrelated  a new memory.
// Standing: a new memory stands below an existing one when it is less trusted (untrusted against trusted) or of less
// authority (a member's against a manager's, in shared memory). What stands below never supersedes, refines away or
// lowers the confidence of what stands above it: such an update or refinement is kept beside it, as a conflict, and a
// "same" merges nothing into it. Events never supersede and tasks are never related (an identical one is one row by
// its id). The commit checks standing again against the version that is current when it writes (store.ts commit).
//
// Memories of one batch are related in the order they were said, each against the scope and the batch's earlier
// ones, so the later of two statements about one topic is the current one.

export const RELATIONS = ['same', 'updates', 'refines', 'conflicts', 'unrelated'] as const;
export type Relation = (typeof RELATIONS)[number];
const PRIORITY: Record<Relation, number> = { same: 0, updates: 1, refines: 2, conflicts: 3, unrelated: 4 };

/** A current memory as relate reads it (store.ts storedOf). */
export type StoredMemory = { id: string; kind: MemoryKind; topic: string | null; content: string; trust: Trust; authority: Authority | null; recordedAt: number; sources: string[]; confidence: number };

/** One decision, logged with its input's digest, its answer, its confidence and the threshold it was held against. */
export type Decision = { stage: string; model: string; inputDigest: string; answer: unknown; confidence: number | null; threshold?: number | null; memoryId?: string | null };

/** A memory the plan writes; `supersedes` names the version it replaces (a stored id, or `row:<i>` of this plan). */
export type PlanRow = Candidate & { supersedes: string | null; embedding: number[] | null };

/** What one write commits, in one transaction (store.ts commit). */
export type Plan = {
  rows: PlanRow[];
  /** Stored memories this plan replaces. */
  supersede: string[];
  confirm: { id: string; sources: string[]; step: number }[];
  /** A conflict lowered a stored memory to `value`. */
  confidence: { id: string; value: number }[];
  decisions: Decision[];
  /** Per input candidate: what became of it (a new row's index, or the stored memory it confirmed). */
  outcome: ({ row: number } | { existing: string })[];
};

export const emptyPlan = (): Plan => ({ rows: [], supersede: [], confirm: [], confidence: [], decisions: [], outcome: [] });

export type RelateDeps = {
  models: Models;
  /** The scope's current memories under exactly `topic`. */
  byTopic: (topic: string) => Promise<StoredMemory[]>;
  /** The scope's current memories matching `terms` in full text, best first. */
  search: (terms: string[], limit: number) => Promise<StoredMemory[]>;
  /** The scope's current memories nearest to an embedding; empty when unavailable. */
  nearest: (values: number[], k: number) => Promise<StoredMemory[]>;
  /** Embeddings of the candidates (by index), when there are any. */
  embeddings: (number[] | null)[];
};

const keyed = (c: { kind: MemoryKind }) => c.kind === 'fact' || c.kind === 'instruction';

/** A pending or stored memory as relate reads it. */
type Existing = { ref: { stored: string } | { row: number }; kind: string; topic: string | null; content: string; trust: Trust; authority: Authority | null; recordedAt: number; sources: string[]; confidence: number };

const fromStored = (m: StoredMemory): Existing => ({ ref: { stored: m.id }, kind: m.kind, topic: m.topic, content: m.content, trust: m.trust, authority: m.authority, recordedAt: m.recordedAt, sources: m.sources, confidence: m.confidence });

/** Whether `a` stands below `b`: less trusted, or of less authority (no authority counts as a member's). */
export function standsBelow(a: { trust: Trust; authority?: Authority | null }, b: { trust: Trust; authority?: Authority | null }): boolean {
  const rank = (x: { authority?: Authority | null }) => (x.authority === 'manager' ? 1 : 0);
  return (a.trust === 'untrusted' && b.trust === 'trusted') || rank(a) < rank(b);
}

const quiet = async <T>(what: string, f: () => Promise<T[]>): Promise<T[]> => {
  try {
    return await f();
  } catch (e) {
    console.error(`memory relate ${what}`, e instanceof Error ? e.message.slice(0, 200) : 'error');
    return [];
  }
};

/** The candidates a new memory is related to: the same topic (stored and earlier in the batch), its nearest vectors, full text. */
async function candidatesFor(d: RelateDeps, plan: Plan, c: Candidate, i: number, replaced: Set<string>): Promise<Existing[]> {
  const out = new Map<string, Existing>();
  const add = (e: Existing) => {
    const key = 'stored' in e.ref ? e.ref.stored : `row:${e.ref.row}`;
    if (e.kind === c.kind && !out.has(key) && !('stored' in e.ref && replaced.has(e.ref.stored))) out.set(key, e);
  };
  plan.rows.forEach((r, row) => {
    const live = !plan.rows.some((x) => x.supersedes === `row:${row}`);
    if (live && c.topic && r.topic === c.topic) add({ ref: { row }, kind: r.kind, topic: r.topic, content: r.content, trust: r.trust, authority: r.authority, recordedAt: r.at, sources: r.sources, confidence: r.confidence });
  });
  if (c.topic) for (const m of await quiet('topic', () => d.byTopic(c.topic!))) add(fromStored(m));
  const v = d.embeddings[i];
  if (v) for (const m of await quiet('vectors', () => d.nearest(v, INGEST.relateCandidates))) add(fromStored(m));
  const terms = keywords(c.content, 8);
  if (terms.length) for (const m of await quiet('search', () => d.search(terms, 3))) add(fromStored(m));
  return [...out.values()].slice(0, INGEST.relateCandidates);
}

/** What the batch writes. */
export async function relate(d: RelateDeps, items: Candidate[]): Promise<Plan> {
  const plan = emptyPlan();
  // Stored memories this batch already replaced: a later item relates to the batch's new version instead.
  const replaced = new Set<string>();
  for (let i = 0; i < items.length; i++) {
    const c = items[i]!;
    if (!keyed(c)) {
      plan.outcome.push({ row: insert(plan, c, null) });
      continue;
    }
    const existing = await candidatesFor(d, plan, c, i, replaced);
    if (!existing.length) {
      plan.outcome.push({ row: insert(plan, c, null) });
      continue;
    }
    const { relation, target } = await decide(d, plan, c, existing);
    plan.outcome.push(await apply(d, plan, c, relation, target, replaced));
  }
  return plan;
}

function insert(plan: Plan, c: Candidate, supersedes: string | null): number {
  plan.rows.push({ ...c, supersedes, embedding: null });
  return plan.rows.length - 1;
}

const refOf = (e: Existing) => ('stored' in e.ref ? e.ref.stored : `row:${e.ref.row}`);
const storedId = (e: Existing) => ('stored' in e.ref ? e.ref.stored : null);
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** The decision model per pair; the writer below the threshold; `unsure` when neither can tell. */
async function decide(d: RelateDeps, plan: Plan, c: Candidate, existing: Existing[]): Promise<{ relation: Relation | 'unsure'; target: Existing | null }> {
  const state = {
    new: { kind: c.kind, topic: c.topic, content: c.content, said: day(c.at), trust: c.trust },
    existing: existing.map((e, k) => ({ k, topic: e.topic, content: e.content, recorded: day(e.recordedAt), trust: e.trust })),
  };
  const questions = Object.fromEntries(existing.map((_, k) => [`r${k}`, { type: 'choice' as const, instructions: `How does the new memory relate to existing memory ${k}?`, criteria: RELATION_CRITERIA }]));
  let answers: Record<string, { relation: Relation; confidence: number }> = {};
  try {
    const r = await d.models.decide(state, questions);
    for (const [id, a] of Object.entries(r)) if (a.type === 'choice' && (RELATIONS as readonly string[]).includes(a.choice)) answers[id] = { relation: a.choice as Relation, confidence: a.confidence };
  } catch (e) {
    console.error('memory relate decision', e instanceof Error ? e.message.slice(0, 200) : 'error');
    answers = {};
  }
  const digest = await digestOf(state);
  existing.forEach((e, k) => {
    const a = answers[`r${k}`];
    plan.decisions.push({ stage: 'relate', model: d.models.decisionModel, inputDigest: digest, answer: { candidate: refOf(e), relation: a?.relation ?? null }, confidence: a?.confidence ?? null, threshold: THRESHOLDS.relateConfidence, memoryId: storedId(e) });
  });
  const ranked = existing
    .map((e, k) => ({ e, a: answers[`r${k}`] }))
    .filter((x): x is { e: Existing; a: { relation: Relation; confidence: number } } => !!x.a)
    .sort((x, y) => PRIORITY[x.a.relation] - PRIORITY[y.a.relation] || y.a.confidence - x.a.confidence);
  const sure = ranked.filter((x) => x.a.confidence >= THRESHOLDS.relateConfidence);
  const related = sure.find((x) => x.a.relation !== 'unrelated');
  if (related) return { relation: related.a.relation, target: related.e };
  // Every pair confidently unrelated: a new memory.
  if (sure.length === existing.length) return { relation: 'unrelated', target: null };
  // Below the threshold: the writer decides on the likeliest pair; it can be unsure too.
  const doubt = ranked.filter((x) => x.a.confidence < THRESHOLDS.relateConfidence && x.a.relation !== 'unrelated')[0]?.e ?? existing.find((_, k) => !answers[`r${k}`]);
  if (!doubt) return { relation: 'unrelated', target: null };
  const user = `Existing (recorded ${day(doubt.recordedAt)}): ${doubt.content}\nNew (said ${day(c.at)}): ${c.content}`;
  const out = await d.models.json<{ relation?: string }>(RELATE_SYSTEM, user, RELATE_SCHEMA, WRITER_ANSWER_TOKENS.relate);
  const relation = (RELATIONS as readonly string[]).includes(out?.relation ?? '') ? (out!.relation as Relation) : 'unsure';
  plan.decisions.push({ stage: 'relate.writer', model: d.models.writerModel, inputDigest: await digestOf(user), answer: { candidate: refOf(doubt), relation }, confidence: null, memoryId: storedId(doubt) });
  return { relation, target: relation === 'unrelated' || relation === 'unsure' ? null : doubt };
}

/** Whether `merged` keeps most of what each of `a` and `b` says (by their words). */
export function keepsBoth(merged: string, a: string, b: string): boolean {
  const words = new Set(keywords(merged, 400));
  const share = (s: string) => {
    const k = keywords(s, 60);
    return k.length ? k.filter((w) => words.has(w)).length / k.length : 1;
  };
  return share(a) >= 0.6 && share(b) >= 0.6;
}

async function apply(d: RelateDeps, plan: Plan, c: Candidate, relation: Relation | 'unsure', target: Existing | null, replaced: Set<string>): Promise<Plan['outcome'][number]> {
  if (!target || relation === 'unrelated' || relation === 'unsure') return { row: insert(plan, c, null) };
  const ref = refOf(target);
  const below = standsBelow(c, target);
  if (relation === 'same') {
    // Said again by someone who stands below it: nothing merges (the memory never comes to rest on their words).
    if (below) {
      plan.decisions.push({ stage: 'relate.below', model: 'none', inputDigest: await digestOf(c.content), answer: { candidate: ref, relation, merged: false }, confidence: null, memoryId: storedId(target) });
      return 'stored' in target.ref ? { existing: target.ref.stored } : { row: target.ref.row };
    }
    if ('stored' in target.ref) {
      plan.confirm.push({ id: target.ref.stored, sources: c.sources, step: INGEST.confirmStep });
      return { existing: target.ref.stored };
    }
    const row = plan.rows[target.ref.row]!;
    row.sources = [...new Set([...row.sources, ...c.sources])];
    // Resting on both sets of words now: a manager's only when both are.
    row.authority = authorityOf([row, c]);
    return { row: target.ref.row };
  }
  if (relation === 'conflicts' || below) {
    // Both kept; neither is sure now. What stands below never weakens what stands above: only the new one is unsure then.
    if (!below) {
      if ('stored' in target.ref) plan.confidence.push({ id: target.ref.stored, value: Math.min(target.confidence, INGEST.conflictConfidence) });
      else plan.rows[target.ref.row]!.confidence = Math.min(target.confidence, INGEST.conflictConfidence);
    }
    return { row: insert(plan, { ...c, confidence: INGEST.conflictConfidence }, null) };
  }
  let next: Candidate = c;
  if (relation === 'refines') {
    const user = `Older: ${target.content}\nNewer: ${c.content}`;
    const out = await d.models.json<{ content?: string; queries?: string[] }>(MERGE_SYSTEM, user, MERGE_SCHEMA, WRITER_ANSWER_TOKENS.merge);
    const merged = typeof out?.content === 'string' ? out.content.trim().slice(0, 2_000) : '';
    const kept = !!merged && keepsBoth(merged, target.content, c.content) && !holdsSecret(merged);
    plan.decisions.push({ stage: 'refine.merge', model: d.models.writerModel, inputDigest: await digestOf(user), answer: { kept }, confidence: null, memoryId: storedId(target) });
    // A merge that lost either side (or wrote a key): both kept as they are.
    if (!kept) return { row: insert(plan, c, null) };
    const queries = Array.isArray(out?.queries)
      ? out.queries
          .filter((q): q is string => typeof q === 'string')
          .map((q) => q.trim().slice(0, 200))
          .filter(Boolean)
          .slice(0, 5)
      : [];
    // The merge rests on both: a manager's only when both are (a member's words in it make it a member's), and trusted
    // only when both are (an untrusted memory's words never come to rest in a trusted one).
    const trust: Trust = target.trust === 'untrusted' || c.trust === 'untrusted' ? 'untrusted' : 'trusted';
    if (trust === 'untrusted' && c.kind === 'instruction') return { row: insert(plan, c, null) };
    next = { ...c, content: merged, queries: queries.length ? queries : c.queries, sources: [...new Set([...target.sources, ...c.sources])], authority: authorityOf([target, c]), trust };
  }
  // updates / refines: a new version of the target.
  const row = insert(plan, next, ref);
  if ('stored' in target.ref) {
    plan.supersede.push(target.ref.stored);
    replaced.add(target.ref.stored);
  }
  return { row };
}
