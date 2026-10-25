# chaff

Triage any JSON or NDJSON list in your browser: stack duplicates, filter and group by any field,
put each item in a bucket with one keystroke, and get the decisions back as a file. Built so that
a script or a coding agent can call it as a step, and so that different triage UIs can be tried on
the same data and the same contract.

```sh
npx chaff tasks.json --assign bucket=keep,someday,chaff
```

That serves a page on localhost, opens it, autosaves every decision to `tasks.triaged.json`, and
exits when you press Done. Nothing in `tasks.json` is modified.

The name: the tool is for finding the chaff (duplicates, the expired, the long-lingering) so
the wheat stands out.

## Install

Node 22.18 or later. `npx chaff` runs it without installing; `npm install -g chaff` gives a
`chaff` command.

## What it takes

- A `.json` file holding an array of objects.
- A `.json` file holding an object whose values are objects; the keys are the ids.
- A `.ndjson` / `.jsonl` file, one object per line.
- `-` for stdin (then `--out` is required).
- A canonical file: `{"chaff": 1, "mapping": {...}, "items": [...]}`, which a tool that knows
  chaff can emit directly so no flags are needed.

chaff works out which field is the title, which are dates, which are worth a facet, and what to
stack duplicates on. `chaff inspect file.json` shows what it decided. If it is wrong,
`chaff inspect file.json --write-map` writes `file.chaff-map.json`, a small file you edit and
which chaff picks up on every later run; or pass flags, which override both.

```sh
chaff inspect data.json --write-map    # look, then edit data.chaff-map.json
chaff data.json --title summary --facet state,labels --facet closedAt:present
```

## What it writes

Only the fields you ask for are added to each item; everything else is copied through, and the
file keeps its shape (array, object, NDJSON).

| Flag | Writes |
| --- | --- |
| `--assign F=a,b,c` | `F` gets the bucket. The values get keys 1, 2, 3… Values already in `F` in the input count as buckets too. For a value with a comma, add `--bucket "Needed soon, really"`. |
| `--assign F=a,b,@date` | As above, and `d` puts an item on a day instead: `F` gets `2026-10-27`. Type the day, or `mon`, `next fri`, `+3`, `today`; Enter alone repeats the last day. A day and a named value are the same field, so an item has one or the other. |
| `--note F` | `F` gets a free-text note, written when you press `n`. |
| `--order F` | `F` gets the item's position in the final order, from 0. |

Clearing a bucket (`0`) restores whatever the input had, so a diff of output against input shows
exactly the decisions made. Items are written in the input order until you reorder or sort; after
that, in the order you see, with stacked duplicates following the first of their stack. An object
input keeps its key order whatever you do, because JavaScript puts integer-like keys first; use
`--order` to get positions out of one.

`--out FILE` chooses the output (`-` for stdout). An existing output is never overwritten:
`--resume` continues that session, `--force` starts over.

## Exit codes, streams, and calling it from a script

- `0`: Done was pressed and the file is written.
- `1`: bad input, flags or I/O (unparseable JSON, duplicate ids, a port in use). Nothing is served.
- `2`: interrupted (Ctrl-C, SIGTERM). The autosaved file is complete up to the last decision;
  run again with `--resume`.

Everything chatty, including the URL, goes to stderr. Stdout carries data, and only with `--out -`.
`--json-summary` prints the exit summary as one JSON line on stderr. `--no-open` (or
`BROWSER=false`) skips opening a browser; the URL is on stderr either way, and a failure to open
a browser is never fatal, so the command works over SSH and from an agent with no display.

The page can only be driven with a token that is in the URL chaff opens, and only from
`127.0.0.1`, so another page in your browser cannot press Done for you. The default port is
whatever is free; `--port N` pins one.

### If you are a coding agent

Get the list into a JSON file by whatever means you have (an MCP tool, `gh … --json`, an API),
then run chaff and wait for it to exit. The person does the triage; you read the result.

```sh
gh issue list --repo owner/repo --state open --limit 500 --json number,title,body,labels,milestone,url \
  > issues.json
chaff issues.json --title title --facet labels,milestone \
  --assign milestone="Needed soon","Needed later","Not urgent" \
  --out decisions.json --json-summary
# exit 0: decisions.json has a "milestone" on each issue the person placed; act on those.
```

Do not modify the input file while chaff runs, and treat exit 2 as "partial, resumable", not as
failure. `chaff inspect file.json` tells you what chaff will make of a file before you serve it.

## Using it

```
┌ facets ─────┬ items ──────────────────────────────────┬ detail ───────────────┐
│ bucket      │ ▸ Go through Slack messages      ×234   │ Prepare presentation  │
│  1 keep   40│   Prepare presentation       2 hr  !!   │ #work · 2 hr · Urgent │
│  2 someday  │ ▸ Weekly team meeting            ×23    │ created 2025-09-18    │
│  3 chaff    │   Check tyre pressure            ×9     │ notes (rendered)      │
│  0 (none)   │   ...                                   │ subtasks (3)          │
│ channel     │                                         │ note: ______          │
│ due present?│ j/k move · 1-9 bucket · x stack · / find│ raw JSON ▸            │
└─────────────┴─────────────────────────────────────────┴───────────────────────┘
```

- **Facets** on the left: click a value to filter (OR within a facet, AND across); counts update.
  "group" on a facet turns its values into sections of the list. Date and URL fields become a
  present/absent facet, which is how "done vs open" is filtered in a task export.
- **Stacks**: items whose normalised title matches collapse into one row with a count. A digit
  puts the whole stack in a bucket; `x` expands it so members can go separately.
- **Keys**: `j`/`k` move, `1`–`9` assign, `d` puts the item on a day, `0` clears, `space` selects
  several, `J`/`K` move a row, `n` note, `z` undo, `/` search, `h` hides what is already triaged, `g` groups by the next facet,
  `Enter` opens the item's link, `D` finishes, `?` lists them all.
- Shift-click a row to select it; clicking "group" twice turns grouping off.
- **Sort**, in the header, by title, any date, priority or a facet. Sorting changes the order
  that is written, not just the view, so what you saw is what the caller gets; "input order"
  puts it back.
- Each row shows up to three facet values as small chips. When two facets carry the same value
  (a Sunsama export's channel and context usually do) it is shown once; to choose the facets
  yourself, put `"chips": ["channel", "integration"]` in the sidecar.

## Trying other UIs

A view is a directory under `ui/` with a `main.tsx`, an `index.html` and a stylesheet; `--ui NAME`
serves it. Views share `ui/shared/state.ts` (the document, the filter, the cursor, undo, the sync
with the server) and `ui/shared/keys.ts` (one keyboard map), so a new view is presentation only.
`list` is the one that ships.

To compare views, run sessions with `--log events.ndjson`: every decision is logged with the view
name, a timestamp and the keystrokes and clicks since the previous decision. Then:

```
chaff report session-list.ndjson session-kanban.ndjson
```

prints items, changes, undos, keys, clicks, minutes, seconds per change and how much got triaged,
one row per log.

## What stays outside chaff

Scoring, ranking and near-duplicate detection. If a model or a script has an opinion, write it
into the input as a field (`score`, `cluster`, `similarTo`), and chaff will sort, facet or stack on
it; chaff itself is offline and has no model. The one built-in heuristic is exact-match stacking on
a normalised title, because that needs none.

## Roadmap

Second and third views (`kanban`, and a one-at-a-time `walk`) so the comparison tooling has
something to compare; editing the mapping inside the UI; an interactive mapping wizard;
rendering a `parent`/`children` hierarchy; writing `duplicateOf` when a stack member is merged
into another; adapters that emit canonical input for GitHub issues and milestones; a programmatic
API; a terminal UI. Each is an issue in this repository.

## Developing

```sh
npm install
npm test          # builds, then node --test over the .ts sources and the built CLI
npm run dev       # rebuild on change; then node dist/cli.js <file> --port 13972 --no-open --force
```

[CLAUDE.md](CLAUDE.md) has the layout and the things that are easy to get wrong.

## Licence

GPL-3.0.
