import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { applyOp } from '../src/core/decisions.ts';
import { buildDocument } from '../src/core/document.ts';
import { InputError, parseDataset, resolveIds } from '../src/node/load.ts';
import { buildMapping, flagsToMapping } from '../src/node/mapping.ts';
import { AtomicWriter, orderedIds, serialise, summary } from '../src/node/write.ts';

const read = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

function docFor(name: string, flags: Parameters<typeof flagsToMapping>[0] = {}) {
  const ds = parseDataset(read(name), { path: name });
  const { mapping } = buildMapping(ds, { flags });
  const ids = resolveIds(ds, mapping.id);
  return { ds, mapping, doc: buildDocument(ds.items, ids, mapping) };
}

describe('parseDataset', () => {
  it('detects array, dict, ndjson and canonical', () => {
    assert.equal(parseDataset(read('list.json')).shape, 'array');
    const dict = parseDataset(read('dict.json'));
    assert.equal(dict.shape, 'dict');
    assert.deepEqual(dict.keys, ['10', 'alpha', 'beta'], 'JavaScript puts integer-like keys first; the README says so');
    const nd = parseDataset(read('items.ndjson'), { path: 'items.ndjson' });
    assert.equal(nd.shape, 'ndjson');
    assert.equal(nd.items.length, 3, 'blank lines are skipped');
    const canon = parseDataset(read('canonical.json'));
    assert.equal(canon.shape, 'canonical');
    assert.equal(canon.mapping?.title, 'summary');
  });

  it('accepts NDJSON on stdin without an extension', () => {
    assert.equal(parseDataset(read('items.ndjson')).shape, 'ndjson');
  });

  it('rejects scalars and non-object members', () => {
    assert.throws(() => parseDataset('42'), InputError);
    assert.throws(() => parseDataset('[1,2]'), /item 0 is not an object/);
    assert.throws(() => parseDataset('{"a": 1}'), /not an object/);
  });
});

describe('resolveIds', () => {
  it('uses dict keys, a field, or the index', () => {
    const dict = parseDataset(read('dict.json'));
    assert.deepEqual(resolveIds(dict, 'anything'), ['10', 'alpha', 'beta']);
    const list = parseDataset(read('list.json'));
    assert.deepEqual(resolveIds(list, 'id'), ['1', '2', '3', '4', '5']);
    assert.deepEqual(resolveIds(list, 'index'), ['0', '1', '2', '3', '4']);
  });

  it('refuses duplicate and missing ids', () => {
    const dup = parseDataset('[{"id":1},{"id":1}]');
    assert.throws(() => resolveIds(dup, 'id'), /share the id "1"/);
    const missing = parseDataset('[{"id":1},{"x":2}]');
    assert.throws(() => resolveIds(missing, 'id'), /item 1 has no "id"/);
  });
});

describe('flagsToMapping', () => {
  it('parses --assign and --bucket', () => {
    assert.deepEqual(flagsToMapping({ assign: 'bucket=now,later' }).buckets, { field: 'bucket', values: ['now', 'later'] });
    assert.deepEqual(flagsToMapping({ assign: 'milestone', bucket: ['Needed soon, really', 'Later'] }).buckets, { field: 'milestone', values: ['Needed soon, really', 'Later'] });
    assert.throws(() => flagsToMapping({ bucket: ['x'] }), /--assign FIELD/);
    assert.deepEqual(flagsToMapping({ facet: ['a', 'b:present'] }).facets, ['a', { field: 'b', mode: 'present' }]);
    assert.deepEqual(flagsToMapping({ sort: 'due:desc' }).sort, { field: 'due', desc: true });
  });

  it('adds bucket values already present in the input', () => {
    const { mapping } = docFor('list.json', { assign: 'bucket=now' });
    assert.deepEqual(mapping.buckets?.values, ['now', 'someday']);
  });
});

describe('serialise', () => {
  it('round-trips an array unchanged when nothing was decided, except for order fields', () => {
    const { ds, doc } = docFor('list.json');
    assert.deepEqual(JSON.parse(serialise(ds, doc)), JSON.parse(read('list.json')));
  });

  it('writes bucket, note and order, keeps every other field, and follows the UI order', () => {
    const { ds, doc } = docFor('list.json', { assign: 'bucket=now,later', note: 'why', order: 'pos' });
    applyOp(doc, { op: 'bucket', ids: ['5'], bucket: 'now' });
    applyOp(doc, { op: 'note', ids: ['5'], note: 'first!' });
    applyOp(doc, { op: 'order', order: ['5', '1', '2', '3', '4'] });
    const out = JSON.parse(serialise(ds, doc)) as Record<string, unknown>[];
    // 5 is stacked with 3 ("write docs"), so 3 follows 5; 1 and 2 are a stack too.
    assert.deepEqual(out.map((r) => r['id']), [5, 3, 1, 2, 4]);
    assert.deepEqual(out.map((r) => r['pos']), [0, 1, 2, 3, 4]);
    assert.equal(out[0]!['bucket'], 'now');
    assert.equal(out[0]!['why'], 'first!');
    assert.equal(out[1]!['bucket'], 'someday', 'an undecided item keeps its input value');
    assert.equal(out[2]!['bucket'], undefined, 'no key is invented for undecided items');
    assert.deepEqual(out[2]!['labels'], ['bug', 'auth']);
    const s = summary(doc);
    assert.deepEqual(s, { total: 5, triaged: 2, untriaged: 3, buckets: { now: 1, later: 0, someday: 1 }, noted: 1 });
  });

  it('keeps stack members together once the order changes, and only when stacking is on', () => {
    const on = docFor('list.json');
    assert.deepEqual(orderedIds(on.doc), ['1', '2', '3', '4', '5'], 'untouched: input order');
    applyOp(on.doc, { op: 'order', order: ['5', '4', '1', '2', '3'] });
    assert.deepEqual(orderedIds(on.doc), ['5', '3', '4', '1', '2']);
    const off = docFor('list.json', { noStack: true });
    applyOp(off.doc, { op: 'order', order: ['5', '4', '1', '2', '3'] });
    assert.deepEqual(orderedIds(off.doc), ['5', '4', '1', '2', '3']);
  });

  it('writes dict, ndjson and canonical in their own shapes', () => {
    const dict = docFor('dict.json', { assign: 'state=open,closed' });
    applyOp(dict.doc, { op: 'bucket', ids: ['alpha'], bucket: 'closed' });
    const dOut = JSON.parse(serialise(dict.ds, dict.doc)) as Record<string, Record<string, unknown>>;
    assert.deepEqual(Object.keys(dOut), ['10', 'alpha', 'beta']);
    assert.equal(dOut['alpha']!['state'], 'closed');

    const nd = docFor('items.ndjson', { assign: 'b=x' });
    applyOp(nd.doc, { op: 'bucket', ids: ['b'], bucket: 'x' });
    const lines = serialise(nd.ds, nd.doc).trimEnd().split('\n');
    assert.equal(lines.length, 3);
    assert.deepEqual(lines.map((l) => (JSON.parse(l) as { id: string }).id), ['a', 'b', 'c'], 'untouched order');
    assert.equal((JSON.parse(lines[1]!) as { b: string }).b, 'x');

    const canon = docFor('canonical.json');
    assert.deepEqual(canon.mapping.buckets, { field: 'decision', values: ['keep', 'drop'] }, 'the mapping in the file is used');
    applyOp(canon.doc, { op: 'bucket', ids: ['k1'], bucket: 'drop' });
    const cOut = JSON.parse(serialise(canon.ds, canon.doc)) as { chaff: number; mapping: { title: string }; items: { decision?: string }[] };
    assert.equal(cOut.chaff, 1);
    assert.equal(cOut.mapping.title, 'summary');
    assert.deepEqual(cOut.items.map((i) => i.decision), ['drop', 'keep']);
  });
});

describe('AtomicWriter', () => {
  const dir = mkdtempSync(join(tmpdir(), 'chaff-test-'));
  after(() => rmSync(dir, { recursive: true, force: true }));

  it('coalesces scheduled writes and flushes the latest content', async () => {
    const path = join(dir, 'out.json');
    const w = new AtomicWriter(path, 50);
    w.schedule('one');
    w.schedule('two');
    w.schedule('three');
    await w.flush();
    assert.equal(readFileSync(path, 'utf8'), 'three');
    assert.equal(w.writes, 1);
    w.schedule('four');
    await w.close();
    assert.equal(readFileSync(path, 'utf8'), 'four');
    assert.equal(w.writes, 2);
  });
});
