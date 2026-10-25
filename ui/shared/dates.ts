// Days as people type them. A date bucket holds a bare day, "2026-10-27"; this turns what was
// typed into one. Everything is in local time: a day is a day where the person sits.

export const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/** A Date's calendar day, from local components (toISOString would give the UTC day). */
export function toDay(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function plusDays(d: Date, n: number): Date {
  const out = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  out.setDate(out.getDate() + n);
  return out;
}

/**
 * The day meant by `text`, or null if it cannot be read:
 * - `2026-10-27`, a day as written (and a real one: `2026-02-30` is null)
 * - `today`, `tomorrow`
 * - `+3` or `3`: that many days from today
 * - `mon`, `tuesday`, …: the next such day after today; `next mon`: the one after that
 */
export function parseDayInput(text: string, now = new Date()): string | null {
  const s = text.trim().toLowerCase();
  if (!s) return null;
  const today = plusDays(now, 0);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const [y, m, d] = s.split('-').map(Number) as [number, number, number];
    const date = new Date(y, m - 1, d);
    return toDay(date) === s ? s : null;
  }
  if (s === 'today') return toDay(today);
  if (s === 'tomorrow' || s === 'tom') return toDay(plusDays(today, 1));
  const rel = /^\+?(\d{1,4})$/.exec(s);
  if (rel) return toDay(plusDays(today, Number(rel[1])));
  const wd = /^(next\s+)?([a-z]{2,9})$/.exec(s);
  if (wd) {
    const want = DAY_NAMES.findIndex((n) => n.startsWith(wd[2]!));
    if (want < 0) return null;
    let ahead = (want - today.getDay() + 7) % 7;
    if (ahead === 0) ahead = 7;
    if (wd[1]) ahead += 7;
    return toDay(plusDays(today, ahead));
  }
  return null;
}
