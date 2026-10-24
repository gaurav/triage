// The `list` view: facets on the left, a dense virtualised list in the middle, detail on the
// right. Keyboard first; see ui/shared/keys.ts.
import { render } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { ABSENT, NONE, PRESENT } from '../../src/core/facets.ts';
import type { FacetSpec, Item } from '../../src/core/model.ts';
import { Detail } from '../shared/Detail.tsx';
import { formatDate, miniChips, plural, rowChipSpecs } from '../shared/format.ts';
import { installKeys, KEY_HELP } from '../shared/keys.ts';
import * as S from '../shared/state.ts';

const ROW_H = 30;
const HEADER_H = 26;

function App() {
  const searchRef = useRef<HTMLInputElement>(null);
  const noteRef = useRef<HTMLTextAreaElement | null>(null);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    S.load();
    const onClick = () => S.countClick();
    window.addEventListener('click', onClick, true);
    const off = installKeys({
      focusSearch: () => searchRef.current?.focus(),
      focusNote: () => noteRef.current?.focus(),
      requestDone: () => requestDone(),
    });
    return () => {
      off();
      window.removeEventListener('click', onClick, true);
    };
  }, []);

  const requestDone = () => {
    const s = S.summary.value;
    if (s && S.buckets.value && s.untriaged > 0) setConfirming(true);
    else S.done();
  };

  if (S.loadError.value) return <main class="center">Could not load the session: {S.loadError.value}</main>;
  const d = S.doc.value;
  if (!d) return <main class="center">loading…</main>;
  if (S.finished.value) return <Finished />;
  const cursorRow = S.cursorRow.value;
  const cursorItem = cursorRow?.item ?? null;
  const stackIds = cursorRow?.stackKey ? S.stacks.value.stacks.get(cursorRow.stackKey)!.ids : cursorItem ? [cursorItem.id] : [];

  return (
    <div class="app">
      <Header onDone={requestDone} />
      <Sidebar searchRef={searchRef} />
      <List />
      <Detail item={cursorItem} stackIds={stackIds} noteRef={noteRef} />
      {S.helpOpen.value && <Help />}
      {confirming && (
        <div class="modal" onClick={() => setConfirming(false)}>
          <div class="dialog" onClick={(e) => e.stopPropagation()}>
            <p>{plural(S.summary.value?.untriaged ?? 0, 'item')} still in no bucket. Finish anyway?</p>
            <p class="muted">They keep whatever the input had; you can run again with --resume.</p>
            <div class="row">
              <button onClick={() => setConfirming(false)}>Keep going</button>
              <button class="primary" onClick={() => { setConfirming(false); S.done(); }}>Finish</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Header({ onDone }: { onDone: () => void }) {
  const s = S.summary.value;
  const m = S.meta.value;
  const total = s?.total ?? 0;
  const triaged = s?.triaged ?? 0;
  const pct = total ? Math.round((100 * triaged) / total) : 0;
  const visible = S.visibleItems.value.length;
  const save = S.saveState.value;
  return (
    <header>
      <span class="brand" title={`chaff ${m?.version ?? ''}`}>chaff</span>
      <span class="file" title={m?.input}>{m?.input.split('/').pop()}</span>
      <span class="counts">
        {visible === total ? plural(total, 'item') : `${visible} of ${plural(total, 'item')}`}
        {S.selected.value.size > 0 && <span class="sel"> · {S.selected.value.size} selected</span>}
      </span>
      {S.buckets.value && (
        <span class="progress" title={`${triaged} of ${total} in a bucket`}>
          <span class="bar"><span style={{ width: `${pct}%` }} /></span>
          <span>{triaged}/{total}</span>
        </span>
      )}
      <SortControl />
      <span class={`save ${save}`} title={S.saveError.value ?? m?.out}>
        {save === 'saved' ? 'saved' : save === 'saving' ? 'saving…' : `not saved: ${S.saveError.value}`}
      </span>
      <button class="ghost" onClick={() => S.undo()} disabled={!S.canUndo.value} title="z">undo</button>
      <button class="ghost" onClick={() => (S.helpOpen.value = !S.helpOpen.value)} title="?">?</button>
      <button class="primary" onClick={onDone} title="D">Done</button>
    </header>
  );
}

/** Sorting changes the order that is written, not just the view, so a caller gets what was seen. */
function SortControl() {
  const d = S.doc.value!;
  const m = d.mapping;
  const options: [string, string][] = [['', 'input order'], [m.title, `title (${m.title})`]];
  for (const [slot, field] of Object.entries(m.dates)) options.push([field, `${slot} (${field})`]);
  if (m.priority) options.push([m.priority, `priority (${m.priority})`]);
  for (const f of m.facets) if (f.mode === 'values' && !options.some(([v]) => v === f.field)) options.push([f.field, f.field]);
  const sort = S.sort.value;
  return (
    <span class="sort" title="sort; changes the order written to the output">
      <select value={sort?.field ?? ''} onChange={(e) => S.setSort((e.target as HTMLSelectElement).value || null)}>
        {options.map(([v, label]) => (
          <option key={v} value={v}>{label}</option>
        ))}
      </select>
      {sort && (
        <button class="ghost small" onClick={() => S.setSort(sort.field, !sort.desc)} title="flip direction">
          {sort.desc ? '↓' : '↑'}
        </button>
      )}
    </span>
  );
}

function Sidebar({ searchRef }: { searchRef: { current: HTMLInputElement | null } }) {
  const specs = S.facetSpecs.value;
  const active = Object.keys(S.filter.value).length > 0 || S.query.value || S.hideTriaged.value;
  return (
    <nav class="facets">
      <input
        ref={searchRef}
        type="search"
        placeholder="search  /"
        value={S.query.value}
        onInput={(e) => (S.query.value = (e.target as HTMLInputElement).value)}
      />
      <div class="toggles">
        {S.buckets.value && (
          <label>
            <input type="checkbox" checked={S.hideTriaged.value} onChange={(e) => (S.hideTriaged.value = (e.target as HTMLInputElement).checked)} /> hide triaged <kbd>h</kbd>
          </label>
        )}
        {active && <button class="ghost small" onClick={S.clearFilters}>clear filters</button>}
      </div>
      {specs.map((spec) => (
        <Facet key={spec.field} spec={spec} />
      ))}
    </nav>
  );
}

function Facet({ spec }: { spec: FacetSpec }) {
  const [more, setMore] = useState(false);
  const counts = S.countsFor(spec);
  const selectedVals = S.filter.value[spec.field] ?? [];
  const isBucket = spec.field === S.BUCKET_FACET;
  const bucketKeys = S.buckets.value?.values ?? [];
  const limit = more ? counts.length : 8;
  const grouped = S.groupBy.value === spec.field;
  if (!counts.length) return null;
  return (
    <section class={`facet ${isBucket ? 'bucket-facet' : ''}`}>
      <h3>
        <span>{spec.label ?? spec.field}{spec.mode === 'present' && <span class="muted"> present?</span>}</span>
        <button class={`ghost tiny ${grouped ? 'on' : ''}`} title="group the list by this" onClick={() => (S.groupBy.value = grouped ? null : spec.field)}>
          group
        </button>
      </h3>
      <ul>
        {counts.slice(0, limit).map(({ value, count }) => {
          const on = selectedVals.includes(value);
          const keyIndex = isBucket ? bucketKeys.indexOf(value) : -1;
          return (
            <li key={value} class={`${on ? 'on' : ''} ${count === 0 ? 'zero' : ''}`} onClick={() => S.toggleFacet(spec.field, value)}>
              {isBucket && <kbd>{value === NONE ? '0' : keyIndex < 9 ? keyIndex + 1 : '·'}</kbd>}
              <span class="val">{label(value)}</span>
              <span class="n">{count}</span>
            </li>
          );
        })}
      </ul>
      {counts.length > 8 && (
        <button class="ghost tiny" onClick={() => setMore(!more)}>
          {more ? 'fewer' : `${counts.length - 8} more`}
        </button>
      )}
    </section>
  );
}

function label(v: string): string {
  return v === NONE ? '(none)' : v === PRESENT ? 'yes' : v === ABSENT ? 'no' : v;
}

function List() {
  const rows = S.rows.value;
  const ref = useRef<HTMLDivElement>(null);
  const [scroll, setScroll] = useState(0);
  const [height, setHeight] = useState(600);
  useLayoutEffect(() => {
    const el = ref.current!;
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el);
    setHeight(el.clientHeight);
    return () => ro.disconnect();
  }, []);
  // Row offsets (headers are shorter than items).
  const offsets: number[] = new Array(rows.length + 1);
  offsets[0] = 0;
  rows.forEach((r, i) => (offsets[i + 1] = offsets[i]! + (r.kind === 'header' ? HEADER_H : ROW_H)));
  const total = offsets[rows.length] ?? 0;
  let start = lowerBound(offsets, scroll) - 1;
  if (start < 0) start = 0;
  let end = lowerBound(offsets, scroll + height) + 1;
  if (end > rows.length) end = rows.length;
  start = Math.max(0, start - 5);
  end = Math.min(rows.length, end + 5);

  // Keep the cursor in view.
  const cursorKey = S.cursor.value;
  useEffect(() => {
    const el = ref.current;
    if (!el || cursorKey === null) return;
    const i = S.itemRowIndex.value.get(cursorKey);
    if (i === undefined) return;
    const top = offsets[i]!;
    const bottom = offsets[i + 1]!;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (bottom > el.scrollTop + el.clientHeight) el.scrollTop = bottom - el.clientHeight;
  }, [cursorKey, rows]);

  if (!rows.length) {
    return (
      <div class="list empty" ref={ref}>
        <p>Nothing matches. <button class="ghost" onClick={S.clearFilters}>clear filters</button></p>
      </div>
    );
  }
  return (
    <div class="list" ref={ref} onScroll={(e) => setScroll((e.target as HTMLDivElement).scrollTop)}>
      <div style={{ height: `${total}px`, position: 'relative' }}>
        {rows.slice(start, end).map((r, k) => {
          const i = start + k;
          const style = { position: 'absolute', top: `${offsets[i]}px`, left: 0, right: 0, height: `${r.kind === 'header' ? HEADER_H : ROW_H}px` } as const;
          if (r.kind === 'header') {
            return (
              <div class="group-header" key={r.key} style={style}>
                {label(r.label)} <span class="n">{r.count}</span>
              </div>
            );
          }
          return <Row key={r.key} row={r} style={style} />;
        })}
      </div>
    </div>
  );
}

function lowerBound(arr: number[], x: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid]! < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function Row({ row, style }: { row: Extract<S.Row, { kind: 'item' }>; style: Record<string, string | number> }) {
  const item = row.item;
  const d = S.doc.value!;
  const bucket = S.bucketOf(item);
  const isCursor = S.cursor.value === row.key;
  const isSelected = S.selected.value.has(item.id);
  const due = item.dates.due ? formatDate(item.dates.due) : null;
  const chips = rowChipSpecs(d.mapping);
  return (
    <div
      class={`row ${isCursor ? 'cursor' : ''} ${isSelected ? 'selected' : ''} ${row.member ? 'member' : ''} ${bucket !== undefined ? 'triaged' : ''}`}
      style={style}
      onClick={(e) => {
        if (e.shiftKey || e.metaKey) S.toggleSelect(item.id);
        else S.cursor.value = row.key;
      }}
    >
      <span class="stackmark" onClick={(e) => { e.stopPropagation(); if (row.stackKey) S.toggleExpand(row.stackKey); }} title={row.stackKey ? 'x to expand' : ''}>
        {row.stackKey && !row.member ? (row.expanded ? '▾' : '▸') : row.member ? '·' : ''}
      </span>
      <span class="title">{item.title || <span class="muted">(untitled) {truncate(JSON.stringify(item.raw), 60)}</span>}</span>
      {row.size && row.size > 1 && !row.member && <span class="size">×{row.size}</span>}
      {item.priority && <span class={`prio p-${slug(item.priority)}`}>{item.priority}</span>}
      {due && <span class={`due ${due.rel.endsWith('ago') && !item.dates.completed ? 'late' : ''}`} title={`due ${due.abs}`}>{due.rel}</span>}
      {miniChips(item, chips).map(([field, text]) => (
        <span class="mini" key={field} title={field}>{text}</span>
      ))}
      {bucket !== undefined && <span class={`badge b-${slug(bucket)}`}>{bucket}</span>}
    </div>
  );
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-');
}
function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function Help() {
  return (
    <div class="modal" onClick={() => (S.helpOpen.value = false)}>
      <div class="dialog help" onClick={(e) => e.stopPropagation()}>
        <h2>Keys</h2>
        <table>
          {KEY_HELP.map((k) => (
            <tr key={k.keys}>
              <td><kbd>{k.keys}</kbd></td>
              <td>{k.does}</td>
            </tr>
          ))}
        </table>
        <p class="muted">Click a facet value to filter; shift-click a row to select it; "group" on a facet turns its values into sections.</p>
      </div>
    </div>
  );
}

function Finished() {
  const s = S.finished.value!;
  const m = S.meta.value;
  return (
    <main class="center">
      <h1>Done</h1>
      <p>{s.triaged} of {s.total} in a bucket{s.noted ? `, ${s.noted} with notes` : ''}.</p>
      {Object.keys(s.buckets).length > 0 && (
        <ul class="plain">
          {Object.entries(s.buckets).map(([k, n]) => (
            <li key={k}><b>{k}</b> {n}</li>
          ))}
        </ul>
      )}
      <p class="muted">Written to <code>{m?.out}</code>. chaff has exited; you can close this tab.</p>
    </main>
  );
}

render(<App />, document.getElementById('app')!);
