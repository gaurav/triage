// A small node:http server: static files for one view, and a token-guarded JSON API over the
// TriageDocument. The token travels in the URL that is opened (#t=...) and comes back as a
// header on every /api call, so no other page in the browser can drive a session.
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, normalize } from 'node:path';
import { applyOp, type DecisionOp } from '../core/decisions.ts';
import type { TriageDocument } from '../core/model.ts';

export interface SessionMeta {
  ui: string;
  input: string;
  out: string;
  version: string;
}

export interface OpEnvelope {
  ops: DecisionOp[];
  /** What the client did since its last envelope; copied into the event log. */
  effort?: { keys?: number; clicks?: number; undo?: boolean; ms?: number };
}

export interface ServerHooks {
  /** Called after ops are applied; persist and log here. */
  onChange(env: OpEnvelope): void | Promise<void>;
  onDone(): void | Promise<void>;
  summary(): unknown;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
};

export class TriageServer {
  readonly token = randomBytes(16).toString('hex');
  private server: Server;
  private doc: TriageDocument;
  private uiDir: string;
  private meta: SessionMeta;
  private hooks: ServerHooks;
  private doneCalled = false;

  constructor(doc: TriageDocument, uiDir: string, meta: SessionMeta, hooks: ServerHooks) {
    this.doc = doc;
    this.uiDir = uiDir;
    this.meta = meta;
    this.hooks = hooks;
    this.server = createServer((req, res) => {
      this.handle(req, res).catch((e) => {
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
        res.end(`error: ${(e as Error).message}`);
      });
    });
  }

  listen(port: number): Promise<{ port: number; url: string }> {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, '127.0.0.1', () => {
        this.server.off('error', reject);
        const p = (this.server.address() as AddressInfo).port;
        resolve({ port: p, url: `http://127.0.0.1:${p}/#t=${this.token}` });
      });
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      this.server.closeAllConnections?.();
      this.server.close(() => resolve());
    });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const host = req.headers.host ?? '';
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) return text(res, 403, 'forbidden: unexpected Host');
    const url = new URL(req.url ?? '/', `http://${host}`);
    if (url.pathname.startsWith('/api/')) return this.api(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') return text(res, 405, 'method not allowed');
    return this.static(url.pathname, res);
  }

  private async api(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    if (req.headers['x-chaff-token'] !== this.token) return text(res, 403, 'forbidden: missing or wrong token');
    const route = `${req.method} ${url.pathname}`;
    switch (route) {
      case 'GET /api/document':
        return json(res, 200, { doc: this.doc, meta: this.meta, summary: this.hooks.summary() });
      case 'POST /api/ops': {
        const env = (await readJson(req)) as OpEnvelope;
        if (!env || !Array.isArray(env.ops)) return text(res, 400, 'expected {ops: [...]}');
        for (const op of env.ops) applyOp(this.doc, op);
        await this.hooks.onChange(env);
        return json(res, 200, { decisions: this.doc.decisions, order: this.doc.order, summary: this.hooks.summary() });
      }
      case 'POST /api/done': {
        if (this.doneCalled) return json(res, 200, { ok: true });
        this.doneCalled = true;
        json(res, 200, { ok: true, summary: this.hooks.summary() });
        // Let the reply reach the browser before run() closes every connection.
        if (!res.writableFinished) await new Promise<void>((r) => { res.once('finish', () => r()); setTimeout(r, 1000).unref(); });
        await this.hooks.onDone();
        return;
      }
      default:
        return text(res, 404, 'no such API route');
    }
  }

  private async static(pathname: string, res: ServerResponse): Promise<void> {
    const rel = pathname === '/' ? 'index.html' : normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, '');
    if (rel.includes('..')) return text(res, 400, 'bad path');
    const file = join(this.uiDir, rel);
    if (!existsSync(file) || !statSync(file).isFile()) return text(res, 404, `not found: ${rel}`);
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(readFileSync(file));
  }
}

function text(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(body);
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null);
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}
