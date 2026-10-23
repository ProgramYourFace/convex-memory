import { holdsSecret } from './redact.js';
import { anchorDates } from './dates.js';
import { INGEST, WRITER_ANSWER_TOKENS } from './config.js';
import { AiError, type Models } from './models.js';
import { DETAIL_SYSTEM, EXTRACT_SCHEMA, EXTRACT_SYSTEM, INSTRUCTIONS_SYSTEM, VERIFY_SCHEMA, VERIFY_SYSTEM } from './prompts.js';
import { MEMORY_KINDS, type Authority, type MemoryKind, type Trust } from './shapes.js';
import { chunk, keywords, lineOf, normalizeQuote, normalizeTopic, pool, quoteSources, windows, type Indexed } from './text.js';

// Ingest stages 3 to 5: the writer extracts (a full pass over chunks, a detail pass over windows, and when untrusted text
// is in the batch an instructions pass over the trusted messages alone), code verifies (every quote verbatim in its
// messages, time phrases to dates, trust earned by what trusted text says, instructions only from the instructions
// pass or a batch with no untrusted text, nothing key-shaped), the writer checks the rest (Agent Memory's eight checks:
// pass, correct or drop; a correction must still be what the sources say).
//
// Trust: an item is trusted only when every quote of it is in a message that vouches (a trusted message a person or the
// app wrote: never the assistant's, whose words restate what it read, nor a tool's), one of them says something (at least
// INGEST.trustQuoteChars characters or trustQuoteWords words, or a whole message), its vouching sources hold at least
// trustCoverage of its content's words, and none of its other words is one only the rest of what the writer read says
// (an untrusted page's address, the assistant's restatement of one). Else it is untrusted: kept as a fact or event at
// most, never an instruction, and it never supersedes or weakens a trusted memory (relate.ts). Untrusted text can steer
// the writer to quote a trusted "thanks" for an invented rule, or a trusted question for the answer a page gave; it
// cannot make the person have said either.

/** What the writer answers per item (unchecked). */
export type RawItem = { kind?: unknown; topic?: unknown; content?: unknown; quotes?: unknown; time?: unknown; queries?: unknown; lines?: unknown };

/** A memory ready to relate: checked, dated, with its sources. */
export type Candidate = {
  kind: MemoryKind;
  topic: string | null;
  content: string;
  queries: string[];
  sources: string[];
  author: string;
  trust: Trust;
  validFrom: number | null;
  /** The newest source's time: the order memories of one batch are related in. */
  at: number;
  confidence: number;
  /** Shared memory: `manager` only when every source message is a manager's; null when none says. */
  authority: Authority | null;
  /** The outside agent that kept it for the author (remember's `via`). */
  via: string | null;
};

/** The authority of words from `sources`: manager when all are, member when any says less, null when none says. */
export function authorityOf(sources: { authority?: Authority | null }[]): Authority | null {
  if (!sources.length || sources.every((m) => !m.authority)) return null;
  return sources.every((m) => m.authority === 'manager') ? 'manager' : 'member';
}

const strings = (v: unknown, max: number, len = 500): string[] =>
  Array.isArray(v)
    ? v
        .filter((x): x is string => typeof x === 'string')
        .map((x) => x.trim().slice(0, len))
        .filter(Boolean)
        .slice(0, max)
    : [];

/** What an extraction job yields: the item, the messages it read, and whether an instruction may come from it. */
export type Extracted = { item: RawItem; scope: Indexed[]; instructions: boolean };

/**
 * The full pass (chunks) and, for batches of INGEST.detailMinMessages or more, the detail pass (windows). With untrusted
 * messages among them, those passes yield no instructions; an instructions pass over the trusted messages alone does.
 * Throws when the writer answered none of them.
 */
export async function extract(models: Models, messages: Indexed[]): Promise<Extracted[]> {
  if (!messages.length) return [];
  const mixed = messages.some((m) => m.trust === 'untrusted');
  const jobs: { system: string; scope: Indexed[]; instructions: boolean; only?: 'instruction' }[] = chunk(messages).map((scope) => ({ system: EXTRACT_SYSTEM, scope, instructions: !mixed }));
  if (messages.length >= INGEST.detailMinMessages) for (const scope of windows(messages)) jobs.push({ system: DETAIL_SYSTEM, scope, instructions: !mixed });
  const trusted = messages.filter((m) => m.trust === 'trusted');
  if (mixed && trusted.length) for (const scope of chunk(trusted)) jobs.push({ system: INSTRUCTIONS_SYSTEM, scope, instructions: true, only: 'instruction' });
  let answered = 0;
  const answers = await pool(jobs, INGEST.concurrency, async (job) => {
    const out = await models.json<{ items?: RawItem[] }>(job.system, job.scope.map(lineOf).join('\n'), EXTRACT_SCHEMA, WRITER_ANSWER_TOKENS.extract);
    if (out) answered++;
    return (Array.isArray(out?.items) ? out.items : [])
      .slice(0, 60)
      .filter((item) => !job.only || item?.kind === job.only)
      .map((item) => ({ item, scope: job.scope, instructions: job.instructions }));
  });
  // A writer that answered none of the passes is down: the drain fails and the batch is read again later.
  if (!answered) throw new AiError('The writer answered no extraction pass');
  return answers.flat();
}

/** Whether a message's words make a memory trusted: a trusted message that neither the assistant nor a tool wrote. */
export const vouches = (m: { trust: Trust; role: string }) => m.trust === 'trusted' && m.role !== 'assistant' && m.role !== 'tool';

/** Words that name who a memory is about rather than what it says. */
const GENERIC = new Set(['person', 'persons', 'people', 'user', 'users', 'someone', 'assistant', 'company', 'team', 'family', 'member', 'members']);

/** How much of `content`'s words `sources` say (a word counts when a source word shares its first four letters). */
export function coverage(content: string, sources: string[]): number {
  const words = keywords(content, 60).filter((w) => !GENERIC.has(w));
  if (!words.length) return 1;
  const stems = new Set(keywords(sources.join('\n'), 2_000).map((w) => w.slice(0, 4)));
  return words.filter((w) => stems.has(w.slice(0, 4))).length / words.length;
}

/**
 * Whether `content` says words that `others` (what the writer read that does not vouch) say and `sources` (the vouching
 * words it rests on) do not: words it took from untrusted text, or from the assistant's restatement of it.
 */
export function tainted(content: string, sources: string[], others: string[]): boolean {
  if (!others.length) return false;
  const stems = (texts: string[]) => new Set(keywords(texts.join('\n'), 4_000).map((w) => w.slice(0, 4)));
  const own = stems(sources);
  const foreign = stems(others);
  return keywords(content, 60).some((w) => !GENERIC.has(w) && !own.has(w.slice(0, 4)) && foreign.has(w.slice(0, 4)));
}

/** Whether a quote, as found in `message`, says something: long enough, or the whole message. */
function substantive(quote: string, message: { content: string }): boolean {
  const q = normalizeQuote(quote).replace(/^["']|["']$/g, '').trim();
  const whole = normalizeQuote(message.content);
  return q.length >= INGEST.trustQuoteChars || q.split(' ').length >= INGEST.trustQuoteWords || q === whole || q === whole.replace(/[.!?]+$/, '');
}

/**
 * Code's checks of one extracted item. Null drops it: an unknown kind, no content, a quote that is not verbatim in the
 * messages (an invented quote), an instruction that is untrusted or from a pass that read untrusted text, or a secret
 * (a key- or token-shaped string: memory never keeps one, redact.ts; passwords are kept out by the prompt).
 */
export function verifyItem(raw: RawItem, scope: Indexed[], instructions = true): Candidate | null {
  const kind = MEMORY_KINDS.find((k) => k === raw.kind);
  const content = typeof raw.content === 'string' ? raw.content.trim().slice(0, 2_000) : '';
  if (!kind || content.length < 3) return null;
  if (holdsSecret(content)) return null;
  if (kind === 'instruction' && !instructions) return null;
  const quotes = strings(raw.quotes, 3, 1_000);
  if (!quotes.length) return null;
  // The messages the item names first, then the rest of what the writer read.
  const lines = new Set(Array.isArray(raw.lines) ? (raw.lines as unknown[]).filter((x): x is number => Number.isInteger(x)) : []);
  const named = scope.filter((m) => lines.has(m.index));
  const sources = new Map<string, Indexed>();
  let untrusted = false;
  let says = false;
  for (const q of quotes) {
    let found = quoteSources(q, named);
    if (!found.length) found = quoteSources(q, scope);
    if (!found.length) return null;
    // A quote counts as trusted when a message that vouches says it.
    const trusted = found.filter(vouches);
    if (!trusted.length) untrusted = true;
    if (trusted.some((m) => substantive(q, m))) says = true;
    for (const m of trusted.length ? trusted : found) sources.set(m.id, m);
  }
  // A speaker's name counts as said by their own messages (the memory names them by it).
  const trustedText = [...sources.values()].filter(vouches).map((m) => (m.authorName ? `${m.authorName}\n${m.content}` : m.content));
  const others = scope.filter((m) => !vouches(m)).map((m) => m.content);
  if (!untrusted && (!says || coverage(content, trustedText) < INGEST.trustCoverage || tainted(content, trustedText, others))) untrusted = true;
  if (untrusted && kind === 'instruction') return null;
  const src = [...sources.values()].sort((a, b) => a.at - b.at);
  const first = src[0]!;
  const last = src.at(-1)!;
  // Time phrases count only when the messages say them; each resolves against the message that says it.
  const lean = kind === 'task' ? 'future' : 'past';
  let text = content;
  let from: number | null = null;
  for (const phrase of strings(raw.time, 6, 100)) {
    const sayer = src.find((m) => normalizeQuote(m.content).includes(normalizeQuote(phrase))) ?? scope.find((m) => normalizeQuote(m.content).includes(normalizeQuote(phrase)));
    if (!sayer) continue;
    const r = anchorDates(text, [phrase], sayer.at, /\b(will|going to|next|tomorrow|plan)/i.test(phrase) ? 'future' : lean, sayer.tz);
    text = r.content;
    if (r.from !== null) from = from === null ? r.from : Math.min(from, r.from);
  }
  return {
    kind,
    topic: normalizeTopic(typeof raw.topic === 'string' ? raw.topic : null),
    content: text,
    queries: strings(raw.queries, 5, 200),
    sources: src.map((m) => m.id),
    author: (src.find(vouches) ?? first).author,
    trust: untrusted ? 'untrusted' : 'trusted',
    validFrom: from ?? first.at,
    at: last.at,
    confidence: INGEST.newConfidence,
    authority: authorityOf(src),
    via: null,
  };
}

/** The full and detail passes' items as one list: the same content (normalized) once, with both sources. */
export function mergeItems(items: Candidate[]): Candidate[] {
  const out = new Map<string, Candidate>();
  for (const c of items) {
    const key = `${c.kind}\u0000${normalizeQuote(c.content)}`;
    const cur = out.get(key);
    if (!cur) out.set(key, c);
    else {
      cur.sources = [...new Set([...cur.sources, ...c.sources])];
      cur.queries = [...new Set([...cur.queries, ...c.queries])].slice(0, 5);
      cur.topic = cur.topic ?? c.topic;
      cur.at = Math.max(cur.at, c.at);
      if (c.trust === 'trusted') cur.trust = 'trusted';
      // Both said it: it stands on the lesser of the two.
      cur.authority = authorityOf([{ authority: cur.authority }, { authority: c.authority }]);
    }
  }
  return [...out.values()].sort((a, b) => a.at - b.at);
}

export type Verdict = { i: number; verdict: 'pass' | 'correct' | 'drop'; content?: string | null };
export type CheckedVerdict = Verdict['verdict'] | 'unchecked' | 'correction refused';

/**
 * The writer's checks, in batches: each item passes, is corrected or is dropped. A batch the writer could not answer
 * passes (code has checked the quotes already; a wrong memory is cheap to fix later).
 */
export async function verifyItems(models: Models, items: Candidate[], messages: Indexed[]): Promise<{ kept: Candidate[]; verdicts: { item: Candidate; verdict: CheckedVerdict }[] }> {
  const byId = new Map(messages.map((m) => [m.id, m]));
  const others = messages.filter((m) => !vouches(m)).map((m) => m.content);
  const batches: Candidate[][] = [];
  for (let i = 0; i < items.length; i += INGEST.verifyBatch) batches.push(items.slice(i, i + INGEST.verifyBatch));
  const results = await pool(batches, INGEST.concurrency, async (batch) => {
    const lines = [...new Set(batch.flatMap((c) => c.sources))]
      .map((id) => byId.get(id))
      .filter((m): m is Indexed => !!m)
      .sort((a, b) => a.index - b.index)
      .map(lineOf);
    const user = `Messages:\n${lines.join('\n')}\n\nMemories:\n${batch.map((c, i) => `${i}. (${c.kind}) ${c.content}`).join('\n')}`;
    const out = await models.json<{ results?: Verdict[] }>(VERIFY_SYSTEM, user, VERIFY_SCHEMA, WRITER_ANSWER_TOKENS.verify);
    const verdicts = new Map<number, Verdict>();
    for (const v of Array.isArray(out?.results) ? out.results : []) if (Number.isInteger(v?.i)) verdicts.set(v.i, v);
    return batch.map((item, i) => ({ item, v: out ? verdicts.get(i) : undefined }));
  });
  const kept: Candidate[] = [];
  const verdicts: { item: Candidate; verdict: CheckedVerdict }[] = [];
  for (const { item, v } of results.flat()) {
    if (v?.verdict === 'drop') {
      verdicts.push({ item, verdict: 'drop' });
      continue;
    }
    if (v?.verdict === 'correct' && typeof v.content === 'string' && v.content.trim().length >= 3) {
      // A correction is still what the sources say (by their words), brings a trusted memory no words that only untrusted
      // text (or the assistant) says, and holds no secret; or the item stays as code checked it.
      const corrected = v.content.trim().slice(0, 2_000);
      const said = item.sources.map((id) => byId.get(id)?.content ?? '');
      const vouched = item.sources.flatMap((id) => {
        const m = byId.get(id);
        return m && vouches(m) ? [m.authorName ? `${m.authorName}\n${m.content}` : m.content] : [];
      });
      if (coverage(corrected, said) < INGEST.trustCoverage || (item.trust === 'trusted' && tainted(corrected, vouched, others)) || holdsSecret(corrected)) {
        verdicts.push({ item, verdict: 'correction refused' });
        kept.push(item);
        continue;
      }
      item.content = corrected;
    }
    verdicts.push({ item, verdict: v?.verdict ?? 'unchecked' });
    kept.push(item);
  }
  return { kept, verdicts };
}
