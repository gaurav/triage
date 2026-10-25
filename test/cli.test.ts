// Drives the built CLI the way a script or coding agent would: spawn it, read the URL from
// stderr, talk to the API, and check the file and exit code. `npm test` builds first.
import { strict as assert } from 'node:assert';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));

interface Session {
  child: ChildProcess;
  url: string;
  token: string;
  stderr: () => string;
  exit: Promise<number | null>;
}

const children = new Set<ChildProcess>();

function start(args: string[], cwd: string): Promise<Session> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args, '--no-open'], { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, BROWSER: 'false' } });
    children.add(child);
    child.on('exit', () => children.delete(child));
    let err = '';
    let out = '';
    child.stdout!.on('data', (c: Buffer) => (out += c));
    const exit = new Promise<number | null>((r) => child.on('exit', (code) => r(code)));
    child.stderr!.on('data', (c: Buffer) => {
      err += c;
      const m = /open (http:\/\/127\.0\.0\.1:\d+\/)#t=([0-9a-f]+)/.exec(err);
      if (m) resolve({ child, url: m[1]!, token: m[2]!, stderr: () => err, exit });
    });
    exit.then((code) => reject(new Error(`exited ${code} before serving; stderr: ${err}; stdout: ${out}`)));
    (child as ChildProcess & { out?: () => string }).out = () => out;
  });
}

async function api(s: Session, method: string, path: string, body?: unknown, token = s.token) {
  const res = await fetch(new URL(path, s.url), { method, headers: { 'x-chaff-token': token, 'content-type': 'application/json' }, body: body === undefined ? null : JSON.stringify(body) });
  return { status: res.status, body: res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text() };
}

describe('chaff CLI', () => {
  let dir: string;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'chaff-cli-'));
  });
  after(() => {
    // A failed assertion must not leave a server running, or the test process never exits.
    for (const c of children) c.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  });

  it('--version and --help', () => {
    const v = spawnSync(process.execPath, [CLI, '--version'], { encoding: 'utf8' });
    assert.equal(v.status, 0);
    assert.match(v.stdout, /^\d+\.\d+\.\d+\n$/);
    const h = spawnSync(process.execPath, [CLI, '--help'], { encoding: 'utf8' });
    assert.equal(h.status, 0);
    assert.match(h.stderr, /Usage/);
    assert.equal(h.stdout, '', 'stdout stays clean');
  });

  it('inspect describes the input and writes a sidecar', () => {
    const input = join(dir, 'tasks.json');
    writeFileSync(input, readFileSync(join(FIXTURES, 'sunsama-like.json')));
    const r = spawnSync(process.execPath, [CLI, 'inspect', input, '--write-map'], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /array of 200 item/);
    assert.match(r.stderr, /title: text/);
    assert.match(r.stderr, /completedDate:present/);
    const map = JSON.parse(readFileSync(join(dir, 'tasks.chaff-map.json'), 'utf8'));
    assert.equal(map.chaff, 1);
    assert.equal(map.title, 'text');
    // The sidecar is picked up on the next run.
    const r2 = spawnSync(process.execPath, [CLI, 'inspect', input], { encoding: 'utf8' });
    assert.match(r2.stderr, /tasks\.chaff-map\.json/);
  });

  it('serves, applies decisions, writes on Done and exits 0', async () => {
    const input = join(dir, 'list.json');
    writeFileSync(input, readFileSync(join(FIXTURES, 'list.json')));
    const out = join(dir, 'decided.json');
    const s = await start([input, '--out', out, '--assign', 'bucket=now,later,@date', '--note', 'why', '--log', join(dir, 'events.ndjson')], dir);
    assert.ok(existsSync(out), 'the output exists from the start');

    const d = await api(s, 'GET', '/api/document');
    assert.equal(d.status, 200);
    assert.equal(d.body.doc.items.length, 5);
    assert.deepEqual(d.body.doc.mapping.buckets, { field: 'bucket', values: ['now', 'later', 'someday'], date: true });
    assert.equal(d.body.meta.ui, 'list');

    const page = await fetch(s.url);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<div id="app">/);

    const r = await api(s, 'POST', '/api/ops', { ops: [{ op: 'bucket', ids: ['1', '2'], bucket: 'now' }, { op: 'note', ids: ['1'], note: 'dup of 2' }, { op: 'bucket', ids: ['4'], bucket: '2026-10-27' }], effort: { keys: 3 } });
    assert.equal(r.status, 200);
    assert.equal(r.body.summary.triaged, 4);

    const done = await api(s, 'POST', '/api/done');
    assert.equal(done.status, 200);
    assert.equal(await s.exit, 0);
    const written = JSON.parse(readFileSync(out, 'utf8'));
    assert.deepEqual(written.map((r: { id: number; bucket?: string; why?: string }) => [r.id, r.bucket, r.why]), [
      [1, 'now', 'dup of 2'],
      [2, 'now', undefined],
      [3, 'someday', undefined],
      [4, '2026-10-27', undefined],
      [5, undefined, undefined],
    ]);
    assert.match(s.stderr(), /done: 4\/5 triaged \(now 2, later 0, someday 1, 2026-10-27 1\), 1 noted/);
    const events = readFileSync(join(dir, 'events.ndjson'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(events.length, 3, 'start, one change, end');
    assert.equal(events[1].effort.keys, 3);
    assert.equal(events[2].end.code, 0);
  });

  it('refuses to clobber, resumes, and exits 2 on SIGINT', async () => {
    const input = join(dir, 'list.json');
    const out = join(dir, 'decided.json');
    const clobber = spawnSync(process.execPath, [CLI, input, '--out', out, '--assign', 'bucket=now,later', '--no-open'], { encoding: 'utf8' });
    assert.equal(clobber.status, 1);
    assert.match(clobber.stderr, /exists; --resume/);

    // Resumed with @date: the day on 4 is a decision, not a new keyed value.
    const s = await start([input, '--out', out, '--assign', 'bucket=now,later,@date', '--note', 'why', '--resume'], dir);
    assert.match(s.stderr(), /resumed 3 decision\(s\)/);
    const d = await api(s, 'GET', '/api/document');
    assert.deepEqual(d.body.doc.decisions, { '1': { bucket: 'now', note: 'dup of 2' }, '2': { bucket: 'now' }, '4': { bucket: '2026-10-27' } });
    assert.deepEqual(d.body.doc.mapping.buckets.values, ['now', 'later', 'someday']);
    await api(s, 'POST', '/api/ops', { ops: [{ op: 'bucket', ids: ['4'], bucket: 'later' }] });
    s.child.kill('SIGINT');
    assert.equal(await s.exit, 2);
    const written = JSON.parse(readFileSync(out, 'utf8'));
    assert.equal(written[3].bucket, 'later', 'the autosave has the last change');
    assert.match(s.stderr(), /interrupted: 4\/5 triaged/);
  });

  it('rejects API calls without the token or with a foreign Host', async () => {
    const input = join(dir, 'list.json');
    const s = await start([input, '--out', join(dir, 'x.json'), '--force'], dir);
    assert.equal((await api(s, 'POST', '/api/done', undefined, 'wrong')).status, 403);
    // fetch() refuses to send a custom Host header, so use node:http for the DNS-rebinding case.
    const foreign = await new Promise<number>((resolve, reject) => {
      const u = new URL('/api/document', s.url);
      request({ host: u.hostname, port: u.port, path: u.pathname, headers: { host: 'evil.example', 'x-chaff-token': s.token } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      }).on('error', reject).end();
    });
    assert.equal(foreign, 403);
    s.child.kill('SIGTERM');
    assert.equal(await s.exit, 2);
  });

  it('reads stdin and writes stdout, keeping stderr for chatter', async () => {
    const child = spawn(process.execPath, [CLI, '-', '--out', '-', '--assign', 'b=x,y', '--no-open'], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] });
    children.add(child);
    child.stdin!.end(readFileSync(join(FIXTURES, 'items.ndjson')));
    let err = '';
    let out = '';
    child.stdout!.on('data', (c: Buffer) => (out += c));
    const session = await new Promise<{ url: string; token: string }>((resolve) => {
      child.stderr!.on('data', (c: Buffer) => {
        err += c;
        const m = /open (http:\/\/127\.0\.0\.1:\d+\/)#t=([0-9a-f]+)/.exec(err);
        if (m) resolve({ url: m[1]!, token: m[2]! });
      });
    });
    const exit = new Promise<number | null>((r) => child.on('exit', (code) => r(code)));
    await fetch(new URL('/api/ops', session.url), { method: 'POST', headers: { 'x-chaff-token': session.token, 'content-type': 'application/json' }, body: JSON.stringify({ ops: [{ op: 'bucket', ids: ['c'], bucket: 'y' }] }) });
    await fetch(new URL('/api/done', session.url), { method: 'POST', headers: { 'x-chaff-token': session.token } });
    assert.equal(await exit, 0);
    const lines = out.trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(lines.map((l) => [l.id, l.b]), [['a', undefined], ['b', undefined], ['c', 'y']]);
  });

  it('fails cleanly on bad input', () => {
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, '{"a": 1}');
    const r = spawnSync(process.execPath, [CLI, bad, '--no-open'], { encoding: 'utf8' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /not an object/);
    const dup = join(dir, 'dup.json');
    writeFileSync(dup, '[{"id":1,"t":"a"},{"id":1,"t":"b"}]');
    const r2 = spawnSync(process.execPath, [CLI, dup, '--id', 'id', '--no-open'], { encoding: 'utf8' });
    assert.equal(r2.status, 1);
    assert.match(r2.stderr, /share the id/);
  });
});
