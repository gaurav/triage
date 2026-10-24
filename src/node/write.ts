// Merges decisions back into the raw items, serialises them in the input's shape, and writes
// atomically through a single serialised writer with a debounce and an awaited flush.
import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { asString, effectiveBucket, effectiveNote, isEmpty, type Item, type Raw, type TriageDocument } from '../core/model.ts';
import { buildStacks } from '../core/stacks.ts';
import type { Dataset } from './load.ts';

/** The output records in final order, with only the bucket/note/order fields touched. */
export function mergedItems(doc: TriageDocument): { item: Item; out: Raw }[] {
  const byId = new Map(doc.items.map((it) => [it.id, it]));
  const m = doc.mapping;
  const ordered = orderedIds(doc);
  return ordered.map((id, position) => {
    const item = byId.get(id)!;
    const out: Raw = { ...item.raw };
    const d = doc.decisions[id];
    if (m.buckets && d?.bucket !== undefined) out[m.buckets.field] = d.bucket;
    if (m.note && d?.note !== undefined) out[m.note] = d.note;
    if (m.order) out[m.order] = position;
    return { item, out };
  });
}

/** The output order. An untouched session (no reorder, no --sort) writes the input order, so a
 *  diff of input against output shows only decisions. Once the order differs, stacked members
 *  follow the first of their stack that appears, in input order, because a stack moves as one
 *  row in the UI. */
export function orderedIds(doc: TriageDocument): string[] {
  const untouched = doc.order.length === doc.items.length && doc.order.every((id, i) => id === doc.items[i]!.id);
  if (untouched) return [...doc.order];
  const { stacks, byId } = buildStacks(doc.items, doc.mapping.stack);
  if (stacks.size === 0) return [...doc.order];
  const placed = new Set<string>();
  const out: string[] = [];
  for (const id of doc.order) {
    if (placed.has(id)) continue;
    out.push(id);
    placed.add(id);
    const key = byId.get(id);
    if (!key) continue;
    for (const member of stacks.get(key)!.ids) {
      if (!placed.has(member)) {
        out.push(member);
        placed.add(member);
      }
    }
  }
  return out;
}

export function serialise(ds: Dataset, doc: TriageDocument): string {
  const rows = mergedItems(doc);
  const nl = ds.trailingNewline ? '\n' : '';
  switch (ds.shape) {
    case 'ndjson':
      return rows.map((r) => JSON.stringify(r.out)).join('\n') + '\n';
    case 'array':
      return JSON.stringify(rows.map((r) => r.out), null, 2) + nl;
    case 'dict': {
      // JavaScript puts integer-like keys first whatever we do, so dict order is input order;
      // the README says so and points at --order.
      const keyOf = new Map(ds.keys!.map((k, i) => [doc.items[i]!.id, k]));
      const obj: Raw = {};
      for (const r of rows) obj[keyOf.get(r.item.id)!] = r.out;
      return JSON.stringify(obj, null, 2) + nl;
    }
    case 'canonical':
      return JSON.stringify({ ...ds.wrapper, chaff: 1, mapping: stripResolved(doc), items: rows.map((r) => r.out) }, null, 2) + nl;
  }
}

function stripResolved(doc: TriageDocument): Raw {
  return { ...doc.mapping };
}

/** Per-bucket counts for the exit summary. */
export function summary(doc: TriageDocument): { total: number; triaged: number; buckets: Record<string, number>; untriaged: number; noted: number } {
  const buckets: Record<string, number> = {};
  for (const v of doc.mapping.buckets?.values ?? []) buckets[v] = 0;
  let triaged = 0;
  let noted = 0;
  for (const it of doc.items) {
    const b = effectiveBucket(doc, it);
    if (b !== undefined) {
      triaged++;
      buckets[b] = (buckets[b] ?? 0) + 1;
    }
    if (!isEmpty(asString(effectiveNote(doc, it)))) noted++;
  }
  return { total: doc.items.length, triaged, untriaged: doc.items.length - triaged, buckets, noted };
}

/** Writes a file atomically (temp file beside the target, then rename), never concurrently,
 *  and no more often than every `debounceMs`. `flush()` waits for the latest content to land. */
export class AtomicWriter {
  private chain: Promise<void> = Promise.resolve();
  private pending: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private tmpDir: string | null = null;
  readonly path: string;
  readonly debounceMs: number;
  writes = 0;

  constructor(path: string, debounceMs = 200) {
    this.path = path;
    this.debounceMs = debounceMs;
  }

  /** Schedule `content` to be written; later calls replace earlier unwritten ones. */
  schedule(content: string): void {
    this.pending = content;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.kick();
    }, this.debounceMs);
    this.timer.unref?.();
  }

  private kick(): void {
    if (this.pending === null) return;
    const content = this.pending;
    this.pending = null;
    this.chain = this.chain.then(() => this.writeNow(content));
  }

  private writeNow(content: string): void {
    if (!this.tmpDir) this.tmpDir = mkdtempSync(join(dirname(this.path) || '.', '.chaff-'));
    const tmp = join(this.tmpDir, 'out');
    writeFileSync(tmp, content);
    renameSync(tmp, this.path);
    this.writes++;
  }

  /** Write anything pending now and wait until it is on disk. */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.kick();
    await this.chain;
  }

  async close(): Promise<void> {
    await this.flush();
    if (this.tmpDir) rmSync(this.tmpDir, { recursive: true, force: true });
    this.tmpDir = null;
  }
}
