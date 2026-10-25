// The canonical model every view consumes, and the mapping that produces it from raw JSON.
// Nothing in src/core/ may import from node:; it is bundled into the browser as well.

export type Scalar = string | number | boolean | null;
export type Raw = Record<string, unknown>;

/** How the input file was shaped, so the output can be written the same way. */
export type Shape = 'array' | 'dict' | 'ndjson' | 'canonical';

export type DateSlot = 'created' | 'updated' | 'start' | 'due' | 'completed';
export const DATE_SLOTS: readonly DateSlot[] = ['created', 'updated', 'start', 'due', 'completed'];

export interface FacetSpec {
  field: string;
  /** `values`: one facet value per distinct scalar (arrays contribute each element);
   *  `present`: two values, present/absent, for high-cardinality fields such as dates and urls. */
  mode: 'values' | 'present';
  label?: string;
}

export interface BucketSpec {
  /** Field written into each item. */
  field: string;
  /** Allowed values, in key order: the first gets key 1, and so on up to 9. */
  values: string[];
  /** The field also takes any day (`2026-10-27`), chosen with the `d` key. A day is a bucket
   *  value like the others, so an item is in a named bucket or on a day, never both. */
  date?: boolean;
}

/** A bare calendar day, the only form a date bucket takes. */
export function isDay(v: unknown): v is string {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
}

/**
 * The sidecar (`<input>.chaff-map.json`). CLI flags are shorthand for the same thing, and the
 * heuristics in infer.ts propose one. Every field is optional; `resolveMapping` fills the rest.
 */
export interface Mapping {
  chaff: 1;
  /** Field holding the id, or `"index"` for the array position (dict inputs always use the key). */
  id?: string;
  title?: string;
  body?: string;
  dates?: Partial<Record<DateSlot, string>>;
  priority?: string;
  tags?: string;
  url?: string;
  parent?: string;
  children?: string;
  /** Fields shown prominently in the detail pane, in this order. Others follow, collapsed. */
  detail?: string[];
  /** Facet fields shown as small chips on a list row (default: the first three value facets
   *  other than the priority field). A Sunsama export's channel and context usually agree, so
   *  a sidecar can say `"chips": ["channel"]`. */
  chips?: string[];
  facets?: (string | FacetSpec)[];
  /** Field whose normalised value stacks duplicates; `false` disables stacking. */
  stack?: string | false;
  sort?: { field: string; desc?: boolean };
  buckets?: BucketSpec;
  /** Field to receive each item's final position (0-based). */
  order?: string;
  /** Field to receive a free-text note. */
  note?: string;
}

/** A mapping with every slot the UI depends on filled in. */
export interface ResolvedMapping extends Mapping {
  id: string;
  title: string;
  dates: Partial<Record<DateSlot, string>>;
  detail: string[];
  facets: FacetSpec[];
  stack: string | false;
}

export interface Item {
  id: string;
  title: string;
  body?: string;
  dates: Partial<Record<DateSlot, string>>;
  priority?: string;
  tags: string[];
  url?: string;
  parent?: string;
  children: unknown[];
  raw: Raw;
}

/** What the user has decided about one item. Absent keys mean "no decision"; the input's own
 *  value of the bucket/note field then stands, which is how clearing restores the original. */
export interface Decision {
  bucket?: string;
  note?: string;
}

export interface TriageDocument {
  chaff: 1;
  mapping: ResolvedMapping;
  items: Item[];
  /** Ids in display order; manual reordering edits this. */
  order: string[];
  decisions: Record<string, Decision>;
}

export function isRecord(v: unknown): v is Raw {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function isScalar(v: unknown): v is Scalar {
  return v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
}

/** Empty means: missing, null, "", or an empty array. Sunsama exports use "" for every blank. */
export function isEmpty(v: unknown): boolean {
  return v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
}

export function asString(v: unknown): string {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') return v;
  if (isScalar(v)) return String(v);
  return JSON.stringify(v);
}

export function normaliseFacet(spec: string | FacetSpec): FacetSpec {
  return typeof spec === 'string' ? { field: spec, mode: 'values' } : spec;
}

/** Build the canonical items from raw records and a resolved mapping. `ids` come from
 *  resolveIds, because dict inputs take them from keys rather than a field. */
export function toItems(raws: Raw[], ids: string[], m: ResolvedMapping): Item[] {
  return raws.map((raw, i) => {
    const dates: Partial<Record<DateSlot, string>> = {};
    for (const slot of DATE_SLOTS) {
      const f = m.dates[slot];
      if (f && !isEmpty(raw[f])) dates[slot] = asString(raw[f]);
    }
    const item: Item = {
      id: ids[i]!,
      title: isEmpty(raw[m.title]) ? '' : asString(raw[m.title]),
      dates,
      tags: m.tags ? toStringArray(raw[m.tags]) : [],
      children: m.children && Array.isArray(raw[m.children]) ? (raw[m.children] as unknown[]) : [],
      raw,
    };
    if (m.body && !isEmpty(raw[m.body])) item.body = asString(raw[m.body]);
    if (m.priority && !isEmpty(raw[m.priority]) && !NO_PRIORITY.test(asString(raw[m.priority]))) item.priority = asString(raw[m.priority]);
    if (m.url && typeof raw[m.url] === 'string' && raw[m.url]) item.url = raw[m.url] as string;
    if (m.parent && !isEmpty(raw[m.parent])) item.parent = asString(raw[m.parent]);
    return item;
  });
}

/** Priority values that mean "none"; they would otherwise badge every row. */
const NO_PRIORITY = /^\s*(no(ne|t set|rmal)?|no priority|default|unset|-|p?[0-9]?\s*none)\s*$/i;

function toStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x) => !isEmpty(x)).map(asString);
  if (isEmpty(v)) return [];
  return [asString(v)];
}

/** The bucket in force for an item: the decision if there is one, else the input's own value. */
export function effectiveBucket(doc: TriageDocument, item: Item): string | undefined {
  const b = doc.mapping.buckets;
  if (!b) return undefined;
  const d = doc.decisions[item.id];
  if (d && d.bucket !== undefined) return d.bucket;
  const orig = item.raw[b.field];
  return isEmpty(orig) ? undefined : asString(orig);
}

export function effectiveNote(doc: TriageDocument, item: Item): string | undefined {
  const f = doc.mapping.note;
  if (!f) return undefined;
  const d = doc.decisions[item.id];
  if (d && d.note !== undefined) return d.note;
  const orig = item.raw[f];
  return isEmpty(orig) ? undefined : asString(orig);
}
