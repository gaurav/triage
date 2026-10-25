// chaff: triage any JSON/NDJSON list in the browser and get the decisions back as a file.
// Everything chatty goes to stderr; stdout carries data only (and only with --out -).
import { existsSync, appendFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { buildDocument } from './core/document.ts';
import { profileFields } from './core/infer.ts';
import { asString, isEmpty, type Decision, type TriageDocument } from './core/model.ts';
import { buildStacks } from './core/stacks.ts';
import { openBrowser } from './node/browser.ts';
import { InputError, loadDataset, parseDataset, readInput, resolveIds, type Dataset } from './node/load.ts';
import { buildMapping, sidecarPath, writeMapping, type MappingFlags } from './node/mapping.ts';
import { TriageServer, type OpEnvelope } from './node/server.ts';
import { AtomicWriter, serialise, summary } from './node/write.ts';

declare const __CHAFF_VERSION__: string;
const VERSION = typeof __CHAFF_VERSION__ === 'string' ? __CHAFF_VERSION__ : 'dev';

const HELP = `chaff ${VERSION}: triage a JSON or NDJSON list in your browser, get the decisions back as a file.

Usage
  chaff <input> [options]            serve the UI, write decisions to --out, exit when you press Done
  chaff inspect <input> [--write-map] show how the input would be interpreted; write the sidecar
  chaff report <log...>              compare sessions from --log files

Input: a .json array, a .json object whose keys are ids, .ndjson/.jsonl, or - for stdin.
Interpretation comes from heuristics, then <input>.chaff-map.json if present, then --map, then flags.

Options
  --out FILE          output path (default: <input>.triaged.<ext>; - for stdout; required for stdin)
  --assign F[=a,b,..] bucket field to write, with its values in key order (keys 1-9);
                      @date among them lets d put an item on a day (2026-10-27, mon, +3)
  --bucket VALUE      one more bucket value, exact (repeatable; for names with commas)
  --order F           also write each item's final position into F
  --note F            allow a free-text note per item, written into F
  --id F              id field ("index" for the position; dict keys are always the id)
  --title F           field shown as the row title
  --body F            field shown as the main text in the detail pane
  --detail F,...      fields shown first in the detail pane
  --facet F,...       sidebar facets (F:present for a present/absent facet)
  --sort F[:desc]     initial order
  --stack F           stack items whose normalised F matches (default: the title field)
  --no-stack          do not stack
  --map FILE          mapping sidecar to use
  --ui NAME           view to serve (default: list)
  --log FILE          append one NDJSON event per change, for comparing UIs
  --resume            take decisions from an existing --out
  --force             overwrite an existing --out
  --port N            listen on this port (default: any free port)
  --no-open           print the URL instead of opening a browser (also BROWSER=false)
  --json-summary      print the exit summary as JSON on stderr
  --help, --version

Exit codes: 0 Done pressed; 1 bad input, flags or I/O; 2 interrupted (the autosave is intact).
`;

const log = (msg: string) => process.stderr.write(`chaff: ${msg}\n`);

async function main(argv: string[]): Promise<number> {
  const { values: v, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      out: { type: 'string' },
      assign: { type: 'string' },
      bucket: { type: 'string', multiple: true },
      order: { type: 'string' },
      note: { type: 'string' },
      id: { type: 'string' },
      title: { type: 'string' },
      body: { type: 'string' },
      detail: { type: 'string' },
      facet: { type: 'string', multiple: true },
      sort: { type: 'string' },
      stack: { type: 'string' },
      'no-stack': { type: 'boolean' },
      map: { type: 'string' },
      ui: { type: 'string', default: 'list' },
      log: { type: 'string' },
      resume: { type: 'boolean' },
      force: { type: 'boolean' },
      port: { type: 'string' },
      'no-open': { type: 'boolean' },
      'json-summary': { type: 'boolean' },
      'write-map': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'V' },
    },
  });
  if (v.help) {
    process.stderr.write(HELP);
    return 0;
  }
  if (v.version) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  const flags: MappingFlags = {};
  if (v.id) flags.id = v.id;
  if (v.title) flags.title = v.title;
  if (v.body) flags.body = v.body;
  if (v.detail) flags.detail = splitList(v.detail);
  if (v.facet) flags.facet = v.facet.flatMap(splitList);
  if (v.sort) flags.sort = v.sort;
  if (v.stack) flags.stack = v.stack;
  if (v['no-stack']) flags.noStack = true;
  if (v.assign) flags.assign = v.assign;
  if (v.bucket) flags.bucket = v.bucket;
  if (v.order) flags.order = v.order;
  if (v.note) flags.note = v.note;

  const [first, ...rest] = positionals;
  if (first === 'report') return report(rest);
  if (first === 'inspect') {
    const input = rest[0];
    if (!input) throw new InputError('inspect needs an input file');
    return inspect(input, v.map, flags, !!v['write-map']);
  }
  if (!first) {
    process.stderr.write(HELP);
    return 1;
  }
  const portNum = v.port === undefined ? 0 : Number(v.port);
  if (!Number.isInteger(portNum) || portNum < 0 || portNum > 65535) throw new InputError(`--port must be a port number, not ${JSON.stringify(v.port)}`);
  return run(first, {
    out: v.out,
    map: v.map,
    flags,
    ui: v.ui!,
    logPath: v.log,
    resume: !!v.resume,
    force: !!v.force,
    port: portNum,
    noOpen: !!v['no-open'],
    jsonSummary: !!v['json-summary'],
  });
}

function splitList(s: string): string[] {
  return s.split(',').map((x) => x.trim()).filter(Boolean);
}

function inspect(input: string, mapPath: string | undefined, flags: MappingFlags, write: boolean): number {
  const ds = loadDataset(input);
  const opts: Parameters<typeof buildMapping>[1] = { inputPath: input, flags, autoSidecar: true };
  if (mapPath) opts.mapPath = mapPath;
  const { mapping, from } = buildMapping(ds, opts);
  const ids = resolveIds(ds, mapping.id);
  const doc = buildDocument(ds.items, ids, mapping);
  const w = process.stderr;
  w.write(`${input}: ${ds.shape} of ${ds.items.length} item(s); interpretation from ${from.join(', ')}\n`);
  w.write(`  id: ${mapping.id}   title: ${mapping.title || '(none found)'}   body: ${mapping.body ?? '-'}\n`);
  const dates = Object.entries(mapping.dates).map(([s, f]) => `${s}=${f}`).join(' ');
  w.write(`  dates: ${dates || '-'}   priority: ${mapping.priority ?? '-'}   url: ${mapping.url ?? '-'}   children: ${mapping.children ?? '-'}\n`);
  if (mapping.buckets) w.write(`  buckets: ${mapping.buckets.field} = ${mapping.buckets.values.join(', ') || '(none yet)'}${mapping.buckets.date ? ' or a day (d)' : ''}\n`);
  const stacks = buildStacks(doc.items, mapping.stack);
  const stacked = [...stacks.stacks.values()].reduce((n, s) => n + s.ids.length, 0);
  w.write(`  stack on: ${mapping.stack === false ? '(off)' : mapping.stack}   ${stacks.stacks.size} stack(s) covering ${stacked} item(s)\n`);
  w.write(`  facets:\n`);
  const profiles = new Map(profileFields(ds.items).map((p) => [p.field, p]));
  for (const f of mapping.facets) {
    const p = profiles.get(f.field);
    const detail = f.mode === 'present' ? `present in ${p?.filled ?? 0}` : `${p?.distinct ?? 0} values, e.g. ${(p?.sampleValues ?? []).slice(0, 3).map((s) => JSON.stringify(s)).join(', ')}`;
    w.write(`    ${f.field}${f.mode === 'present' ? ':present' : ''}  (${detail})\n`);
  }
  const other = [...profiles.keys()].filter((f) => f !== mapping.id && f !== mapping.title && !mapping.facets.some((x) => x.field === f));
  if (other.length) w.write(`  other fields: ${other.join(', ')}\n`);
  if (write) {
    if (input === '-') throw new InputError('--write-map needs a file input to put the sidecar next to');
    const p = sidecarPath(input);
    writeMapping(p, mapping);
    w.write(`wrote ${p}; edit it, and chaff will use it next time\n`);
  }
  return 0;
}

interface RunOptions {
  out: string | undefined;
  map: string | undefined;
  flags: MappingFlags;
  ui: string;
  logPath: string | undefined;
  resume: boolean;
  force: boolean;
  port: number;
  noOpen: boolean;
  jsonSummary: boolean;
}

async function run(input: string, o: RunOptions): Promise<number> {
  if (input === '-' && !o.out) throw new InputError('reading stdin needs --out FILE (or --out -)');
  const outPath = o.out ?? defaultOut(input);
  const toStdout = outPath === '-';
  if (toStdout && o.jsonSummary) throw new InputError('--json-summary and --out - both want a stream; drop one');
  const uiDir = join(dirname(fileURLToPath(import.meta.url)), 'ui', o.ui);
  if (!existsSync(join(uiDir, 'index.html'))) throw new InputError(`no view named ${JSON.stringify(o.ui)} (looked in ${uiDir})`);

  const ds = parseDataset(readInput(input), { path: input });
  const mopts: Parameters<typeof buildMapping>[1] = { inputPath: input, flags: o.flags, autoSidecar: true };
  if (o.map) mopts.mapPath = o.map;
  const { mapping, from } = buildMapping(ds, mopts);
  const ids = resolveIds(ds, mapping.id);
  const doc = buildDocument(ds.items, ids, mapping);

  if (!toStdout && existsSync(outPath)) {
    if (o.resume) resumeFrom(doc, outPath, ds);
    else if (!o.force) throw new InputError(`${outPath} exists; --resume to continue that session, --force to overwrite, or --out elsewhere`);
  } else if (o.resume && !toStdout) {
    log(`nothing to resume at ${outPath}; starting fresh`);
  }

  const writer = toStdout ? null : new AtomicWriter(outPath);
  const persist = () => writer?.schedule(serialise(ds, doc));
  persist();
  // The output exists from the start, so a caller can watch it, and a crash later leaves a file.
  if (writer) await writer.flush();

  const logEvent = (env: OpEnvelope) => {
    if (!o.logPath) return;
    const line = { t: new Date().toISOString(), ui: o.ui, ops: env.ops, effort: env.effort ?? {}, summary: summary(doc) };
    appendFileSync(o.logPath, JSON.stringify(line) + '\n');
  };

  let finish: (code: number) => void = () => {};
  const finished = new Promise<number>((r) => (finish = r));

  const server = new TriageServer(doc, uiDir, { ui: o.ui, input, out: outPath, version: VERSION }, {
    onChange(env) {
      persist();
      logEvent(env);
    },
    async onDone() {
      finish(0);
    },
    summary: () => summary(doc),
  });

  let url: string;
  try {
    ({ url } = await server.listen(o.port));
  } catch (e) {
    throw new InputError(`cannot listen on port ${o.port}: ${(e as Error).message}`);
  }
  if (o.logPath) appendFileSync(o.logPath, JSON.stringify({ t: new Date().toISOString(), ui: o.ui, start: { input, out: outPath, items: doc.items.length, from } }) + '\n');
  log(`${ds.items.length} item(s) from ${input} (${ds.shape}); interpretation from ${from.join(', ')}`);
  log(`writing ${toStdout ? 'stdout at Done' : outPath}`);
  log(`open ${url}`);
  if (!o.noOpen) openBrowser(url, log);

  const onSignal = () => finish(2);
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  const code = await finished;
  process.off('SIGINT', onSignal);
  process.off('SIGTERM', onSignal);
  await server.close();
  if (writer) await writer.close();
  if (toStdout && code === 0) process.stdout.write(serialise(ds, doc));
  const s = summary(doc);
  if (o.logPath) appendFileSync(o.logPath, JSON.stringify({ t: new Date().toISOString(), ui: o.ui, end: { code, summary: s } }) + '\n');
  if (o.jsonSummary) process.stderr.write(JSON.stringify({ ...s, code, out: toStdout ? null : outPath, idField: mapping.id }) + '\n');
  else {
    const parts = Object.entries(s.buckets).map(([k, n]) => `${k} ${n}`);
    log(`${code === 0 ? 'done' : 'interrupted'}: ${s.triaged}/${s.total} triaged${parts.length ? ` (${parts.join(', ')})` : ''}${s.noted ? `, ${s.noted} noted` : ''}${toStdout ? '' : `; ${outPath}`}`);
  }
  return code;
}

function defaultOut(input: string): string {
  const m = /^(.*)\.(json|ndjson|jsonl)$/i.exec(input);
  return m ? `${m[1]}.triaged.${m[2]}` : `${input}.triaged.json`;
}

/** Take bucket/note values and order from an earlier output of the same input. Items only in
 *  the old output are ignored; items only in the input start undecided. */
function resumeFrom(doc: TriageDocument, outPath: string, ds: Dataset): void {
  const old = loadDataset(outPath);
  const m = doc.mapping;
  const oldIds = old.shape === 'dict' ? old.keys! : m.id === 'index' ? old.items.map((_, i) => String(i)) : old.items.map((r) => asString(r[m.id]));
  const byId = new Map(doc.items.map((it) => [it.id, it]));
  let taken = 0;
  const seen: string[] = [];
  old.items.forEach((raw, i) => {
    const id = oldIds[i]!;
    const item = byId.get(id);
    if (!item) return;
    seen.push(id);
    const d: Decision = {};
    if (m.buckets) {
      const nv = raw[m.buckets.field];
      if (!isEmpty(nv) && asString(nv) !== asString(item.raw[m.buckets.field])) d.bucket = asString(nv);
    }
    if (m.note) {
      const nv = raw[m.note];
      if (!isEmpty(nv) && asString(nv) !== asString(item.raw[m.note])) d.note = asString(nv);
    }
    if (d.bucket !== undefined || d.note !== undefined) {
      doc.decisions[id] = d;
      taken++;
    }
  });
  if (ds.shape !== 'dict') {
    const seenSet = new Set(seen);
    doc.order = [...seen, ...doc.order.filter((id) => !seenSet.has(id))];
  }
  log(`resumed ${taken} decision(s) from ${outPath}`);
}

async function report(paths: string[]): Promise<number> {
  if (!paths.length) throw new InputError('report needs one or more --log files');
  const rows: string[][] = [['log', 'ui', 'items', 'changes', 'undos', 'keys', 'clicks', 'minutes', 's/change', 'triaged']];
  for (const p of paths) {
    const lines = readInput(p).split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as Record<string, unknown>);
    const start = lines.find((l) => l['start']) as { t: string; ui: string; start: { items: number } } | undefined;
    const end = lines.find((l) => l['end']) as { t: string; end: { summary: { triaged: number; total: number } } } | undefined;
    const changes = lines.filter((l) => l['ops']) as { t: string; effort: { keys?: number; clicks?: number; undo?: boolean } }[];
    const first = lines[0]?.['t'] as string | undefined;
    const last = lines.at(-1)?.['t'] as string | undefined;
    const minutes = first && last ? (Date.parse(last) - Date.parse(first)) / 60000 : 0;
    const keys = changes.reduce((n, c) => n + (c.effort?.keys ?? 0), 0);
    const clicks = changes.reduce((n, c) => n + (c.effort?.clicks ?? 0), 0);
    const undos = changes.filter((c) => c.effort?.undo).length;
    const triaged = end ? `${end.end.summary.triaged}/${end.end.summary.total}` : '?';
    rows.push([p, start?.ui ?? '?', String(start?.start.items ?? '?'), String(changes.length), String(undos), String(keys), String(clicks), minutes.toFixed(1), changes.length ? ((minutes * 60) / changes.length).toFixed(1) : '-', triaged]);
  }
  const widths = rows[0]!.map((_, c) => Math.max(...rows.map((r) => r[c]!.length)));
  for (const r of rows) process.stdout.write(r.map((cell, c) => cell.padEnd(widths[c]!)).join('  ').trimEnd() + '\n');
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e: unknown) => {
    if (e instanceof InputError || (e instanceof TypeError && /option|argument/i.test(e.message))) {
      log(e.message);
      process.exit(1);
    }
    log(`unexpected error: ${(e as Error).stack ?? String(e)}`);
    process.exit(1);
  },
);
