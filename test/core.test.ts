import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { applyOp } from '../src/core/decisions.ts';
import { buildDocument, compare } from '../src/core/document.ts';
import { ABSENT, NONE, PRESENT, facetCounts, facetValues, matchesFilter } from '../src/core/facets.ts';
import { inferMapping, resolveMapping } from '../src/core/infer.ts';
import { effectiveBucket, type Raw } from '../src/core/model.ts';
import { buildStacks, normaliseKey } from '../src/core/stacks.ts';

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')) as Raw[];

describe('inferMapping', () => {
  it('reads the small list fixture', () => {
    const m = inferMapping(fixture('list.json'));
    assert.equal(m.id, 'id');
    assert.equal(m.title, 'title');
    assert.equal(m.body, 'body');
    assert.equal(m.url, 'url');
    assert.equal(m.tags, 'labels');
    assert.equal(m.dates.due, 'due');
    assert.equal(m.priority, 'priority');
    assert.deepEqual(m.facets.map((f) => `${f.field}:${f.mode}`), ['labels:values', 'due:present', 'priority:values', 'url:present', 'bucket:values', 'done:values']);
  });

  it('reads a Sunsama-shaped export', () => {
    const m = inferMapping(fixture('sunsama-like.json'));
    assert.equal(m.id, 'id');
    assert.equal(m.title, 'text');
    assert.equal(m.body, 'notes');
    assert.deepEqual(m.dates, { created: 'createdAt', start: 'startDate', due: 'dueDate', completed: 'completedDate' });
    assert.equal(m.priority, 'latestDailyPriority', 'the priority field that varies, not backlogPriority');
    assert.equal(m.children, 'subtasks');
    assert.equal(m.url, 'url');
    assert.equal(m.stack, 'text');
    const facets = Object.fromEntries(m.facets.map((f) => [f.field, f.mode]));
    assert.equal(facets['channel'], 'values');
    assert.equal(facets['completedDate'], 'present');
    assert.equal(facets['dueDate'], 'present');
    assert.equal(facets['dailyPriority'], 'values', 'arrays of scalars are facets');
    assert.equal(facets['assignee'], undefined, 'a single-valued field is not a facet');
    assert.equal(facets['subtasks'], undefined, 'arrays of objects are not facets');
    assert.equal(facets['notes'], undefined);
  });

  it('falls back to the index when no id field is unique', () => {
    const m = inferMapping([{ id: 1, name: 'a' }, { id: 1, name: 'b' }]);
    assert.equal(m.id, 'index');
    assert.equal(m.title, 'name');
  });

  it('lets overlays replace entries and turns named date facets into present/absent', () => {
    const base = inferMapping(fixture('sunsama-like.json'));
    const m = resolveMapping(base, { chaff: 1, title: 'notes', facets: ['channel', 'completedDate', { field: 'dueDate', mode: 'values' }], buckets: { field: 'bucket', values: ['a'] } });
    assert.equal(m.title, 'notes');
    assert.deepEqual(m.facets, [
      { field: 'channel', mode: 'values' },
      { field: 'completedDate', mode: 'present' },
      { field: 'dueDate', mode: 'values' },
    ]);
    assert.deepEqual(m.buckets, { field: 'bucket', values: ['a'] });
    assert.equal(base.title, 'text', 'the inferred mapping is not mutated');
  });
});

describe('stacks', () => {
  it('normalises case, whitespace and trailing punctuation', () => {
    assert.equal(normaliseKey('  Fix the   login bug. '), 'fix the login bug');
    assert.equal(normaliseKey('Write docs!!'), 'write docs');
    assert.equal(normaliseKey('   '), '');
  });

  it('stacks duplicates and never stacks blank titles', () => {
    const raws = fixture('list.json');
    const m = inferMapping(raws);
    const doc = buildDocument(raws, raws.map((r) => String(r['id'])), m);
    const { stacks, byId } = buildStacks(doc.items, m.stack);
    assert.deepEqual([...stacks.keys()].sort(), ['fix the login bug', 'write docs']);
    assert.deepEqual(stacks.get('fix the login bug')!.ids, ['1', '2']);
    assert.deepEqual(stacks.get('write docs')!.ids, ['3', '5']);
    assert.equal(byId.get('4'), undefined, 'the untitled item stands alone');
  });

  it('puts the recurring tasks of the Sunsama fixture into stacks', () => {
    const raws = fixture('sunsama-like.json');
    const m = inferMapping(raws);
    const doc = buildDocument(raws, raws.map((r) => String(r['id'])), m);
    const { stacks } = buildStacks(doc.items, m.stack);
    assert.equal(stacks.get('go through chat messages')!.ids.length, 30);
  });
});

describe('facets', () => {
  const raws = fixture('list.json');
  const m = inferMapping(raws);
  const doc = buildDocument(raws, raws.map((r) => String(r['id'])), m);

  it('reads arrays as multi-valued and blanks as none', () => {
    const labels = { field: 'labels', mode: 'values' as const };
    assert.deepEqual(facetValues(doc.items[0]!, labels), ['bug', 'auth']);
    assert.deepEqual(facetValues(doc.items[2]!, labels), [NONE]);
    assert.deepEqual(facetCounts(doc.items, labels), [
      { value: 'bug', count: 2 },
      { value: 'auth', count: 1 },
      { value: 'chore', count: 1 },
      { value: 'docs', count: 1 },
      { value: NONE, count: 1 },
    ]);
  });

  it('present mode treats "", null and missing alike', () => {
    const due = { field: 'due', mode: 'present' as const };
    assert.deepEqual(doc.items.map((it) => facetValues(it, due)[0]), [PRESENT, ABSENT, ABSENT, ABSENT, ABSENT]);
  });

  it('filters OR within a facet and AND across', () => {
    const specs = m.facets;
    const hits = (f: Record<string, string[]>) => doc.items.filter((it) => matchesFilter(it, specs, f)).map((it) => it.id);
    assert.deepEqual(hits({ labels: ['bug', 'docs'] }), ['1', '2', '5']);
    assert.deepEqual(hits({ labels: ['bug'], priority: ['high'] }), ['1']);
    assert.deepEqual(hits({}), ['1', '2', '3', '4', '5']);
  });
});

describe('decisions', () => {
  it('sets, clears back to the original, and reorders', () => {
    const raws = fixture('list.json');
    const m = resolveMapping(inferMapping(raws), { chaff: 1, buckets: { field: 'bucket', values: ['now', 'someday'] } });
    const doc = buildDocument(raws, raws.map((r) => String(r['id'])), m);
    const item3 = doc.items[2]!;
    assert.equal(effectiveBucket(doc, item3), 'someday', 'the input value stands until a decision');
    applyOp(doc, { op: 'bucket', ids: ['3', '1'], bucket: 'now' });
    assert.equal(effectiveBucket(doc, item3), 'now');
    assert.equal(effectiveBucket(doc, doc.items[0]!), 'now');
    applyOp(doc, { op: 'bucket', ids: ['3'], bucket: null });
    assert.equal(effectiveBucket(doc, item3), 'someday', 'clearing restores the input value');
    assert.equal(doc.decisions['3'], undefined);
    applyOp(doc, { op: 'note', ids: ['1'], note: 'hi' });
    assert.deepEqual(doc.decisions['1'], { bucket: 'now', note: 'hi' });
    applyOp(doc, { op: 'order', order: ['5', '4', 'nope'] });
    assert.deepEqual(doc.order, ['5', '4', '1', '2', '3'], 'unknown ids dropped, forgotten ids keep their order at the end');
  });
});

describe('compare', () => {
  it('sorts blanks last in both directions and numbers numerically', () => {
    const vals = ['b', '', 'a', null, 'c'];
    assert.deepEqual([...vals].sort((x, y) => compare(x, y)), ['a', 'b', 'c', '', null]);
    assert.deepEqual([...vals].sort((x, y) => compare(x, y, true)), ['c', 'b', 'a', '', null]);
    assert.deepEqual([10, 9, '', 100].sort((x, y) => compare(x, y)), [9, 10, 100, '']);
    assert.deepEqual(['x10', 'x9'].sort((x, y) => compare(x, y)), ['x9', 'x10'], 'numeric-aware strings');
  });

  it('applies --sort with desc keeping blanks last', () => {
    const raws = [{ id: 1, t: 'a', due: '' }, { id: 2, t: 'b', due: '2026-01-02' }, { id: 3, t: 'c', due: '2026-01-01' }];
    const m = resolveMapping(inferMapping(raws), { chaff: 1, sort: { field: 'due', desc: true } });
    assert.deepEqual(buildDocument(raws, ['1', '2', '3'], m).order, ['2', '3', '1']);
  });
});
