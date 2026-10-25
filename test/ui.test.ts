// Presentation helpers in ui/shared/ that need no DOM.
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { buildDocument } from '../src/core/document.ts';
import { inferMapping, resolveMapping } from '../src/core/infer.ts';
import { toItems, type Raw } from '../src/core/model.ts';
import { parseDayInput, toDay } from '../ui/shared/dates.ts';
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

  it('keeps a bare day as that day whatever the timezone', () => {
    // '2026-10-24' parses as local midnight; toISOString would move it to the 23rd east of UTC.
    assert.equal(formatDate('2026-10-24').abs, '2026-10-24');
    assert.equal(formatDate('2026-10-26', new Date(2026, 9, 24, 23, 30)).rel, 'in 2 days', 'calendar days, not rounded hours');
    assert.equal(toDay(new Date(2026, 0, 5)), '2026-01-05');
  });
});

describe('parseDayInput', () => {
  const sat = new Date(2026, 9, 24, 15, 30); // Saturday 24 October 2026, local time
  const p = (s: string) => parseDayInput(s, sat);

  it('reads a written day, and rejects one that does not exist', () => {
    assert.equal(p('2026-10-27'), '2026-10-27');
    assert.equal(p(' 2026-10-27 '), '2026-10-27');
    assert.equal(p('2026-02-30'), null);
    assert.equal(p('27/10/2026'), null);
  });

  it('counts from today', () => {
    assert.equal(p('today'), '2026-10-24');
    assert.equal(p('tomorrow'), '2026-10-25');
    assert.equal(p('+3'), '2026-10-27');
    assert.equal(p('10'), '2026-11-03');
  });

  it('finds the next weekday, never today, and "next" skips a week', () => {
    assert.equal(p('mon'), '2026-10-26');
    assert.equal(p('Monday'), '2026-10-26');
    assert.equal(p('sat'), '2026-10-31', 'the coming Saturday, not today');
    assert.equal(p('next mon'), '2026-11-02');
    assert.equal(p('fri'), '2026-10-30');
  });

  it('says no to anything else', () => {
    assert.equal(p(''), null);
    assert.equal(p('soon'), null);
    assert.equal(p('x'), null);
  });
});
