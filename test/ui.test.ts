// Presentation helpers in ui/shared/ that need no DOM.
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { buildDocument } from '../src/core/document.ts';
import { inferMapping, resolveMapping } from '../src/core/infer.ts';
import { toItems, type Raw } from '../src/core/model.ts';
import { formatDate, miniChips, rowChipSpecs } from '../ui/shared/format.ts';

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')) as Raw[];

describe('priority slot', () => {
  it('drops values that mean no priority', () => {
    const raws = [
      { id: 1, t: 'a', priority: 'No priority' },
      { id: 2, t: 'b', priority: 'none' },
      { id: 3, t: 'c', priority: 'Normal' },
      { id: 4, t: 'd', priority: 'Urgent' },
      { id: 5, t: 'e', priority: 'P1' },
    ];
    const m = resolveMapping(inferMapping(raws), { chaff: 1, title: 't', priority: 'priority' });
    const items = toItems(raws, ['1', '2', '3', '4', '5'], m);
    assert.deepEqual(items.map((i) => i.priority), [undefined, undefined, undefined, 'Urgent', 'P1']);
  });
});

describe('row chips', () => {
  const raws = fixture('sunsama-like.json');
  const m = inferMapping(raws);
  const doc = buildDocument(raws, raws.map((r) => String(r['id'])), m);
  const sameTag = doc.items.find((i) => i.raw['channel'] === '#life' && i.raw['context'] === '#life')!;

  it('defaults to three value facets, not the priority field', () => {
    const specs = rowChipSpecs(m);
    assert.equal(specs.length, 3);
    assert.ok(specs.every((s) => s.mode === 'values' && s.field !== m.priority));
    assert.deepEqual(specs.map((s) => s.field), ['channel', 'context', 'objective']);
  });

  it('follows the mapping\'s chips when given', () => {
    const custom = resolveMapping(m, { chaff: 1, chips: ['channel', 'timeEstimate'] });
    assert.deepEqual(rowChipSpecs(custom).map((s) => s.field), ['channel', 'timeEstimate']);
    const chips = miniChips(sameTag, rowChipSpecs(custom));
    assert.equal(chips[0]![1], '#life');
    if (chips[1]) assert.match(chips[1][1], /^timeEstimate \d+$/, 'a bare number carries its field name');
  });

  it('does not repeat a value two facets agree on, and skips blanks and false', () => {
    const chips = miniChips(sameTag, rowChipSpecs(m));
    assert.deepEqual(chips.map(([, text]) => text).filter((t) => t === '#life'), ['#life'], 'channel and context both #life, shown once');
    const blank = { ...sameTag, raw: { ...sameTag.raw, channel: '', context: '', objective: '', sequenceStart: false } };
    assert.deepEqual(miniChips(blank, [...rowChipSpecs(m), { field: 'sequenceStart', mode: 'values' }]), []);
  });
});

describe('formatDate', () => {
  it('gives an absolute date and a relative age', () => {
    const now = new Date('2026-10-24T12:00:00Z');
    assert.deepEqual(formatDate('2026-10-24', now), { abs: '2026-10-24', rel: 'today' });
    assert.deepEqual(formatDate('2026-10-21T09:00:00Z', now), { abs: '2026-10-21', rel: '3 days ago' });
    assert.deepEqual(formatDate('2026-11-14', now), { abs: '2026-11-14', rel: 'in 3 weeks' });
    assert.deepEqual(formatDate('not a date', now), { abs: 'not a date', rel: '' });
  });
});
