// Builds the TriageDocument from raw records, resolved ids and a mapping; applies initial sort.
import { asString, isEmpty, toItems, type Raw, type ResolvedMapping, type TriageDocument } from './model.ts';

export function buildDocument(raws: Raw[], ids: string[], mapping: ResolvedMapping): TriageDocument {
  const items = toItems(raws, ids, mapping);
  let order = items.map((it) => it.id);
  if (mapping.sort) {
    const { field, desc } = mapping.sort;
    const byId = new Map(items.map((it) => [it.id, it]));
    order = [...order].sort((a, b) => compare(byId.get(a)!.raw[field], byId.get(b)!.raw[field], !!desc));
  }
  return { chaff: 1, mapping, items, order, decisions: {} };
}

/** Empty values sort last whichever direction is asked for; numbers numerically; else as
 *  strings. `desc` is applied here rather than by negating the result, which would put the
 *  blanks first. */
export function compare(a: unknown, b: unknown, desc = false): number {
  const ea = isEmpty(a);
  const eb = isEmpty(b);
  if (ea || eb) return Number(ea) - Number(eb);
  const c = typeof a === 'number' && typeof b === 'number' ? a - b : asString(a).localeCompare(asString(b), undefined, { numeric: true, sensitivity: 'base' });
  return desc ? -c : c;
}
