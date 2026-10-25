// Session state shared by every view: the document, the filter, the cursor and selection, undo,
// and the sync with the server. Views render this; they do not talk to the API themselves.
import { batch, computed, effect, signal } from '@preact/signals';
import { applyOp, type DecisionOp } from '../../src/core/decisions.ts';
import { facetCounts, facetValues, matchesFilter, NONE, type FacetCount, type FacetFilter } from '../../src/core/facets.ts';
import { compare } from '../../src/core/document.ts';
import { effectiveBucket, effectiveNote, isEmpty, type Decision, type FacetSpec, type Item, type TriageDocument } from '../../src/core/model.ts';
import { buildStacks, type StackIndex } from '../../src/core/stacks.ts';
import type { SessionMeta } from '../../src/node/server.ts';
import { api, type Summary } from './api.ts';
import { parseDayInput } from './dates.ts';

export const BUCKET_FACET = '\u0000bucket';

// ---- loaded once -------------------------------------------------------------------------
export const doc = signal<TriageDocument | null>(null);
export const meta = signal<SessionMeta | null>(null);
export const summary = signal<Summary | null>(null);
export const loadError = signal<string | null>(null);

// ---- mutable session state -------------------------------------------------------------------
export const decisions = signal<Record<string, Decision>>({});
export const order = signal<string[]>([]);
export const filter = signal<FacetFilter>({});
export const query = signal('');
export const groupBy = signal<string | null>(null);
/** The sort in force, shown in the header; null means the input (or manually arranged) order. */
export const sort = signal<{ field: string; desc: boolean } | null>(null);
export const hideTriaged = signal(false);
export const cursor = signal<string | null>(null);
export const selected = signal<ReadonlySet<string>>(new Set());
export const expanded = signal<ReadonlySet<string>>(new Set());
export const saveState = signal<'saved' | 'saving' | 'error'>('saved');
export const saveError = signal<string | null>(null);
export const finished = signal<Summary | null>(null);
export const helpOpen = signal(false);
/** The day most recently put on an item; an empty day input means this one again. */
export const lastDay = signal<string | null>(null);

const undoStack: DecisionOp[][] = [];
export const canUndo = signal(false);
let effort = { keys: 0, clicks: 0 };
export function countKey(): void {
  effort.keys++;
}
export function countClick(): void {
  effort.clicks++;
}

export async function load(): Promise<void> {
  try {
    const r = await api.document();
    batch(() => {
      doc.value = r.doc;
      meta.value = r.meta;
      summary.value = r.summary;
      decisions.value = r.doc.decisions;
      order.value = r.doc.order;
      if (r.doc.mapping.sort) sort.value = { field: r.doc.mapping.sort.field, desc: !!r.doc.mapping.sort.desc };
    });
  } catch (e) {
    loadError.value = (e as Error).message;
  }
}

/** The live document: static items and mapping plus the current decisions and order. */
export const live = computed<TriageDocument | null>(() => {
  const d = doc.value;
  return d ? { ...d, decisions: decisions.value, order: order.value } : null;
});

export const itemsById = computed(() => new Map((doc.value?.items ?? []).map((it) => [it.id, it])));
export const stacks = computed<StackIndex>(() => (doc.value ? buildStacks(doc.value.items, doc.value.mapping.stack) : { stacks: new Map(), byId: new Map() }));
export const buckets = computed(() => doc.value?.mapping.buckets ?? null);

export function bucketOf(item: Item): string | undefined {
  const l = live.value;
  return l ? effectiveBucket(l, item) : undefined;
}
export function noteOf(item: Item): string | undefined {
  const l = live.value;
  return l ? effectiveNote(l, item) : undefined;
}

/** The facet specs shown in the sidebar: the bucket facet first, then the mapping's. */
export const facetSpecs = computed<FacetSpec[]>(() => {
  const d = doc.value;
  if (!d) return [];
  const specs: FacetSpec[] = [];
  if (d.mapping.buckets) specs.push({ field: BUCKET_FACET, mode: 'values', label: d.mapping.buckets.field });
  return [...specs, ...d.mapping.facets];
});

function valuesFor(item: Item, spec: FacetSpec): string[] {
  if (spec.field === BUCKET_FACET) return [bucketOf(item) ?? NONE];
  return facetValues(item, spec);
}

function matches(item: Item, f: FacetFilter, q: string, hide: boolean): boolean {
  if (hide && bucketOf(item) !== undefined) return false;
  const bucketWanted = f[BUCKET_FACET];
  if (bucketWanted?.length && !bucketWanted.includes(bucketOf(item) ?? NONE)) return false;
  const d = doc.value!;
  if (!matchesFilter(item, d.mapping.facets, f)) return false;
  if (q) {
    const hay = `${item.title}\n${item.body ?? ''}\n${JSON.stringify(item.raw)}`.toLowerCase();
    if (!hay.includes(q)) return false;
  }
  return true;
}

/** Items passing the filter and the search, in display order. */
export const visibleItems = computed<Item[]>(() => {
  const d = doc.value;
  if (!d) return [];
  const f = filter.value;
  const q = query.value.trim().toLowerCase();
  const hide = hideTriaged.value;
  const byId = itemsById.value;
  const out: Item[] = [];
  for (const id of order.value) {
    const it = byId.get(id);
    if (it && matches(it, f, q, hide)) out.push(it);
  }
  return out;
});

/** Counts for one facet over the items matching every *other* facet, the usual faceted-search
 *  behaviour, so choosing a value never zeroes its siblings. */
export function countsFor(spec: FacetSpec): FacetCount[] {
  const d = doc.value;
  if (!d) return [];
  const f = { ...filter.value };
  delete f[spec.field];
  const q = query.value.trim().toLowerCase();
  const pool = d.items.filter((it) => matches(it, f, q, hideTriaged.value));
  if (spec.field !== BUCKET_FACET) return facetCounts(pool, spec);
  const counts = new Map<string, number>();
  const fixed = d.mapping.buckets!.values;
  for (const v of fixed) counts.set(v, 0);
  for (const it of pool) {
    const v = bucketOf(it) ?? NONE;
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  // The listed values in key order, then days and anything else in order, then (none).
  const extra = [...counts.keys()].filter((v) => v !== NONE && !fixed.includes(v)).sort();
  const none = counts.has(NONE) ? [NONE] : [];
  return [...fixed, ...extra, ...none].map((value) => ({ value, count: counts.get(value)! }));
}

// ---- rows: what the list actually shows ----------------------------------------------------
export type Row =
  | { kind: 'header'; key: string; label: string; count: number }
  | { kind: 'item'; key: string; item: Item; stackKey?: string; size?: number; member?: boolean; expanded?: boolean };

export const rows = computed<Row[]>(() => {
  const d = doc.value;
  if (!d) return [];
  const items = visibleItems.value;
  const { byId, stacks: sx } = stacks.value;
  const exp = expanded.value;
  const seen = new Set<string>();
  const visibleIds = new Set(items.map((i) => i.id));
  const itemRows = (list: Item[]): Row[] => {
    const out: Row[] = [];
    for (const it of list) {
      const key = byId.get(it.id);
      if (!key) {
        out.push({ kind: 'item', key: it.id, item: it });
        continue;
      }
      if (seen.has(key)) continue;
      seen.add(key);
      const members = sx.get(key)!.ids.filter((id) => visibleIds.has(id));
      const isOpen = exp.has(key);
      out.push({ kind: 'item', key: it.id, item: it, stackKey: key, size: members.length, expanded: isOpen });
      if (isOpen) {
        for (const id of members) if (id !== it.id) out.push({ kind: 'item', key: id, item: itemsById.value.get(id)!, stackKey: key, member: true });
      }
    }
    return out;
  };
  const g = groupBy.value;
  const spec = g ? facetSpecs.value.find((s) => s.field === g) : undefined;
  if (!spec) return itemRows(items);
  const groups = new Map<string, Item[]>();
  for (const it of items) {
    const v = valuesFor(it, spec)[0]!;
    const list = groups.get(v);
    if (list) list.push(it);
    else groups.set(v, [it]);
  }
  const ordered = [...groups.entries()].sort((a, b) => (a[0] === NONE ? 1 : b[0] === NONE ? -1 : b[1].length - a[1].length || a[0].localeCompare(b[0])));
  const out: Row[] = [];
  for (const [label, list] of ordered) {
    out.push({ kind: 'header', key: `h:${label}`, label, count: list.length });
    out.push(...itemRows(list));
  }
  return out;
});

export const itemRowIndex = computed(() => {
  const idx = new Map<string, number>();
  rows.value.forEach((r, i) => {
    if (r.kind === 'item') idx.set(r.key, i);
  });
  return idx;
});

/** The row under the cursor, if it is still visible. */
export const cursorRow = computed<Extract<Row, { kind: 'item' }> | null>(() => {
  const c = cursor.value;
  if (c === null) return null;
  const i = itemRowIndex.value.get(c);
  return i === undefined ? null : (rows.value[i] as Extract<Row, { kind: 'item' }>);
});

/** Which items a decision made at the cursor applies to: the selection if any, else the stack
 *  under the cursor (every member) or the single member/item. */
export function targetIds(): string[] {
  if (selected.value.size) return [...selected.value];
  const r = cursorRow.value;
  if (!r) return [];
  if (r.stackKey && !r.member) return stacks.value.stacks.get(r.stackKey)!.ids;
  return [r.item.id];
}

// ---- actions -------------------------------------------------------------------------------
function inverse(ops: DecisionOp[]): DecisionOp[] {
  const l = live.value!;
  const inv: DecisionOp[] = [];
  for (const op of ops) {
    if (op.op === 'order') inv.push({ op: 'order', order: [...l.order] });
    else {
      // Group ids by their current decision value so undo can restore each exactly.
      const groups = new Map<string | null, string[]>();
      for (const id of op.ids) {
        const d = l.decisions[id];
        const cur = op.op === 'bucket' ? (d?.bucket ?? null) : (d?.note ?? null);
        const g = groups.get(cur);
        if (g) g.push(id);
        else groups.set(cur, [id]);
      }
      for (const [val, ids] of groups) inv.push(op.op === 'bucket' ? { op: 'bucket', ids, bucket: val } : { op: 'note', ids, note: val });
    }
  }
  return inv;
}

let queue: Promise<void> = Promise.resolve();

export function apply(ops: DecisionOp[], opts: { undo?: boolean } = {}): void {
  const l = live.value;
  if (!l || finished.value) return;
  if (!opts.undo) {
    undoStack.push(inverse(ops));
    if (undoStack.length > 200) undoStack.shift();
    canUndo.value = true;
  }
  const next: TriageDocument = { ...l, decisions: { ...l.decisions }, order: [...l.order] };
  for (const id of Object.keys(next.decisions)) next.decisions[id] = { ...next.decisions[id] };
  for (const op of ops) applyOp(next, op);
  batch(() => {
    decisions.value = next.decisions;
    order.value = next.order;
    saveState.value = 'saving';
  });
  const spent = { ...effort, undo: !!opts.undo };
  effort = { keys: 0, clicks: 0 };
  queue = queue
    .then(() => api.ops(ops, spent))
    .then((r) => {
      batch(() => {
        summary.value = r.summary;
        saveState.value = 'saved';
        saveError.value = null;
      });
    })
    .catch((e: Error) => {
      batch(() => {
        saveState.value = 'error';
        saveError.value = e.message;
      });
    });
}

export function undo(): void {
  const ops = undoStack.pop();
  canUndo.value = undoStack.length > 0;
  if (ops) apply(ops, { undo: true });
}

export function assign(bucket: string | null, ids = targetIds()): void {
  if (!ids.length || !buckets.value) return;
  apply([{ op: 'bucket', ids, bucket }]);
  if (selected.value.size) selected.value = new Set();
}

/** Put the targets on the day `text` names (see parseDayInput); empty text means the last day
 *  used. False if the text is not a day, so the input can say so. */
export function assignDay(text: string, ids = targetIds()): boolean {
  const day = text.trim() ? parseDayInput(text) : lastDay.value;
  if (!day) return false;
  lastDay.value = day;
  assign(day, ids);
  return true;
}

export function setNote(id: string, note: string): void {
  const item = itemsById.value.get(id);
  const current = item ? (noteOf(item) ?? '') : '';
  if (note.trim() === current.trim()) return;
  apply([{ op: 'note', ids: [id], note: note.trim() ? note : null }]);
}

/** Move the cursor row (with its stack) up or down one visible row. */
export function moveCursorRow(delta: 1 | -1): void {
  const r = cursorRow.value;
  if (!r || r.member) return;
  sort.value = null;
  const list = rows.value.filter((x): x is Extract<Row, { kind: 'item' }> => x.kind === 'item' && !x.member);
  const i = list.findIndex((x) => x.key === r.key);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= list.length) return;
  const other = list[j]!;
  const o = [...order.value];
  const a = o.indexOf(r.item.id);
  const b = o.indexOf(other.item.id);
  if (a < 0 || b < 0) return;
  o.splice(a, 1);
  o.splice(b, 0, r.item.id);
  apply([{ op: 'order', order: o }]);
}

/** Re-sort the whole order by a raw field (view and output alike); null restores input order. */
export function setSort(field: string | null, desc = false): void {
  const byId = itemsById.value;
  if (field === null) {
    sort.value = null;
    apply([{ op: 'order', order: doc.value!.items.map((it) => it.id) }]);
    cursor.value = null;
    return;
  }
  sort.value = { field, desc };
  const o = [...order.value].sort((a, b) => compare(byId.get(a)!.raw[field], byId.get(b)!.raw[field], desc));
  apply([{ op: 'order', order: o }]);
  // Start from the top of the new order rather than following the old cursor row down the list.
  cursor.value = null;
}

/** g: no grouping, then each facet in sidebar order, then none again. */
export function cycleGroupBy(): void {
  const specs = facetSpecs.value;
  const i = specs.findIndex((s) => s.field === groupBy.value);
  groupBy.value = i + 1 < specs.length ? specs[i + 1]!.field : null;
}

export function moveCursor(delta: number): void {
  const rs = rows.value;
  const idx = itemRowIndex.value;
  const itemRows = rs.map((r, i) => (r.kind === 'item' ? i : -1)).filter((i) => i >= 0);
  if (!itemRows.length) return;
  const cur = cursor.value !== null ? idx.get(cursor.value) : undefined;
  let pos = cur === undefined ? (delta > 0 ? -1 : itemRows.length) : itemRows.indexOf(cur);
  pos = Math.max(0, Math.min(itemRows.length - 1, pos + delta));
  cursor.value = (rs[itemRows[pos]!] as Extract<Row, { kind: 'item' }>).key;
}

export function toggleExpand(key?: string): void {
  const k = key ?? cursorRow.value?.stackKey;
  if (!k) return;
  const next = new Set(expanded.value);
  if (next.has(k)) next.delete(k);
  else next.add(k);
  expanded.value = next;
}

export function toggleSelect(id?: string): void {
  const r = cursorRow.value;
  const ids = id ? [id] : r ? (r.stackKey && !r.member ? stacks.value.stacks.get(r.stackKey)!.ids : [r.item.id]) : [];
  if (!ids.length) return;
  const next = new Set(selected.value);
  const all = ids.every((x) => next.has(x));
  for (const x of ids) if (all) next.delete(x);
  else next.add(x);
  selected.value = next;
}

export function toggleFacet(field: string, value: string): void {
  const f = { ...filter.value };
  const cur = f[field] ?? [];
  f[field] = cur.includes(value) ? cur.filter((v) => v !== value) : [...cur, value];
  if (!f[field].length) delete f[field];
  filter.value = f;
}

export function clearFilters(): void {
  batch(() => {
    filter.value = {};
    query.value = '';
    hideTriaged.value = false;
  });
}

export async function done(): Promise<void> {
  await queue;
  try {
    const r = await api.done();
    finished.value = r.summary;
  } catch (e) {
    saveState.value = 'error';
    saveError.value = (e as Error).message;
  }
}

/** Keep the cursor on a visible row when the filter changes under it. */
effect(() => {
  const rs = rows.value;
  const c = cursor.value;
  if (c !== null && itemRowIndex.value.has(c)) return;
  const first = rs.find((r) => r.kind === 'item');
  cursor.value = first ? first.key : null;
});

export function isTriaged(item: Item): boolean {
  return !isEmpty(bucketOf(item));
}
