// The detail pane: everything about one item, with HTML-looking strings sanitised.
import DOMPurify from 'dompurify';
import { useState } from 'preact/hooks';
import { facetValues, NONE } from '../../src/core/facets.ts';
import { asString, isEmpty, type Item } from '../../src/core/model.ts';
import { childLabel, formatDate, formatMinutes, looksLikeHtml, plural } from './format.ts';
import * as S from './state.ts';

export function Detail({ item, stackIds, noteRef }: { item: Item | null; stackIds: string[]; noteRef: { current: HTMLTextAreaElement | null } }) {
  const d = S.doc.value!;
  if (!item) return <aside class="detail empty">Nothing selected.</aside>;
  const m = d.mapping;
  const bucket = S.bucketOf(item);
  const shown = new Set<string>([m.id, m.title, ...(m.body ? [m.body] : []), ...(m.buckets ? [m.buckets.field] : []), ...(m.note ? [m.note] : []), ...(m.order ? [m.order] : [])]);
  const detailFields = m.detail.filter((f) => f !== m.body && !shown.has(f));
  for (const f of detailFields) shown.add(f);
  const rest = Object.keys(item.raw).filter((f) => !shown.has(f) && !isEmpty(item.raw[f]));
  return (
    <aside class="detail">
      <h2>{item.title || <span class="muted">(untitled)</span>}</h2>
      <div class="chips">
        {bucket !== undefined && <span class="chip bucket">{bucket}</span>}
        {stackIds.length > 1 && <span class="chip stack">×{stackIds.length} duplicates</span>}
        {item.priority && <span class="chip priority">{item.priority}</span>}
        {m.facets
          .filter((f) => f.mode === 'values' && f.field !== m.priority)
          .flatMap((f) =>
            facetValues(item, f)
              .filter((v) => v !== NONE && v !== 'false')
              .map((v) => (
                <span class="chip" key={f.field + v} title={f.field}>
                  {/^[\d.]+$/.test(v) || v === 'true' ? `${f.field} ${v}` : v}
                </span>
              )),
          )}
        {item.url && (
          <a class="chip link" href={item.url} target="_blank" rel="noopener">
            {new URL(item.url).hostname} ↗
          </a>
        )}
      </div>
      <dl class="dates">
        {Object.entries(item.dates).map(([slot, v]) => {
          const f = formatDate(v);
          return (
            <div key={slot}>
              <dt>{slot}</dt>
              <dd title={v}>
                {f.abs} <span class="muted">{f.rel}</span>
              </dd>
            </div>
          );
        })}
      </dl>
      {item.body && <Body text={item.body} />}
      {item.children.length > 0 && (
        <section>
          <h3>{plural(item.children.length, m.children ?? 'child')}</h3>
          <ul class="children">
            {item.children.map((c, i) => (
              <li key={i}>{childLabel(c)}</li>
            ))}
          </ul>
        </section>
      )}
      {m.note && <Note key={item.id} item={item} noteRef={noteRef} />}
      <dl class="fields">
        {detailFields.filter((f) => !isEmpty(item.raw[f])).map((f) => (
          <Field key={f} name={f} value={item.raw[f]} />
        ))}
      </dl>
      {rest.length > 0 && (
        <details>
          <summary>{plural(rest.length, 'more field')}</summary>
          <dl class="fields">
            {rest.map((f) => (
              <Field key={f} name={f} value={item.raw[f]} />
            ))}
          </dl>
        </details>
      )}
      <details>
        <summary>raw JSON</summary>
        <pre>{JSON.stringify(item.raw, null, 2)}</pre>
      </details>
    </aside>
  );
}

function Body({ text }: { text: string }) {
  if (looksLikeHtml(text)) {
    const html = DOMPurify.sanitize(text, { USE_PROFILES: { html: true }, ADD_ATTR: ['target'] });
    return <div class="body html" dangerouslySetInnerHTML={{ __html: html }} />;
  }
  return <div class="body">{text}</div>;
}

function Field({ name, value }: { name: string; value: unknown }) {
  let shown: preact.ComponentChildren;
  if (typeof value === 'string' && looksLikeHtml(value)) shown = <Body text={value} />;
  else if (Array.isArray(value)) shown = <ul class="children">{value.map((v, i) => <li key={i}>{childLabel(v)}</li>)}</ul>;
  else if (typeof value === 'object' && value !== null) shown = <pre>{JSON.stringify(value, null, 1)}</pre>;
  else if (/time|minutes|estimate|duration/i.test(name) && /^\d+$/.test(asString(value))) shown = formatMinutes(value);
  else if (typeof value === 'string' && /^https?:\/\//.test(value)) shown = <a href={value} target="_blank" rel="noopener">{value}</a>;
  else shown = asString(value);
  return (
    <div>
      <dt>{name}</dt>
      <dd>{shown}</dd>
    </div>
  );
}

// Keyed by item id by the caller, so a new item mounts a fresh textarea. An earlier version
// reset the text in an effect when the item changed, and a keystroke that landed before that
// effect ran was wiped out.
function Note({ item, noteRef }: { item: Item; noteRef: { current: HTMLTextAreaElement | null } }) {
  const [text, setText] = useState(S.noteOf(item) ?? '');
  return (
    <section class="note">
      <h3>note</h3>
      <textarea
        ref={(el) => {
          noteRef.current = el;
        }}
        value={text}
        rows={2}
        placeholder="n to write a note; Esc or click away to save"
        onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
        onBlur={() => S.setNote(item.id, text)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            (e.target as HTMLTextAreaElement).blur();
          }
        }}
      />
    </section>
  );
}
