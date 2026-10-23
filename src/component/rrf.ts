import { RECALL } from './config.js';

// Weighted reciprocal rank fusion: each channel ranks what it found (best first); an item's score is the sum over the
// channels that found it of weight / (k + rank). Ties go to the more recent.

export type Ranked<T> = { channel: string; items: T[] };

export function fuse<T>(lists: Ranked<T>[], keyOf: (t: T) => string, atOf: (t: T) => number, weights: Readonly<Record<string, number>>, k: number = RECALL.rrfK): { item: T; score: number }[] {
  const acc = new Map<string, { item: T; score: number }>();
  for (const { channel, items } of lists) {
    const w = weights[channel] ?? 0;
    if (w <= 0) continue;
    const seen = new Set<string>();
    items.forEach((item) => {
      const key = keyOf(item);
      if (seen.has(key)) return;
      seen.add(key);
      const rank = seen.size;
      const cur = acc.get(key);
      if (cur) cur.score += w / (k + rank);
      else acc.set(key, { item, score: w / (k + rank) });
    });
  }
  return [...acc.values()].sort((a, b) => b.score - a.score || atOf(b.item) - atOf(a.item));
}

/** Lists of several scopes as one ranking: rank by rank, in scope order (scores of different searches don't compare). */
export function interleave<T>(lists: T[][]): T[] {
  const out: T[] = [];
  for (let i = 0; lists.some((l) => i < l.length); i++) for (const l of lists) if (i < l.length) out.push(l[i]!);
  return out;
}
