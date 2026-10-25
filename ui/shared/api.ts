// Talks to the chaff server. The token arrives in the URL fragment (#t=...) so it never reaches
// the server log or a Referer, and goes back as a header on every API call.
import type { DecisionOp } from '../../src/core/decisions.ts';
import type { TriageDocument } from '../../src/core/model.ts';
import type { OpEnvelope, SessionMeta } from '../../src/node/server.ts';

export interface Summary {
  total: number;
  triaged: number;
  untriaged: number;
  buckets: Record<string, number>;
  noted: number;
}

const token = new URLSearchParams(location.hash.slice(1)).get('t') ?? '';

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { 'x-chaff-token': token, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body === undefined ? null : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

export const api = {
  document: () => call<{ doc: TriageDocument; meta: SessionMeta; summary: Summary }>('GET', '/api/document'),
  ops: (ops: DecisionOp[], effort?: OpEnvelope['effort']) =>
    call<{ decisions: TriageDocument['decisions']; order: string[]; summary: Summary }>('POST', '/api/ops', (effort ? { ops, effort } : { ops }) satisfies OpEnvelope),
  done: () => call<{ ok: boolean; summary: Summary }>('POST', '/api/done'),
};
