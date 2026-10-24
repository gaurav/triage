// Heuristics that propose a Mapping from raw records. `chaff inspect --write-map` writes the
// result as a sidecar for the user to correct; the CLI flags override individual entries.
import {
  DATE_SLOTS,
  isEmpty,
  isRecord,
  isScalar,
  normaliseFacet,
  type DateSlot,
  type FacetSpec,
  type Mapping,
  type Raw,
  type ResolvedMapping,
} from './model.ts';

const ID_FIELDS = ['id', '_id', 'key', 'number', 'uid', 'uuid', 'url', 'html_url'];
const TITLE_FIELDS = ['title', 'text', 'name', 'summary', 'subject', 'label', 'headline'];
const BODY_FIELDS = ['body', 'notes', 'description', 'content', 'details', 'text'];
const URL_FIELDS = ['url', 'html_url', 'link', 'href', 'permalink'];
const CHILD_FIELDS = ['subtasks', 'children', 'items', 'tasks', 'subissues', 'sub_issues'];
const PARENT_FIELDS = ['parent', 'parentId', 'parent_id', 'parentID'];
const TAG_FIELDS = ['tags', 'labels', 'keywords', 'categories'];
const DATE_NAMES: Record<DateSlot, RegExp> = {
  created: /^(created|createdat|created_at|creationdate|opened|opened_at|added|date)$/i,
  updated: /^(updated|updatedat|updated_at|modified|modifiedat|modified_at|lastmodified)$/i,
  start: /^(start|startdate|start_date|started|started_at|scheduled|scheduled_at)$/i,
  due: /^(due|duedate|due_date|deadline|due_on|dueon)$/i,
  completed: /^(completed|completeddate|completed_date|completedat|completed_at|done|doneat|done_at|closed|closedat|closed_at|finished)$/i,
};
const PRIORITY_NAME = /priorit|severity|urgenc|importance/i;
// ISO 8601 date, with or without a time; also the bare YYYY-MM-DD Sunsama uses for startDate.
const ISO_DATE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

export const MAX_FACET_VALUES = 50;

export interface FieldProfile {
  field: string;
  /** Number of records in which the field is present and non-empty. */
  filled: number;
  distinct: number;
  /** Which kinds of (non-empty) values were seen. */
  kinds: Set<'string' | 'number' | 'boolean' | 'array' | 'object'>;
  /** True when every non-empty value is an array of scalars. */
  scalarArray: boolean;
  /** Fraction of non-empty string values that parse as ISO dates. */
  dateness: number;
  htmlish: boolean;
  avgLength: number;
  sampleValues: string[];
}

export function profileFields(raws: Raw[]): FieldProfile[] {
  const order: string[] = [];
  const acc = new Map<string, { filled: number; values: Map<string, number>; kinds: FieldProfile['kinds']; scalarArray: boolean; dates: number; strings: number; html: number; len: number }>();
  for (const raw of raws) {
    for (const [field, v] of Object.entries(raw)) {
      let a = acc.get(field);
      if (!a) {
        a = { filled: 0, values: new Map(), kinds: new Set(), scalarArray: true, dates: 0, strings: 0, html: 0, len: 0 };
        acc.set(field, a);
        order.push(field);
      }
      if (isEmpty(v)) continue;
      a.filled++;
      if (Array.isArray(v)) {
        a.kinds.add('array');
        if (!v.every(isScalar)) a.scalarArray = false;
        for (const x of v) if (isScalar(x)) bump(a.values, String(x));
      } else if (isRecord(v)) {
        a.kinds.add('object');
        a.scalarArray = false;
      } else {
        a.kinds.add(typeof v as 'string' | 'number' | 'boolean');
        a.scalarArray = false;
        const s = String(v);
        bump(a.values, s);
        if (typeof v === 'string') {
          a.strings++;
          a.len += s.length;
          if (ISO_DATE.test(s.trim())) a.dates++;
          if (/<\/?[a-z][^>]*>/i.test(s)) a.html++;
        }
      }
    }
  }
  return order.map((field) => {
    const a = acc.get(field)!;
    return {
      field,
      filled: a.filled,
      distinct: a.values.size,
      kinds: a.kinds,
      scalarArray: a.kinds.has('array') && a.scalarArray && !a.kinds.has('string') && !a.kinds.has('number') && !a.kinds.has('boolean') && !a.kinds.has('object'),
      dateness: a.strings ? a.dates / a.strings : 0,
      htmlish: a.strings > 0 && a.html / a.strings > 0.5,
      avgLength: a.strings ? a.len / a.strings : 0,
      sampleValues: [...a.values.entries()].sort((x, y) => y[1] - x[1]).slice(0, 5).map(([v]) => v),
    };
  });
}

function bump(m: Map<string, number>, k: string) {
  m.set(k, (m.get(k) ?? 0) + 1);
}

/** Propose a mapping. `shape === 'dict'` means ids come from keys and no id field is needed. */
export function inferMapping(raws: Raw[], opts: { dictKeys?: boolean } = {}): ResolvedMapping {
  const profiles = profileFields(raws);
  const byName = new Map(profiles.map((p) => [p.field, p]));
  const n = raws.length;
  const isStringy = (p: FieldProfile | undefined) => !!p && p.kinds.has('string') && p.kinds.size === 1;

  // id: a well-known name that is present in every record and unique, else the array index.
  let id = 'index';
  if (!opts.dictKeys) {
    for (const f of ID_FIELDS) {
      const p = byName.get(f);
      if (p && p.filled === n && p.distinct === n && !p.kinds.has('array') && !p.kinds.has('object')) {
        id = f;
        break;
      }
    }
  } else {
    id = 'key';
  }

  // title: a well-known name holding mostly short strings, else the shortest-average string field.
  let title: string | undefined;
  for (const f of TITLE_FIELDS) {
    const p = byName.get(f);
    if (isStringy(p) && p!.filled >= n * 0.5 && p!.avgLength < 300) {
      title = f;
      break;
    }
  }
  if (!title) {
    const cands = profiles
      .filter((p) => isStringy(p) && p.field !== id && p.dateness < 0.5 && p.filled >= n * 0.5 && p.distinct > 1)
      .sort((a, b) => a.avgLength - b.avgLength);
    title = cands[0]?.field;
  }

  const m: ResolvedMapping = { chaff: 1, id, title: title ?? '', dates: {}, detail: [], facets: [], stack: title ?? false };

  for (const f of BODY_FIELDS) {
    const p = byName.get(f);
    if (f !== title && isStringy(p) && p!.filled > 0) {
      m.body = f;
      break;
    }
  }
  for (const f of URL_FIELDS) {
    const p = byName.get(f);
    if (f !== id && isStringy(p) && p!.sampleValues.some((v) => /^https?:\/\//.test(v))) {
      m.url = f;
      break;
    }
  }
  for (const f of CHILD_FIELDS) {
    const p = byName.get(f);
    if (p && p.kinds.has('array') && p.filled > 0) {
      m.children = f;
      break;
    }
  }
  for (const f of PARENT_FIELDS) {
    const p = byName.get(f);
    if (p && p.filled > 0 && !p.kinds.has('array') && !p.kinds.has('object')) {
      m.parent = f;
      break;
    }
  }
  for (const f of TAG_FIELDS) {
    const p = byName.get(f);
    if (p && p.scalarArray) {
      m.tags = f;
      break;
    }
  }

  // dates: fields whose non-empty strings are mostly ISO dates, slotted by name.
  const dateFields = profiles.filter((p) => p.kinds.has('string') && p.filled > 0 && p.dateness >= 0.8).map((p) => p.field);
  for (const slot of DATE_SLOTS) {
    const f = dateFields.find((f) => DATE_NAMES[slot].test(f) && !Object.values(m.dates).includes(f));
    if (f) m.dates[slot] = f;
  }

  // priority: a priority-looking name with a handful of distinct values, preferring the one that
  // actually varies (Sunsama's backlogPriority is "No priority" on every row).
  const prio = profiles
    .filter((p) => PRIORITY_NAME.test(p.field) && p.distinct >= 2 && p.distinct <= 10 && !p.kinds.has('object'))
    .sort((a, b) => b.filled - a.filled);
  if (prio[0]) m.priority = prio[0].field;

  // facets: low-cardinality scalar (or scalar-array) fields, plus present/absent for dates and urls.
  const facets: FacetSpec[] = [];
  for (const p of profiles) {
    if (p.field === id || p.field === title || p.field === m.body) continue;
    if (p.kinds.has('object')) continue;
    if (p.kinds.has('array') && !p.scalarArray) continue;
    if (dateFields.includes(p.field) || p.field === m.url) {
      if (p.filled > 0 && p.filled < n) facets.push({ field: p.field, mode: 'present' });
      continue;
    }
    // One distinct value is still a facet when some records lack it (done: true vs nothing).
    if (p.filled === 0 || (p.distinct < 2 && p.filled === n) || p.distinct > MAX_FACET_VALUES) continue;
    if (p.kinds.has('string') && p.avgLength > 80) continue;
    facets.push({ field: p.field, mode: 'values' });
  }
  m.facets = facets;

  // detail: body first, then dates and the rest of the mapped fields; the UI shows every other
  // raw field after these, collapsed.
  m.detail = [m.body, ...Object.values(m.dates), m.priority, m.url, m.children, m.tags].filter((f): f is string => !!f);
  return m;
}

/** Overlay a user-supplied mapping (sidecar, then flags) on the inferred one. */
export function resolveMapping(inferred: ResolvedMapping, ...overlays: (Mapping | undefined)[]): ResolvedMapping {
  const out: ResolvedMapping = { ...inferred, dates: { ...inferred.dates }, detail: [...inferred.detail], facets: [...inferred.facets] };
  for (const o of overlays) {
    if (!o) continue;
    for (const [k, v] of Object.entries(o)) {
      if (v === undefined || k === 'chaff') continue;
      if (k === 'dates') Object.assign(out.dates, v as Mapping['dates']);
      else if (k === 'facets') out.facets = (v as (string | FacetSpec)[]).map(normaliseFacet);
      else (out as unknown as Record<string, unknown>)[k] = v;
    }
  }
  // A facet listed by name for a date/url field means present/absent unless the user said otherwise.
  const dateish = new Set([...Object.values(out.dates), out.url].filter(Boolean));
  out.facets = out.facets.map((f) =>
    dateish.has(f.field) && f.mode === 'values' && !overlaysSetMode(overlays, f.field) ? { ...f, mode: 'present' } : f,
  );
  return out;
}

function overlaysSetMode(overlays: (Mapping | undefined)[], field: string): boolean {
  return overlays.some((o) => o?.facets?.some((f) => typeof f !== 'string' && f.field === field));
}
