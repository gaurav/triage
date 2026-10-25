// The Sunsama recipe in docs/sunsama.md: the script that turns MCP task records into chaff
// input, and the committed sidecar that reads its output. Skipped when python3 is missing.
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
