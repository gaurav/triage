// The keyboard map every view shares. Views call installKeys() once; the handler ignores keys
// typed into inputs, except Escape.
import * as S from './state.ts';

export interface KeyHelp {
  keys: string;
  does: string;
}

export const KEY_HELP: KeyHelp[] = [
  { keys: 'j / ↓, k / ↑', does: 'move' },
  { keys: '1 – 9', does: 'put the item (or the whole stack, or the selection) in that bucket, and move on' },
  { keys: 'd', does: 'put the item on a day, when the bucket field takes one: 2026-10-27, mon, next fri, +3, today; Enter moves on' },
  { keys: '0, ⌫', does: 'clear the bucket (restores what the input had)' },
  { keys: 'x', does: 'expand or collapse a stack of duplicates' },
  { keys: 'space', does: 'select / deselect; digits then apply to the selection' },
  { keys: 'Esc', does: 'clear the selection, leave the search box' },
  { keys: 'J / K', does: 'move the row up or down (changes the output order)' },
  { keys: 'n', does: 'write a note' },
  { keys: 'z', does: 'undo' },
  { keys: '/', does: 'search' },
  { keys: 'h', does: 'hide / show triaged items' },
  { keys: 'g', does: 'group the list by the next facet (and eventually by none)' },
  { keys: 'Enter', does: 'open the item’s link' },
  { keys: 'D', does: 'Done: write the file and quit' },
  { keys: '?', does: 'this help' },
];

export interface KeyHooks {
  focusSearch(): void;
  focusNote(): void;
  focusDay(): void;
  requestDone(): void;
}

export function installKeys(hooks: KeyHooks): () => void {
  const onKey = (e: KeyboardEvent) => {
    const target = e.target as HTMLElement | null;
    const typing = !!target && (target.tagName === 'TEXTAREA' || target.isContentEditable || (target.tagName === 'INPUT' && !/^(checkbox|radio|button|submit)$/.test((target as HTMLInputElement).type)));
    if (e.key === 'Escape') {
      if (typing) target!.blur();
      else if (S.helpOpen.value) S.helpOpen.value = false;
      else S.selected.value = new Set();
      return;
    }
    if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
    S.countKey();
    const k = e.key;
    if (k === 'j' || k === 'ArrowDown') S.moveCursor(1);
    else if (k === 'k' || k === 'ArrowUp') S.moveCursor(-1);
    else if (k === 'J') S.moveCursorRow(1);
    else if (k === 'K') S.moveCursorRow(-1);
    else if (k === 'PageDown') S.moveCursor(20);
    else if (k === 'PageUp') S.moveCursor(-20);
    else if (k === 'Home') S.moveCursor(-1e9);
    else if (k === 'End') S.moveCursor(1e9);
    else if (/^[1-9]$/.test(k)) {
      const b = S.buckets.value?.values[Number(k) - 1];
      if (b !== undefined) S.assign(b);
      else return;
    } else if (k === '0' || k === 'Backspace' || k === 'Delete') S.assign(null);
    else if (k === 'x') S.toggleExpand();
    else if (k === ' ') S.toggleSelect();
    else if (k === 'z') S.undo();
    else if (k === '/') hooks.focusSearch();
    else if (k === 'n') hooks.focusNote();
    else if (k === 'd') {
      if (S.buckets.value?.date) hooks.focusDay();
      else return;
    }
    else if (k === 'h') S.hideTriaged.value = !S.hideTriaged.value;
    else if (k === 'g') S.cycleGroupBy();
    else if (k === '?') S.helpOpen.value = !S.helpOpen.value;
    else if (k === 'D') hooks.requestDone();
    else if (k === 'Enter') {
      const url = S.cursorRow.value?.item.url;
      if (url) window.open(url, '_blank', 'noopener');
      else return;
    } else return;
    e.preventDefault();
  };
  window.addEventListener('keydown', onKey);
  return () => window.removeEventListener('keydown', onKey);
}
