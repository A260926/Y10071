import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { openDatabase } from '../src/server/db.js';
import { ReviewService } from '../src/server/service.js';
import { createApiServer } from '../src/server/http.js';
import { FakeClock, fixture } from './helpers.js';

async function call(server: Server, path: string, init?: { method?: string; body?: unknown }) {
  const port = (server.address() as AddressInfo).port;
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: init?.method ?? (init?.body ? 'POST' : 'GET'),
    headers: { 'content-type': 'application/json' },
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined
  });
  const json = (await res.json()) as any;
  return { status: res.status, json };
}

describe('HTTP 并发写入', () => {
  let server: Server;
  let caseId = '';
  let diffId = '';

  beforeAll(async () => {
    const db = openDatabase(':memory:');
    const service = new ReviewService(db, new FakeClock());
    server = createApiServer({ service, db });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

    const created = await call(server, '/api/cases', {
      body: { title: 'http', before: fixture('breaking-change', 'before'), after: fixture('breaking-change', 'after') }
    });
    expect(created.status).toBe(201);
    caseId = created.json.caseId;
    const view = await call(server, `/api/cases/${caseId}`);
    diffId = view.json.revision.diffs[0].id;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('两个并发 PUT 只有一个成功，另一个得到 409 且带双方内容，重试成功', async () => {
    const payload = (actor: string, state: string, rationale: string) => ({
      body: { caseId, baseVersion: 0, state, actor, rationale }
    });
    const [first, second] = await Promise.all([
      call(server, `/api/diffs/${diffId}/decision`, { method: 'PUT', ...payload('alice', 'accepted', '甲方') }),
      call(server, `/api/diffs/${diffId}/decision`, { method: 'PUT', ...payload('bob', 'rejected', '乙方') })
    ]);

    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([200, 409]);
    const conflict = first.status === 409 ? first.json : second.json;
    expect(conflict.conflict).toBe(true);
    expect(conflict.baseVersion).toBe(0);
    expect(conflict.currentVersion).toBe(1);
    expect(conflict.submitted.actor).toBe('bob');
    expect(conflict.current.actor).toBe('alice');

    const retry = await call(server, `/api/diffs/${diffId}/decision`, {
      method: 'PUT',
      body: { caseId, baseVersion: 1, state: 'rejected', actor: 'bob', rationale: '乙方' }
    });
    expect(retry.status).toBe(200);
    expect(retry.json.version).toBe(2);
  }, 15000);
});
