# Working with Sunsama tasks

chaff was built against a Sunsama export, and the first real job it did was triaging a Sunsama
Archive through Sunsama's MCP server. This page is what that took: the shape of the data, the
tools, and the recipe, so the next pass does not rediscover it.

## The export

Sunsama's export is one JSON array; a real one lives in the gitignored `data/sunsama/`, and
`test/fixtures/sunsama-like.json` is a synthetic stand-in (`node test/fixtures/make-sunsama-like.mjs`
regenerates it). Things that are not obvious from the field names:

- `id` is the task's Mongo id, the same `_id` the MCP server uses, so the two join directly.
- `startDate` is the day the task currently sits on. It moves every time a task rolls over, so
  for a stale task it is the last day it rolled to, not when it was planned.
- `startDate` and `completedDate` both blank means Backlog or Archive; the export does not say
  which. The MCP server does (`isBacklogged`, `isArchived`).
- `timeEstimate` is minutes. `channel` and `context` carry the same value.
- `backlogPriority` is filled on every row with the same value, which is why inference ignores it.
- Standing recurrences (the templates behind "every Monday") are not in the export. A filtered
  export may also lack the integration URLs; the MCP record has them under `integrationDetails`.

### Filtering an export before reading it

Keep each export in its own folder, `data/sunsama/<export day>/`, and before anyone (or any
agent) reads it, take the Google document links out:

```sh
python3 -I docs/sunsama/filter-export.py data/sunsama/2026-10-31/sunsama-data-export-…-2026-10-31T06-27-15.json
```

That writes `sunsama-exports-filtered-2026oct31.json` and `sunsama-urls.json` next to the export
and prints only counts. Work from the filtered copy from then on; an agent should not open the
raw export, nor look the tasks up through the MCP server to learn about them. The filtered copy
keeps the export's layout (one task per line), so it diffs line by line against the raw one.

- Every Google URL goes: `google.com`, its country domains, the short links `goo.gl`,
  `forms.gle` and `g.co`, and their subdomains, with or without `https://`. Google Scholar stays,
  as it is not a document. A link in the notes goes whole when its text is the URL and keeps its
  text otherwise; a URL in a title is cut out with the `()` around it, which can leave a title
  like "Look through "; a `url` field that is only a Google URL becomes null and a `website`
  attachment to one is dropped.
- `sunsama-urls.json` is every http(s) URL left, with its `domain`, `count` (mentions; a link
  counts once, though its URL is in `href`, `text=` and the link text) and `tasks` (tasks, with
  their subtasks, that mention it), most mentioned first.
- `--out` and `--urls` choose other paths. `test/sunsama.test.ts` runs the script on a synthetic
  export.

## Archive and Backlog

The Backlog is the "someday" list: no day, a time bucket (next two weeks … never), optional
folders. The Archive is where a task goes after rolling over unfinished for N consecutive days
(a setting on the archive panel). A task leaves the Archive by being put on a day or into the
Backlog. Recurrences get archived too: every occurrence of a recurring task is its own task
record, and an occurrence that was edited (time logged, notes, subtasks) is kept on rollover
instead of being replaced by the next one, so the Archive accumulates stale occurrences of the
same series ("Catch up on incoming" × 9). Those stack in chaff on their title. The MCP records
mark them `isStandingRecurrence: true` and carry the `recurrenceRule`.

## The MCP server

Sunsama's server is `https://api.sunsama.com/mcp` (HTTP, OAuth). For this repo:

```sh
cp .mcp.json.default .mcp.json      # project scope; .mcp.json is gitignored
# or, for this checkout only:
claude mcp add --transport http Sunsama https://api.sunsama.com/mcp
```

then `/mcp` to sign in. Tools added to a running session do not appear until the session is
restarted (`claude --resume`). Sunsama's help pages do not list the tools; the ones that matter:

| Tool | Notes |
| --- | --- |
| `get_archived_tasks(offset)` | Pages of 15–20. **Paging is unreliable**: windows overlap and some archived tasks never appear at any offset, so sweep offsets a few apart, union by `_id`, and check anything you expect but did not see with `get_task_by_id`. **`totalTasks` overcounts**: it reported 205 for an Archive that held 142, and 63 once the app's Archive panel was empty, so it evidently counts deleted records too. The app's Archive panel (Shift+A) is the ground truth for "is it empty". `search_tasks` does not surface archived tasks. |
| `get_backlog_tasks(page, queryId)` | Backlog pages; later pages need the `queryId` from page 0. |
| `get_task_by_id(taskId)` | One task with `integrationDetails`; the reliable way to confirm `isArchived`. |
| `search_tasks(searchTerm?)` | 20 most recently modified tasks, no paging; useful to see what moved today. |
| `unarchive_task(taskId, calendarDay, sortOrder?)` | Out of the Archive and onto a day. Without `sortOrder` the task lands at the top of that day; read the day first (`sunsama://tasks/{day}`) and pass the day's largest `sortOrder` plus 2048·n to append below what is already planned. Moving to a day before Sunsama's today may auto-complete the task; Sunsama's day rolls at local midnight, so after midnight "today" is tomorrow's date. One call in ~140 failed with `Service Unavailable`; a retry succeeded. |
| `move_task_to_backlog(taskId)` | Out of the Archive into the Backlog (`unarchive_task` says it does this without a day, but its schema requires one). |
| `mark_task_as_completed(taskId)` | For a task that turns out to be done; `mark_task_as_incomplete` undoes it. |
| `move_task_to_day` | For tasks that are not archived. |
| `delete_task(taskId)` / `restore_task(taskId)` | Soft delete of one task record and its undo. |
| `delete_incomplete_recurring_tasks` | **Never for archive triage.** It terminates the whole series, irreversibly. |

Read-only tools are safe to call freely. Treat everything else as one-at-a-time until a read-back
confirms it did what you meant.

## The recipe

1. **Collect.** Call `get_archived_tasks` at offsets a few apart until the union stops growing,
   then `get_task_by_id` for candidates from the export (incomplete, recently rolled over) that
   never appeared. Save each response as a JSON file.
2. **Build the list.** `docs/sunsama/build-archive.py out.json page*.json --export export.json`
   (`test/sunsama.test.ts` runs it on a synthetic page and reads the result with the sidecar)
   dedupes by `_id`, merges the export's notes and subtasks, and asks `gh` whether each linked
   GitHub issue or PR is open, closed or merged (`githubState`). It judges nothing; the states are
   facets.
3. **Triage.** `chaff out.json --map docs/sunsama/archive.chaff-map.json --out decisions.json`.
   The sidecar sets the buckets to `skip` (leave it archived), `backlog`, `complete`, `delete`
   or a day (`d`), a `comment` note, facets for category, channel, service, `githubState` and
   `recurring`, and chips. Delete is for the rare case, typically a task whose issue is already
   closed; a task that is probably done still gets a day so it is verified before it is closed,
   and `complete` is for one that is known to be done.
4. **Apply.** Read `decisions.json`. For each day, `unarchive_task` one task, read it back, then
   the rest; `move_task_to_backlog` for `backlog` and `mark_task_as_completed` for `complete`,
   the same way (those two paths are written from the tool descriptions; the first pass used
   neither, so verify the read-back the first time). Show the delete list by title and wait for an explicit yes before
   `delete_task`; `restore_task` is the undo. **A task with elapsed time (`actualTimeSpent`) is
   never deleted**: time was spent on it, so it is either marked complete or moved to today to be
   reviewed first, whichever Gaurav chooses when the list is shown. **Deleting an archived
   occurrence of a recurring task must not touch the series**: `delete_task` acts on one record,
   which is what is wanted, and `delete_incomplete_recurring_tasks` is never the answer. Before
   the first such delete, read the next occurrence day (`sunsama://tasks/{day}`) and confirm an
   occurrence of the series is there; delete one archived record; read that day again and
   confirm the occurrence survived; only then do the rest. Record each id, action and result in a file next
   to the decisions.

What is not automated: the MCP responses land in the agent's context, not on disk, so step 1 is
the agent writing them to files. A script that spoke to the server directly would need the OAuth
token Claude Code holds, which is not exposed.
