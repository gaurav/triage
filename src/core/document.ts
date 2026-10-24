// Builds the TriageDocument from raw records, resolved ids and a mapping; applies initial sort.
import { asString, isEmpty, toItems, type Raw, type ResolvedMapping, type TriageDocument } from './model.ts';

export function buildDocument(raws: Raw[], ids: string[], mapping: ResolvedMapping): TriageDocument {
  const items = toItems(raws, ids, mapping);
  let order = items.map((it) => it.id);
  if (mapping.sort) {
    const { field, desc } = mapping.sort;
    const byId = new Map(items.map((it) => [it.id, it]));
    order = [...order].sort((a, b) => {
      const va = byId.get(a)!.raw[field];
      const vb = byId.get(b)!.raw[field];
      const c = compare(va, vb);
      return desc ? -c : c;
    });
  }
  return { chaff: 1, mapping, items, order, decisions: {} };
}

/** Empty values sort last in either direction; numbers numerically; else as strings. */
export function compare(a: unknown, b: unknown): number {
  const ea = isEmpty(a);
  const eb = isEmpty(b);
  if (ea || eb) return Number(ea) - Number(eb);
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return asString(a).localeCompare(asString(b), undefined, { numeric: true, sensitivity: 'base' });
}
