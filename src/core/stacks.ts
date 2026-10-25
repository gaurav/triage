// Exact-match stacking of duplicates on a normalised field. The one heuristic chaff ships with:
// 860 of the 1,858 tasks in the Sunsama sample share a title with another task, and no model is
// needed to see that. Anything fuzzier belongs upstream, as a `cluster` field in the input.
import type { Item } from './model.ts';

/** casefold, trim, collapse whitespace, strip trailing punctuation. A blank result never stacks. */
export function normaliseKey(s: string): string {
  return s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[\s.,;:!?…\-–—]+$/u, '')
    .trim();
}

export interface Stack {
  key: string;
  /** Ids in input order; the first is the head shown in the list. */
  ids: string[];
}

export type StackIndex = {
  /** stack key -> stack, only for groups of two or more */
  stacks: Map<string, Stack>;
  /** item id -> stack key, only for stacked items */
  byId: Map<string, string>;
};

export function stackValue(item: Item, field: string | false): string {
  if (field === false) return '';
  const v = item.raw[field];
  return typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v);
}

export function buildStacks(items: Item[], field: string | false): StackIndex {
  const stacks = new Map<string, Stack>();
  const byId = new Map<string, string>();
  if (field === false) return { stacks, byId };
  const groups = new Map<string, string[]>();
  for (const it of items) {
    const key = normaliseKey(stackValue(it, field));
    if (!key) continue;
    const g = groups.get(key);
    if (g) g.push(it.id);
    else groups.set(key, [it.id]);
  }
  for (const [key, ids] of groups) {
    if (ids.length < 2) continue;
    stacks.set(key, { key, ids });
    for (const id of ids) byId.set(id, key);
  }
  return { stacks, byId };
}
