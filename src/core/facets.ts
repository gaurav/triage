// Facet values and counts. Arrays of scalars are multi-valued; "", null, missing and [] all
// read as NONE; dates/urls use `present` mode and yield PRESENT or ABSENT.
import { asString, isEmpty, isScalar, type FacetSpec, type Item } from './model.ts';

export const NONE = '(none)';
export const PRESENT = 'present';
export const ABSENT = 'absent';

export function facetValues(item: Item, spec: FacetSpec): string[] {
  const v = item.raw[spec.field];
  if (spec.mode === 'present') return [isEmpty(v) ? ABSENT : PRESENT];
  if (isEmpty(v)) return [NONE];
  if (Array.isArray(v)) {
    const vals = v.filter((x) => !isEmpty(x)).map((x) => (isScalar(x) ? asString(x) : JSON.stringify(x)));
    return vals.length ? [...new Set(vals)] : [NONE];
  }
  return [isScalar(v) ? asString(v) : JSON.stringify(v)];
}

export interface FacetCount {
  value: string;
  count: number;
}

/** Counts of each value among `items`, most frequent first, NONE/ABSENT last. */
export function facetCounts(items: Iterable<Item>, spec: FacetSpec): FacetCount[] {
  const counts = new Map<string, number>();
  for (const it of items) {
    for (const v of facetValues(it, spec)) counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  const tail = (v: string) => v === NONE || v === ABSENT;
  return [...counts]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => Number(tail(a.value)) - Number(tail(b.value)) || b.count - a.count || a.value.localeCompare(b.value));
}

/** Active filter: facet field -> selected values. OR within a facet, AND across facets. */
export type FacetFilter = Record<string, string[]>;

export function matchesFilter(item: Item, specs: FacetSpec[], filter: FacetFilter): boolean {
  for (const spec of specs) {
    const wanted = filter[spec.field];
    if (!wanted || wanted.length === 0) continue;
    const have = facetValues(item, spec);
    if (!have.some((v) => wanted.includes(v))) return false;
  }
  return true;
}
