// Reads the input and detects its shape. Nothing here interprets fields; see core/infer.ts.
import { readFileSync } from 'node:fs';
import { isRecord, type Mapping, type Raw, type Shape } from '../core/model.ts';

export interface Dataset {
  shape: Shape;
  items: Raw[];
  /** dict: the key of each item, parallel to `items`. */
  keys?: string[];
  /** canonical: the mapping carried in the file, if any. */
  mapping?: Mapping;
  /** canonical: every top-level field other than items/mapping, written back unchanged. */
  wrapper?: Raw;
  /** True when the file ended with a newline (so the output can match). */
  trailingNewline: boolean;
}

export class InputError extends Error {}

export function readInput(path: string): string {
  if (path === '-') return readFileSync(0, 'utf8');
  try {
    return readFileSync(path, 'utf8');
  } catch (e) {
    throw new InputError(`cannot read ${path}: ${(e as Error).message}`);
  }
}

export function parseDataset(text: string, hint: { path?: string } = {}): Dataset {
  const trailingNewline = text.endsWith('\n');
  const ext = hint.path?.toLowerCase().match(/\.(ndjson|jsonl)$/)?.[1];
  if (ext) return { ...parseNdjson(text), trailingNewline };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    // A .json (or stdin) that is not one document may still be NDJSON.
    if (text.includes('\n')) {
      try {
        return { ...parseNdjson(text), trailingNewline };
      } catch {
        /* fall through to the JSON error, which is the likelier diagnosis */
      }
    }
    throw new InputError(`input is not JSON: ${(e as Error).message}`);
  }
  if (Array.isArray(parsed)) {
    parsed.forEach((v, i) => {
      if (!isRecord(v)) throw new InputError(`item ${i} is not an object`);
    });
    return { shape: 'array', items: parsed as Raw[], trailingNewline };
  }
  if (isRecord(parsed)) {
    if (parsed['chaff'] === 1 && Array.isArray(parsed['items'])) {
      const { items, mapping, ...wrapper } = parsed;
      (items as unknown[]).forEach((v, i) => {
        if (!isRecord(v)) throw new InputError(`items[${i}] is not an object`);
      });
      const ds: Dataset = { shape: 'canonical', items: items as Raw[], wrapper, trailingNewline };
      if (isRecord(mapping)) ds.mapping = mapping as unknown as Mapping;
      return ds;
    }
    const keys = Object.keys(parsed);
    const items = keys.map((k) => {
      const v = parsed[k];
      if (!isRecord(v)) throw new InputError(`value of key ${JSON.stringify(k)} is not an object; a dict input maps ids to objects`);
      return v;
    });
    return { shape: 'dict', items, keys, trailingNewline };
  }
  throw new InputError('input must be a JSON array, an object of objects, or NDJSON');
}

function parseNdjson(text: string): Omit<Dataset, 'trailingNewline'> {
  const items: Raw[] = [];
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    if (!line.trim()) return;
    let v: unknown;
    try {
      v = JSON.parse(line);
    } catch (e) {
      throw new InputError(`line ${i + 1} is not JSON: ${(e as Error).message}`);
    }
    if (!isRecord(v)) throw new InputError(`line ${i + 1} is not an object`);
    items.push(v);
  });
  return { shape: 'ndjson', items };
}

/** Ids as strings, validated: duplicates and blanks are errors unless `index` was asked for. */
export function resolveIds(ds: Dataset, idField: string): string[] {
  if (ds.shape === 'dict') return ds.keys!;
  if (idField === 'index') return ds.items.map((_, i) => String(i));
  const ids = ds.items.map((raw, i) => {
    const v = raw[idField];
    if (v === undefined || v === null || v === '') throw new InputError(`item ${i} has no ${JSON.stringify(idField)}; pass --id FIELD, or --id index to use positions`);
    if (typeof v === 'object') throw new InputError(`item ${i}: ${JSON.stringify(idField)} is not a scalar`);
    return String(v);
  });
  const seen = new Map<string, number>();
  ids.forEach((id, i) => {
    const prev = seen.get(id);
    if (prev !== undefined) throw new InputError(`items ${prev} and ${i} share the id ${JSON.stringify(id)}; ids must be unique (pass --id index to use positions)`);
    seen.set(id, i);
  });
  return ids;
}

export function loadDataset(path: string): Dataset {
  return parseDataset(readInput(path), { path });
}
