// Reads and writes the mapping sidecar and turns CLI flags into a Mapping overlay.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { inferMapping, resolveMapping } from '../core/infer.ts';
import { isDay, isRecord, type FacetSpec, type Mapping, type ResolvedMapping } from '../core/model.ts';
import { InputError, type Dataset } from './load.ts';

export function sidecarPath(inputPath: string): string {
  return inputPath.replace(/\.(json|ndjson|jsonl)$/i, '') + '.chaff-map.json';
}

export function readMapping(path: string): Mapping {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new InputError(`cannot read mapping ${path}: ${(e as Error).message}`);
  }
  if (!isRecord(parsed) || parsed['chaff'] !== 1) throw new InputError(`${path} is not a chaff mapping (expected "chaff": 1)`);
  return parsed as unknown as Mapping;
}

export function writeMapping(path: string, m: Mapping): void {
  writeFileSync(path, JSON.stringify(m, null, 2) + '\n');
}

/** Flags as parsed by the CLI; every entry optional. */
export interface MappingFlags {
  id?: string;
  title?: string;
  body?: string;
  detail?: string[];
  facet?: string[];
  sort?: string;
  stack?: string;
  noStack?: boolean;
  assign?: string;
  bucket?: string[];
  order?: string;
  note?: string;
}

export function flagsToMapping(f: MappingFlags): Mapping {
  const m: Mapping = { chaff: 1 };
  if (f.id) m.id = f.id;
  if (f.title) m.title = f.title;
  if (f.body) m.body = f.body;
  if (f.detail?.length) m.detail = f.detail;
  if (f.facet?.length) m.facets = f.facet.map(parseFacetFlag);
  if (f.sort) {
    const [field, dir] = f.sort.split(':');
    m.sort = dir === 'desc' ? { field: field!, desc: true } : { field: field! };
  }
  if (f.noStack) m.stack = false;
  else if (f.stack) m.stack = f.stack;
  if (f.assign || f.bucket?.length) {
    const [field, list] = (f.assign ?? '').split('=', 2);
    if (!field) throw new InputError('--bucket needs --assign FIELD to say which field the buckets are written to');
    const all = [...(list ? list.split(',').map((s) => s.trim()).filter(Boolean) : []), ...(f.bucket ?? [])];
    // `@date` is not a value but permission: the field may also hold a day.
    const values = all.filter((v) => v !== '@date');
    m.buckets = { field, values };
    if (values.length < all.length) m.buckets.date = true;
  }
  if (f.order) m.order = f.order;
  if (f.note) m.note = f.note;
  return m;
}

/** `field`, `field:present`, or `field:values`. */
function parseFacetFlag(s: string): string | FacetSpec {
  const m = /^(.+):(present|values)$/.exec(s);
  return m ? { field: m[1]!, mode: m[2] as FacetSpec['mode'] } : s;
}

/** The mapping in force: inferred, then the file's own (canonical input), then --map, then flags. */
export function buildMapping(ds: Dataset, opts: { mapPath?: string; inputPath?: string; flags?: MappingFlags; autoSidecar?: boolean }): { mapping: ResolvedMapping; from: string[] } {
  const from: string[] = ['inferred'];
  const inferred = inferMapping(ds.items, { dictKeys: ds.shape === 'dict' });
  const overlays: (Mapping | undefined)[] = [];
  if (ds.mapping) {
    overlays.push(ds.mapping);
    from.push('input file');
  }
  let mapPath = opts.mapPath;
  if (!mapPath && opts.autoSidecar && opts.inputPath && opts.inputPath !== '-') {
    const p = sidecarPath(opts.inputPath);
    if (existsSync(p)) mapPath = p;
  }
  if (mapPath) {
    overlays.push(readMapping(mapPath));
    from.push(mapPath);
  }
  if (opts.flags) {
    const fm = flagsToMapping(opts.flags);
    if (Object.keys(fm).length > 1) {
      overlays.push(fm);
      from.push('flags');
    }
  }
  const mapping = resolveMapping(inferred, ...overlays);
  if (mapping.buckets) {
    // The bucket facet shows the field's effective values, so an inferred facet on the same
    // field would list the input's stale values a second time, under the same heading.
    mapping.facets = mapping.facets.filter((f) => f.field !== mapping.buckets!.field);
    // Values already present in the bucket field count as buckets too, so an input that was
    // triaged before (or by a script) shows them with keys.
    const seen = new Set(mapping.buckets.values);
    for (const raw of ds.items) {
      const v = raw[mapping.buckets.field];
      // Days in a date bucket are not listed: they would eat the number keys.
      if (typeof v === 'string' && v && !seen.has(v) && !(mapping.buckets.date && isDay(v))) {
        seen.add(v);
        mapping.buckets.values.push(v);
      }
    }
  }
  return { mapping, from };
}
