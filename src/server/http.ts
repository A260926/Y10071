import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { ReviewService } from './service.js';

export interface HttpDeps {
  service: ReviewService;
  db: DatabaseSync;
}

function readJson(req: IncomingMessage, limitBytes = 8 * 1024 * 1024): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(Object.assign(new Error('请求体过大（上限 8MB）'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (err) {
        reject(Object.assign(new Error(`请求体不是合法 JSON: ${(err as Error).message}`), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  });
  res.end(payload);
}

export function createApiServer(deps: HttpDeps): Server {
  const { service } = deps;

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname;
    try {
      if (req.method === 'GET' && path === '/api/cases') {
        return send(res, 200, { cases: service.listCases() });
      }

      if (req.method === 'GET' && /^\/api\/cases\/[^/]+$/.test(path)) {
        const caseId = decodeURIComponent(path.split('/').pop()!);
        const view = service.getCase(caseId);
        if (!view) return send(res, 404, { error: '审议单不存在' });
        return send(res, 200, { revision: view });
      }

      if (req.method === 'GET' && /^\/api\/revisions\/[^/]+$/.test(path)) {
        const revisionId = decodeURIComponent(path.split('/').pop()!);
        const view = service.getRevision(revisionId);
        if (!view) return send(res, 404, { error: '修订不存在' });
        return send(res, 200, { revision: view });
      }

      if (req.method === 'GET' && /^\/api\/cases\/[^/]+\/events$/.test(path)) {
        const caseId = decodeURIComponent(path.split('/')[3]);
        return send(res, 200, { events: service.getEvents(caseId) });
      }

      if (req.method === 'POST' && path === '/api/cases') {
        const body = (await readJson(req)) as Record<string, unknown>;
        const result = service.createOrUpload({
          title: typeof body.title === 'string' ? body.title : undefined,
          beforeSource: String(body.before ?? ''),
          afterSource: String(body.after ?? ''),
          beforeFormat: body.beforeFormat as 'json' | 'yaml' | undefined,
          afterFormat: body.afterFormat as 'json' | 'yaml' | undefined
        });
        if (!result.ok) return send(res, 400, { error: result.error, side: result.side });
        return send(res, 201, result);
      }

      const uploadMatch = /^\/api\/cases\/([^/]+)\/revisions$/.exec(path);
      if (req.method === 'POST' && uploadMatch) {
        const caseId = decodeURIComponent(uploadMatch[1]);
        const body = (await readJson(req)) as Record<string, unknown>;
        const result = service.createOrUpload({
          caseId,
          beforeSource: String(body.before ?? ''),
          afterSource: String(body.after ?? ''),
          beforeFormat: body.beforeFormat as 'json' | 'yaml' | undefined,
          afterFormat: body.afterFormat as 'json' | 'yaml' | undefined
        });
        if (!result.ok) return send(res, 400, { error: result.error, side: result.side });
        return send(res, result.reused ? 200 : 201, result);
      }

      const decideMatch = /^\/api\/diffs\/([^/]+)\/decision$/.exec(path);
      if ((req.method === 'PUT' || req.method === 'POST') && decideMatch) {
        const diffId = decodeURIComponent(decideMatch[1]);
        const body = (await readJson(req)) as Record<string, unknown>;
        const caseId = String(body.caseId ?? '');
        const baseVersion = Number(body.baseVersion ?? 0);
        const result = service.decide(caseId, diffId, baseVersion, {
          state: String(body.state) as 'accepted' | 'rejected' | 'exempted',
          actor: String(body.actor ?? ''),
          rationale: String(body.rationale ?? ''),
          expiresAt: body.expiresAt == null ? undefined : String(body.expiresAt)
        });
        if (!result.ok && result.code === 'not-found') return send(res, 404, { error: '差异不存在或不属于活动修订' });
        if (!result.ok && result.code === 'conflict') return send(res, 409, result.payload);
        if (result.ok) return send(res, 200, { decision: result.decision, version: result.version });
      }

      return send(res, 404, { error: '未找到对应接口' });
    } catch (err) {
      const status = (err as { status?: number }).status ?? 500;
      return send(res, status, { error: (err as Error).message });
    }
  });
}
