// Small presentation helpers shared by views.
import { asString, isRecord, isScalar } from '../../src/core/model.ts';

const HTML_TAG = /<\/?[a-z][^>]*>/i;

export function looksLikeHtml(s: string): boolean {
  return HTML_TAG.test(s);
}

export function parseDate(s: string): Date | null {
  const t = Date.parse(s.length === 10 ? `${s}T00:00:00` : s);
  return Number.isNaN(t) ? null : new Date(t);
}

/** "2026-10-24" plus a relative age: "3 days ago", "in 2 weeks". */
export function formatDate(s: string, now = new Date()): { abs: string; rel: string } {
  const d = parseDate(s);
  if (!d) return { abs: s, rel: '' };
  const abs = d.toISOString().slice(0, 10);
  const days = Math.round((d.getTime() - now.getTime()) / 86400000);
  const ad = Math.abs(days);
  let span: string;
  if (ad === 0) span = 'today';
  else if (ad === 1) span = days < 0 ? 'yesterday' : 'tomorrow';
  else {
    const unit = ad < 14 ? ['day', ad] : ad < 60 ? ['week', Math.round(ad / 7)] : ad < 730 ? ['month', Math.round(ad / 30)] : ['year', Math.round(ad / 365)];
    const n = unit[1] as number;
    span = `${n} ${unit[0]}${n === 1 ? '' : 's'}`;
    span = days < 0 ? `${span} ago` : `in ${span}`;
  }
  return { abs, rel: span };
}

/** The best one-line label for an arbitrary child value (a subtask, a comment, ...). */
export function childLabel(v: unknown): string {
  if (isScalar(v)) return asString(v);
  if (isRecord(v)) {
    for (const k of ['title', 'text', 'name', 'summary', 'subject', 'body', 'content', 'label']) {
      const x = v[k];
      if (typeof x === 'string' && x.trim()) return x;
    }
    const firstString = Object.values(v).find((x) => typeof x === 'string' && x.trim());
    if (typeof firstString === 'string') return firstString;
  }
  return JSON.stringify(v);
}

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** Minutes as "2 hr", "45 min"; anything else untouched. Sunsama's timeEstimate is minutes. */
export function formatMinutes(v: unknown): string {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : NaN;
  if (Number.isNaN(n)) return asString(v);
  if (n >= 60 && n % 30 === 0) return `${n / 60} hr`;
  return `${n} min`;
}
