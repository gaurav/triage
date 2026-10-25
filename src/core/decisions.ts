// Pure operations on a TriageDocument's decisions and order. The server applies these and
// writes the result; the UI applies the same ones optimistically.
import type { Decision, TriageDocument } from './model.ts';

export type DecisionOp =
  | { op: 'bucket'; ids: string[]; bucket: string | null }
  | { op: 'note'; ids: string[]; note: string | null }
  | { op: 'order'; order: string[] };

/** Apply an op in place. `null` clears the decision, which restores the input's own value. */
export function applyOp(doc: TriageDocument, op: DecisionOp): void {
  switch (op.op) {
    case 'bucket':
      for (const id of op.ids) setField(doc, id, 'bucket', op.bucket);
      break;
    case 'note':
      for (const id of op.ids) setField(doc, id, 'note', op.note);
      break;
    case 'order': {
      const known = new Set(doc.order);
      const seen = new Set<string>();
      const next: string[] = [];
      for (const id of op.order) {
        if (known.has(id) && !seen.has(id)) {
          next.push(id);
          seen.add(id);
        }
      }
      // Anything the client forgot keeps its relative position at the end.
      for (const id of doc.order) if (!seen.has(id)) next.push(id);
      doc.order = next;
      break;
    }
  }
}

function setField(doc: TriageDocument, id: string, key: keyof Decision, value: string | null): void {
  const d: Decision = doc.decisions[id] ?? {};
  if (value === null) delete d[key];
  else d[key] = value;
  if (d.bucket === undefined && d.note === undefined) delete doc.decisions[id];
  else doc.decisions[id] = d;
}

/** Bucket key 1..9 -> value, as the UI's digit keys use it. */
export function bucketForKey(doc: TriageDocument, digit: number): string | undefined {
  return doc.mapping.buckets?.values[digit - 1];
}
