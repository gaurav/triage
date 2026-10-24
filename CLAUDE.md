# Working on chaff

chaff is an npm CLI (`npx chaff file.json`) that serves a browser UI for triaging a JSON or
NDJSON list into buckets and writes the decisions to a separate file. The repository's purpose is
to try different triage UIs on the same data and the same contract; the README has the contract.

## Layout

- `src/core/` is browser-safe and bundled into every view. No `node:` imports: `build.mjs` fails
  the UI build if one appears. `model.ts` (types, `toItems`, effective bucket/note), `infer.ts`
  (mapping heuristics), `facets.ts`, `stacks.ts`, `decisions.ts`, `document.ts`.
- `src/node/` is the CLI side: `load.ts` (shape detection, id validation), `mapping.ts` (sidecar
  and flags), `write.ts` (shape-preserving output, `AtomicWriter`, `orderedIds`, `summary`),
  `server.ts` (node:http, token-guarded `/api/*`), `browser.ts`.
- `ui/shared/` is what views share: `state.ts` holds every signal, derived value and action;
  `keys.ts` the keyboard map; `Detail.tsx` the detail pane. `ui/<name>/main.tsx` is a view;
  adding one is adding a directory. The server serves `dist/ui/<name>/`.
- Tests run with `node --test` on the `.ts` sources (Node strips types; keep syntax erasable,
  `tsconfig` enforces it). `test/cli.test.ts` drives the built `dist/cli.js` over HTTP, so
  `npm test` builds first.

## Things that are easy to get wrong

- Clearing a bucket means deleting the decision, which restores the input's own value. There is
  no way to blank a value the input had; that is deliberate, so output minus input is decisions.
- Output order is the input order until the user reorders or sorts (`orderedIds`). After that,
  stacked duplicates follow the first of their stack. Regrouping stacks in an untouched session
  made diffs noisy for no decision, so don't.
- Dict output cannot follow the UI order: JavaScript puts integer-like keys first. `--order` is
  the way to get positions out.
- `fetch()` in Node drops a custom `Host` header, so the Host check test uses `node:http`.
- Inference scores priority fields by `filled * (1 - topShare)`: a field that is filled on every
  row with the same value is noise (Sunsama's `backlogPriority`).
- `--out` is flushed once before the URL is printed, so the file exists when a caller sees the
  URL; later writes are debounced through one `AtomicWriter`.
- A test that spawns the CLI must kill the child on failure (see `children` in `cli.test.ts`),
  or the test process never exits and the failure is reported as a cancelled file.
- The Note component is keyed by item id. Resetting its text in an effect lost the first
  keystroke typed before the effect ran.
- Real Sunsama exports are personal and live in the gitignored `data/`. The committed fixture is
  synthetic: `node test/fixtures/make-sunsama-like.mjs` regenerates it.

## Checking a UI change

`npm run dev` watches; run `node dist/cli.js <file> --port 13972 --no-open --force` and reload.
Playwright is not a dependency here; the prcoder checkout next door has it, and a short script
that opens the URL, presses keys and screenshots is the quickest check (see the commit messages
on the list view for what was checked).
