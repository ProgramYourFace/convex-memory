// Time phrases ("yesterday", "last Tuesday", "3 weeks ago", "March 5") resolved to absolute dates against the time the
// message was said: regular expressions and calendar arithmetic, never a model. Days are the speaker's calendar days
// in the message's time zone (`tz`, an IANA name the caller knows from the member's device or settings); a message
// without one, or with a zone this runtime does not know, is read in UTC, and a day either side is then the error bound.

const DAY = 86_400_000;
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const NUMBERS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, couple: 2, few: 3 };

export type Resolved = {
  /** The day (UTC midnight, ms) the phrase names, or the first day of the span it names. */
  from: number;
  /** The span's last day (UTC midnight) when the phrase names a week, month or year; else equal to `from`. */
  to: number;
  /** `YYYY-MM-DD`, or `YYYY-MM-DD..YYYY-MM-DD` for a span. */
  label: string;
};

const dayOf = (ms: number) => Math.floor(ms / DAY) * DAY;
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const utc = (y: number, m: number, d: number) => Date.UTC(y, m, d);
const span = (from: number, to: number): Resolved => ({ from, to, label: from === to ? iso(from) : `${iso(from)}..${iso(to)}` });
const one = (ms: number) => span(dayOf(ms), dayOf(ms));
const monthIndex = (w: string) => MONTHS.findIndex((m) => m === w || (w.length >= 3 && m.startsWith(w.replace(/\.$/, ''))));
const amount = (w: string) => (/^\d+$/.test(w) ? Number(w) : (NUMBERS[w] ?? NaN));

/** Monday-based week start of `ms`'s day. */
function weekStart(ms: number): number {
  const d = dayOf(ms);
  const wd = new Date(d).getUTCDay();
  return d - ((wd + 6) % 7) * DAY;
}

function shiftMonths(ms: number, n: number): number {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + n;
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return utc(y, m, Math.min(d.getUTCDate(), last));
}

/** The calendar day `at` falls on in `tz` (UTC without one), as that day's UTC midnight: what the arithmetic below counts from. */
export function localDay(at: number, tz?: string | null): number {
  if (tz) {
    try {
      const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(at));
      const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
      const d = utc(get('year'), get('month') - 1, get('day'));
      if (Number.isFinite(d)) return d;
    } catch {
      // An unknown zone: UTC.
    }
  }
  return dayOf(at);
}

/**
 * The date a time phrase names, said at `at` (ms) in time zone `tz` (UTC without one). `lean`: which way a bare weekday or month goes (`past` for what
 * happened, `future` for what is planned). Null for anything it does not know: the caller keeps the message's own time.
 */
export function resolveTimePhrase(phrase: string, at: number, lean: 'past' | 'future' = 'past', tz?: string | null): Resolved | null {
  const p = phrase
    .toLowerCase()
    .replace(/[,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const today = localDay(at, tz);
  if (!p) return null;

  // ISO dates.
  let m = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(p);
  if (m) {
    const t = utc(+m[1]!, +m[2]! - 1, +m[3]!);
    return Number.isFinite(t) && new Date(t).getUTCDate() === +m[3]! ? one(t) : null;
  }

  // "3 days ago", "a couple of weeks ago", "in two months", "2 years from now".
  m = /\b(\d+|an?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|couple|few)(?: of)? (day|week|month|year)s? (ago|before|earlier|from now|later)\b/.exec(p) ?? null;
  const inM = /\bin (\d+|an?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|couple|few)(?: of)? (day|week|month|year)s?\b/.exec(p);
  if (m || inM) {
    const n = amount((m ?? inM)![1]!);
    const unit = (m ?? inM)![2]!;
    if (!Number.isFinite(n)) return null;
    const sign = m && /ago|before|earlier/.test(m[3]!) ? -1 : 1;
    if (unit === 'day') return one(today + sign * n * DAY);
    if (unit === 'week') return one(today + sign * n * 7 * DAY);
    if (unit === 'month') return one(shiftMonths(today, sign * n));
    return one(shiftMonths(today, sign * n * 12));
  }

  if (/\b(today|tonight|this (morning|afternoon|evening)|earlier today|right now|now)\b/.test(p)) return one(today);
  if (/\bday before yesterday\b/.test(p)) return one(today - 2 * DAY);
  if (/\bday after tomorrow\b/.test(p)) return one(today + 2 * DAY);
  if (/\b(yesterday|last night)\b/.test(p)) return one(today - DAY);
  if (/\btomorrow\b/.test(p)) return one(today + DAY);

  // "last week", "next month", "this year".
  m = /\b(last|past|previous|next|this|coming) (week|month|year)\b/.exec(p);
  if (m) {
    const dir = m[1] === 'this' ? 0 : /last|past|previous/.test(m[1]!) ? -1 : 1;
    const d = new Date(today);
    if (m[2] === 'week') {
      const s = weekStart(today) + dir * 7 * DAY;
      return span(s, s + 6 * DAY);
    }
    if (m[2] === 'month') {
      const s = utc(d.getUTCFullYear(), d.getUTCMonth() + dir, 1);
      const e = new Date(s);
      return span(s, utc(e.getUTCFullYear(), e.getUTCMonth() + 1, 0));
    }
    const y = d.getUTCFullYear() + dir;
    return span(utc(y, 0, 1), utc(y, 11, 31));
  }

  // "last Tuesday", "next friday", "this monday", "on Saturday", "Sunday".
  m = /\b(?:(last|past|previous|next|this|coming|on) )?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)s?\b/.exec(p);
  if (m) {
    const target = WEEKDAYS.indexOf(m[2]!);
    const wd = new Date(today).getUTCDay();
    const q = m[1];
    if (q && /last|past|previous/.test(q)) {
      // The most recent one before today.
      const back = (wd - target + 7) % 7 || 7;
      return one(today - back * DAY);
    }
    if (q && /next|coming/.test(q)) {
      const fwd = (target - wd + 7) % 7 || 7;
      return one(today + fwd * DAY);
    }
    if (q === 'this') return one(weekStart(today) + ((target + 6) % 7) * DAY);
    if (lean === 'future') return one(today + ((target - wd + 7) % 7) * DAY);
    return one(today - ((wd - target + 7) % 7) * DAY);
  }

  // "March 5", "March 5th 2026", "5 March", "5th of March, 2025".
  const md = /\b([a-z]{3,9}\.?) (\d{1,2})(?:st|nd|rd|th)?(?: (\d{4}))?\b/.exec(p);
  const dm = /\b(\d{1,2})(?:st|nd|rd|th)?(?: of)? ([a-z]{3,9}\.?)(?: (\d{4}))?\b/.exec(p);
  for (const [mon, day, year] of [md ? [md[1]!, md[2]!, md[3]] : null, dm ? [dm[2]!, dm[1]!, dm[3]] : null].filter(Boolean) as [string, string, string | undefined][]) {
    const mi = monthIndex(mon);
    const d = Number(day);
    if (mi < 0 || d < 1 || d > 31) continue;
    const y0 = new Date(today).getUTCFullYear();
    const pick = (y: number) => utc(y, mi, d);
    let t = year ? pick(Number(year)) : pick(y0);
    if (new Date(t).getUTCDate() !== d) continue;
    // A date without a year: the nearest one in the direction the statement leans.
    if (!year && lean === 'past' && t > today) t = pick(y0 - 1);
    if (!year && lean === 'future' && t < today) t = pick(y0 + 1);
    return one(t);
  }

  // "in March", "last March", "March 2025".
  m = /\b(?:(last|next|this|in) )?(january|february|march|april|may|june|july|august|september|october|november|december)(?: (\d{4}))?\b/.exec(p);
  if (m && !(m[2] === 'may' && !m[1] && !m[3])) {
    const mi = MONTHS.indexOf(m[2]!);
    const y0 = new Date(today).getUTCFullYear();
    const thisMonth = new Date(today).getUTCMonth();
    let y = m[3] ? Number(m[3]) : y0;
    if (!m[3]) {
      if (m[1] === 'last' || (m[1] !== 'next' && m[1] !== 'this' && lean === 'past')) y = mi > thisMonth || (m[1] === 'last' && mi === thisMonth) ? y0 - 1 : y0;
      if (m[1] === 'next' || (m[1] !== 'last' && m[1] !== 'this' && lean === 'future')) y = mi < thisMonth || (m[1] === 'next' && mi === thisMonth) ? y0 + 1 : y0;
    }
    return span(utc(y, mi, 1), utc(y, mi + 1, 0));
  }

  // "in 2024", "back in 2019".
  m = /\b(?:in|during|since|back in) (\d{4})\b/.exec(p);
  if (m) return span(utc(+m[1]!, 0, 1), utc(+m[1]!, 11, 31));
  return null;
}

/**
 * `content` with each resolved phrase followed by its date ("yesterday (2026-10-20)"), and the earliest date named:
 * what an event's `validFrom` becomes.
 */
export function anchorDates(content: string, phrases: string[], at: number, lean: 'past' | 'future' = 'past', tz?: string | null): { content: string; from: number | null } {
  let out = content;
  let from: number | null = null;
  for (const phrase of [...new Set(phrases.map((x) => x.trim()).filter(Boolean))].slice(0, 6)) {
    const r = resolveTimePhrase(phrase, at, lean, tz);
    if (!r) continue;
    from = from === null ? r.from : Math.min(from, r.from);
    const i = out.toLowerCase().indexOf(phrase.toLowerCase());
    if (i >= 0 && !out.slice(i + phrase.length).startsWith(` (${r.label})`)) out = `${out.slice(0, i + phrase.length)} (${r.label})${out.slice(i + phrase.length)}`;
  }
  return { content: out, from };
}
