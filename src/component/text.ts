import { CHARS_PER_TOKEN, INGEST, LIMITS } from './config.js';
import { TOPIC_RE, type MemoryMessage } from './shapes.js';

// What code computes from text: content-addressed ids, chunks, token estimates, quote checks, search terms, topic keys.
// No model is asked any of this.

const enc = new TextEncoder();

/** SHA-256 of a UTF-8 string as lowercase hex. */
async function sha256Hex(data: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(data)))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The first 128 bits of SHA-256 over the parts joined by NUL, as 32 hex characters. */
export const hashId = async (...parts: string[]) => (await sha256Hex(parts.join('\u0000'))).slice(0, 32);

/** A message's id: session, role and content (Agent Memory's), so the same message ingested again is the same row. */
export const messageId = (session: string, role: string, content: string) => hashId(session, role, content);

/**
 * A memory version's id: kind, topic and content, and the version it supersedes (so a restored copy of an old version
 * is a version of its own, while the same memory extracted twice is one row).
 */
export const memoryId = (kind: string, topic: string | null, content: string, supersedes: string | null) => hashId(kind, topic ?? '', content, supersedes ?? '');

/** A digest of a decision's input, for the decisions log. */
export const digestOf = (input: unknown) => hashId(typeof input === 'string' ? input : JSON.stringify(input));

export const estimateTokens = (s: string) => Math.ceil(s.length / CHARS_PER_TOKEN);

/** At most `chars` of `s`, keeping its end (`tail`) or its start, marked where cut. */
export function clip(s: string, chars: number, keep: 'head' | 'tail' = 'head'): string {
  if (s.length <= chars) return s;
  return keep === 'tail' ? `…${s.slice(s.length - chars + 1)}` : `${s.slice(0, chars - 1)}…`;
}

/** A message of the record as the pipeline reads it: its id, and its place in what the models read. */
export type Indexed = MemoryMessage & { id: string; index: number };

/** A message as the models read it: its index (for provenance), role, speaker (by name when known), trust and date. */
export const lineOf = (m: Indexed) =>
  `[${m.index}] ${m.role} ${m.authorName ? `"${m.authorName}"` : m.author}${m.trust === 'untrusted' ? ' (untrusted)' : ''} ${new Date(m.at).toISOString().slice(0, 16)}Z: ${m.content}`;

/**
 * Extraction chunks: about INGEST.chunkChars of message lines each, the next starting `overlap` messages before the
 * last one ended (at most half a chunk back), so what spans a border is read whole once. A single message longer than
 * a chunk is a chunk of its own.
 */
export function chunk<T extends { content: string }>(messages: T[], chars: number = INGEST.chunkChars, overlap: number = INGEST.overlapMessages): T[][] {
  const out: T[][] = [];
  let start = 0;
  while (start < messages.length) {
    let end = start;
    let size = 0;
    while (end < messages.length && (end === start || size + messages[end]!.content.length <= chars)) {
      size += messages[end]!.content.length;
      end++;
    }
    out.push(messages.slice(start, end));
    if (end >= messages.length) break;
    start = Math.max(end - overlap, start + Math.ceil((end - start) / 2));
  }
  return out;
}

/** Overlapping windows of `size` messages for the detail pass (half a window apart). */
export function windows<T>(messages: T[], size: number = INGEST.detailWindow): T[][] {
  if (messages.length <= size) return [messages];
  const step = Math.max(1, Math.floor(size / 2));
  const out: T[][] = [];
  for (let i = 0; i < messages.length; i += step) {
    out.push(messages.slice(i, i + size));
    if (i + size >= messages.length) break;
  }
  return out;
}

/** Text as quotes are compared: lowercase, typographic quotes and dashes plain, whitespace collapsed. */
export const normalizeQuote = (s: string) =>
  s
    .toLowerCase()
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();

/** The messages a quote appears in verbatim (normalized), or none: an invented quote matches nothing. */
export function quoteSources<T extends { content: string }>(quote: string, messages: T[]): T[] {
  const q = normalizeQuote(quote).replace(/^["']|["']$/g, '').replace(/^…|…$/g, '').trim();
  if (q.length < INGEST.minQuoteChars) return [];
  return messages.filter((m) => normalizeQuote(m.content).includes(q));
}

const STOP = new Set(
  'a an and are as at be but by can could did do does for from had has have he her his how i if in into is it its just me my no not of on or our she so that the their them then there these they this to too was we were what when where which who why will with would you your about after again all also am any been before being both each few more most other over own same some such than through under until up very off out only once here'.split(
    ' ',
  ),
);

/** The words of `s` worth searching: letters and digits, no stop words, at most `max`, in order of first use. */
export function keywords(s: string, max = 24): string[] {
  const seen = new Set<string>();
  for (const w of s.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'_-]*/gu) ?? []) {
    const t = w.replace(/'s$/, '').replace(/['_-]+/g, ' ').trim();
    for (const part of t.split(' ')) if (part.length > 1 && !STOP.has(part) && !seen.has(part)) seen.add(part);
    if (seen.size >= max) break;
  }
  return [...seen].slice(0, max);
}

/**
 * A Convex full-text search over `terms`: their words, each once, at most LIMITS.searchTerms (Convex's limit per search
 * expression), at most 32 characters each (longer terms are never indexed whole). Convex ranks documents by how many of
 * the terms they hold (BM25) and has no stemming: callers add the forms worth matching (the writer's synonyms in recall).
 * Null when there is nothing to search.
 */
export function searchText(terms: string[]): string | null {
  const words = [...new Set(terms.flatMap((t) => keywords(t, LIMITS.searchTerms)))].filter((w) => w.length <= 32).slice(0, LIMITS.searchTerms);
  return words.length ? words.join(' ') : null;
}

/** A topic as a key: lowercase dotted segments, or null when nothing of it is left. */
export function normalizeTopic(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const t = raw
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[\s/:]+/g, '.')
    .replace(/[^a-z0-9_.-]/g, '')
    .replace(/\.{2,}/g, '.')
    .replace(/^[._-]+|[._-]+$/g, '')
    .split('.')
    .filter(Boolean)
    .slice(0, 8)
    .map((s) => s.slice(0, 40))
    .join('.');
  return t && TOPIC_RE.test(t) && t.length <= 120 ? t : null;
}

/** Topics whose every segment (words split on _ and -) appears among the words of `text`: the cheap topic guess. */
export function topicsIn(text: string, topics: string[]): string[] {
  const words = new Set(keywords(text, 400));
  // A plural and its singular share a stem: invoices, invoice → invoic; policies, policy → policy.
  const stem = (w: string) => w.replace(/ies$/, 'y').replace(/(es|s)$/, '').replace(/e$/, '');
  const stems = new Set([...words].map(stem));
  return topics.filter((topic) => {
    // The first segment is the owner (person, company, app): the rest must be named.
    const segs = topic.split('.').slice(topic.includes('.') ? 1 : 0);
    return segs.length > 0 && segs.every((seg) => seg.split(/[_-]/).every((w) => w.length > 1 && (words.has(w) || stems.has(stem(w)))));
  });
}

/** `lines` joined into pieces of at most `room` characters, in order; a line longer than a piece is cut to one. */
export function piecesOf(lines: string[], room: number): string[] {
  const out: string[] = [];
  let cur = '';
  for (const raw of lines) {
    const line = raw.length > room ? raw.slice(0, room) : raw;
    if (cur && cur.length + 1 + line.length > room) {
      out.push(cur);
      cur = '';
    }
    cur = cur ? `${cur}\n${line}` : line;
  }
  if (cur) out.push(cur);
  return out;
}

/** Runs `fn` over `items` with at most `n` at once; answers in order. */
export async function pool<T, R>(items: T[], n: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!, i);
      }
    }),
  );
  return out;
}
