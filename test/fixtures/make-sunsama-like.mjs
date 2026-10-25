// Generates sunsama-like.json: 200 synthetic tasks with the field names and shape of a Sunsama
// export (HTML notes, "" for blanks, arrays for subtasks/dailyPriority, duplicate titles for
// recurring tasks). Real exports are personal and live in the gitignored data/ directory.
// Deterministic: `node test/fixtures/make-sunsama-like.mjs` rewrites the same file.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

let seed = 42;
const rand = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
const pick = (a) => a[Math.floor(rand() * a.length)];

const recurring = [
  ['Go through chat messages', 30], ['Catch up on incoming', 16], ['Plan next week', 6],
  ['Weekly team meeting', 8], ['Submit timesheet', 5], ['Check tyre pressure', 3],
];
const oneOff = [
  'Prepare conference presentation', 'Review pull request', 'Write quarterly report', 'Fix flaky test',
  'Renew passport', 'Book dentist', 'Draft grant proposal', 'Reply to reviewer comments', 'Update dependencies',
  'Read paper on entity resolution', 'Clean garage', 'Migrate CI to new runner', 'Write release notes',
  'Call plumber', 'Investigate slow query', 'Archive old project', 'Order printer toner', 'Plan holiday',
  'Refactor loader module', 'Set up monitoring alerts', 'Answer survey', 'Pay invoice', 'Tidy inbox',
];
const channels = ['#work', '#life', '#project-a', '#project-b', '#writing', '#finance', '#career', ''];
const contextOf = { '#work': '#work', '#project-a': '#work', '#project-b': '#work', '#writing': '#work', '#life': '#life', '#finance': '#life', '#career': '#life', '': '' };
const integrations = ['', '', '', '', 'github', 'email', 'slack', 'website', 'jira'];
const priorities = ['', '', '', '', '', 'Urgent', 'Priority'];
const estimates = ['', '15', '20', '30', '45', '60', '90', '120'];

function isoDate(dayOffset) {
  const d = new Date(Date.UTC(2026, 0, 1) + dayOffset * 86400000);
  return d.toISOString().slice(0, 10);
}
function isoDateTime(dayOffset) {
  return `${isoDate(dayOffset)}T0${Math.floor(rand() * 9)}:${String(Math.floor(rand() * 60)).padStart(2, '0')}:00-06:00`;
}

const items = [];
let n = 0;
function add(text, extra = {}) {
  const day = Math.floor(rand() * 290);
  const done = rand() < 0.8;
  const channel = pick(channels);
  const id = (0x68cc1cd260341050a6b40000n + BigInt(n++)).toString(16);
  items.push({
    id,
    text,
    notes: rand() < 0.5 ? `<p><strong>Notes</strong></p><ul><li><p>Step one · <em>20 min</em></p></li><li><p>Step two · <a href="https://example.org/${n}" target="_blank" rel="noopener noreferrer">link</a></p></li></ul>` : '',
    assignee: 'someone@example.org',
    createdAt: isoDateTime(day),
    completedDate: done ? isoDateTime(day + Math.floor(rand() * 3)) : '',
    startDate: rand() < 0.9 ? isoDate(day) : '',
    dueDate: rand() < 0.05 ? isoDate(day + 7) : '',
    comments: [],
    subtasks: rand() < 0.2 ? [{ title: 'Sub one', completedDate: '' }, { title: 'Sub two', completedDate: isoDate(day) }] : [],
    channel,
    context: contextOf[channel],
    objective: rand() < 0.03 ? 'Finish the big thing' : '',
    timeEstimate: pick(estimates),
    actualTime: done && rand() < 0.6 ? [{ startDate: isoDateTime(day), endDate: isoDateTime(day) }] : [],
    scheduledTime: [],
    integration: pick(integrations),
    url: rand() < 0.05 ? `https://example.org/item/${n}` : '',
    sequenceStart: false,
    sequenceRule: '',
    backlogPriority: 'No priority',
    dailyPriority: rand() < 0.1 ? ['Urgent'] : [],
    latestDailyPriority: pick(priorities),
    ...extra,
  });
}
for (const [text, count] of recurring) for (let i = 0; i < count; i++) add(text, { sequenceRule: 'repeats every weekday' });
while (items.length < 200) add(pick(oneOff));
// Shuffle so stacks are interleaved as in a real export.
for (let i = items.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [items[i], items[j]] = [items[j], items[i]]; }

const out = new URL('./sunsama-like.json', import.meta.url);
writeFileSync(fileURLToPath(out), JSON.stringify(items, null, 1) + '\n');
console.log(`wrote ${items.length} items to ${fileURLToPath(out)}`);
