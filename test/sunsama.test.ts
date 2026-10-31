// The Sunsama recipe in docs/sunsama.md: the script that turns MCP task records into chaff
// input, the committed sidecar that reads its output, and the script that filters an export.
// Skipped when python3 is missing.
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { parseDataset } from '../src/node/load.ts';
import { buildMapping } from '../src/node/mapping.ts';

const ROOT = new URL('..', import.meta.url).pathname;
const SCRIPT = join(ROOT, 'docs/sunsama/build-archive.py');
const SIDECAR = join(ROOT, 'docs/sunsama/archive.chaff-map.json');
const FIXTURES = join(ROOT, 'test/fixtures');
const python = spawnSync('python3', ['--version']).status === 0;

describe('docs/sunsama/build-archive.py', { skip: python ? false : 'python3 not found' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'chaff-sunsama-'));
  after(() => rmSync(dir, { recursive: true, force: true }));
  const out = join(dir, 'archive.json');

  it('merges MCP pages by _id and flattens the fields chaff needs', () => {
    const r = spawnSync('python3', ['-I', SCRIPT, out, join(FIXTURES, 'sunsama-mcp-page.json'), join(FIXTURES, 'sunsama-mcp-one.json'), '--no-github'], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const items = JSON.parse(readFileSync(out, 'utf8')) as Record<string, unknown>[];
    assert.equal(items.length, 2, 'the second page repeats an id and is dropped');
    const [report, plants] = items as [Record<string, unknown>, Record<string, unknown>];
    assert.equal(report['title'], 'Write the quarterly report', 'the first record for an id wins');
    assert.equal(report['url'], 'https://github.com/example/reports/issues/7');
    assert.equal(report['service'], 'github');
    assert.equal(report['githubState'], undefined, '--no-github leaves the state unset');
    assert.equal(report['createdAt'], '2026-09-01');
    assert.equal(report['lastWorkedOn'], '2026-09-03');
    assert.deepEqual(report['subtasks'], [{ title: 'Collect numbers', completed: true }, { title: 'Write it', completed: false }]);
    assert.equal(plants['recurring'], true);
    assert.equal(plants['folder'], 'Chores');
    assert.equal(plants['priority'], 'important');
  });

  it('is read by the committed sidecar as skip, backlog, complete, delete or a day', () => {
    const ds = parseDataset(readFileSync(out, 'utf8'), { path: out });
    const { mapping, from } = buildMapping(ds, { mapPath: SIDECAR });
    assert.ok(from.includes(SIDECAR));
    assert.deepEqual(mapping.buckets, { field: 'action', values: ['skip', 'backlog', 'complete', 'delete'], date: true });
    assert.equal(mapping.title, 'title');
    assert.equal(mapping.children, 'subtasks');
    assert.deepEqual(mapping.dates, { created: 'createdAt', due: 'dueDate', updated: 'lastWorkedOn' });
    const facets = mapping.facets.map((f) => `${f.field}:${f.mode}`);
    assert.ok(facets.includes('githubState:values') && facets.includes('recurring:values') && facets.includes('timeSpent:present'), facets.join(' '));
  });
});

describe('docs/sunsama/filter-export.py', { skip: python ? false : 'python3 not found' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'chaff-sunsama-filter-'));
  after(() => rmSync(dir, { recursive: true, force: true }));
  const doc = 'https://docs.google.com/document/d/abc/edit';
  const issue = 'https://github.com/example/reports/issues/7';
  const scholar = 'https://scholar.google.com/scholar?cites=1&amp;hl=en';
  const report = {
    id: 'a1',
    text: `Write the report (${doc})`,
    url: 'https://docs.google.com/spreadsheets/d/x/edit',
    notes: `<p>Doc: <a target="_blank" href="${doc}" text="${doc}">${doc}</a></p>`
      + `<p><a href="https://docs.google.com/presentation/d/p">Slides</a> and <a href="${issue}">${issue}</a></p>`,
    subtasks: [
      { title: `Look through ${doc}.`, integration: { service: 'website', identifier: { url: doc } } },
      { title: `See ${issue}`, integration: { service: 'github', identifier: { url: issue } } },
    ],
  };
  const papers = { id: 'b2', text: 'Make a Google Sheet of papers', url: null, notes: `<p><a href="${scholar}">${scholar}</a></p>`, subtasks: [] };
  const form = { id: 'c3', text: 'Fill in https://forms.gle/AbC1 and docs.google.com/document/d/xyz, not https://g.com/keep', url: null, notes: '', subtasks: [] };
  const exportPath = join(dir, 'sunsama-data-export-x-2026-10-31T06-27-15.json');
  writeFileSync(exportPath, JSON.stringify([report, papers, form]));
  const filter = (...args: string[]) => {
    const r = spawnSync('python3', ['-I', join(ROOT, 'docs/sunsama/filter-export.py'), exportPath, ...args], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return r;
  };

  it('removes Google document URLs, keeps Scholar, and lists the URLs left next to the export', () => {
    const r = filter();
    assert.ok(!r.stderr.includes('report'), 'only counts are printed, never task text');
    const [a, b, c] = JSON.parse(readFileSync(join(dir, 'sunsama-exports-filtered-2026oct31.json'), 'utf8')) as typeof report[];
    assert.equal(a!.text, 'Write the report');
    assert.equal(a!.url, null);
    assert.equal(a!.notes, `<p>Doc: </p><p>Slides and <a href="${issue}">${issue}</a></p>`);
    assert.equal(a!.subtasks[0]!.title, 'Look through .');
    assert.equal(a!.subtasks[0]!.integration, null);
    assert.deepEqual(a!.subtasks[1], report.subtasks[1]);
    assert.deepEqual(b, papers);
    assert.equal(c!.text, 'Fill in  and , not https://g.com/keep', 'short links and schemeless URLs go; g.com is not g.co');
    const urls = JSON.parse(readFileSync(join(dir, 'sunsama-urls.json'), 'utf8'));
    assert.deepEqual(urls, [
      { url: issue, domain: 'github.com', count: 3, tasks: 1 },
      { url: 'https://g.com/keep', domain: 'g.com', count: 1, tasks: 1 },
      { url: 'https://scholar.google.com/scholar?cites=1&hl=en', domain: 'scholar.google.com', count: 1, tasks: 1 },
    ]);
  });

  it('puts --marker where a URL was cut out of text', () => {
    filter('--marker', '[Google doc]', '--out', join(dir, 'marked.json'), '--urls', join(dir, 'marked-urls.json'));
    const [a, , c] = JSON.parse(readFileSync(join(dir, 'marked.json'), 'utf8')) as typeof report[];
    assert.equal(a!.text, 'Write the report ([Google doc])');
    assert.equal(a!.url, null, 'a url field is still emptied, not marked');
    assert.equal(a!.notes, `<p>Doc: [Google doc]</p><p>Slides and <a href="${issue}">${issue}</a></p>`);
    assert.equal(a!.subtasks[0]!.title, 'Look through [Google doc].');
    assert.equal(c!.text, 'Fill in [Google doc] and [Google doc], not https://g.com/keep');
  });
});
