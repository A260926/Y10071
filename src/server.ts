import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createReadStream } from 'node:fs';
import { mkdirSync, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store, ConflictError, ValidationError, NotFoundError } from './store.js';
import { parseOpenApiText } from './parse.js';
import { normalizeSpec, summarizeDoc } from './normalize.js';
import { diffSpecs, type DiffEntry } from './diff.js';
import { buildImpact } from './impact.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = join(ROOT, 'public');
const FIXTURE_DIR = join(ROOT, 'fixtures');

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

export interface AppOptions {
  dbPath?: string;
}

export function createApp(options: AppOptions = {}) {
  const dbPath = options.dbPath ?? process.env.CONTRACT_DB ?? join(ROOT, 'data', 'review.sqlite');
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
  const store = new Store(dbPath);

  async function readJson(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 8 * 1024 * 1024) throw new ValidationError('请求体超过 8MB 限制');
      chunks.push(chunk as Buffer);
    }
    const text = Buffer.concat(chunks).toString('utf-8');
    try {
      return text ? JSON.parse(text) : {};
    } catch {
      throw new ValidationError('请求体不是合法 JSON');
    }
  }

  function sendJson(res: ServerResponse, status: number, body: unknown): void {
    const text = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(text);
  }

  function sendStatic(res: ServerResponse, urlPath: string): boolean {
    const relative = urlPath === '/' ? 'index.html' : urlPath.slice(1);
    const filePath = normalize(join(PUBLIC_DIR, relative));
    if (!filePath.startsWith(PUBLIC_DIR) || !existsSync(filePath) || !statSync(filePath).isFile()) {
      return false;
    }
    res.writeHead(200, {
      'content-type': CONTENT_TYPES[filePath.slice(filePath.lastIndexOf('.'))] ?? 'application/octet-stream',
    });
    createReadStream(filePath).pipe(res);
    return true;
  }

  function listFixtures(): string[] {
    if (!existsSync(FIXTURE_DIR)) return [];
    return readdirSync(FIXTURE_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  }

  function readFixtureDoc(name: string, file: 'before' | 'after'): string {
    const base = join(FIXTURE_DIR, name);
    for (const ext of ['yaml', 'yml', 'json']) {
      const candidate = join(base, `${file}.${ext}`);
      if (existsSync(candidate)) return readFileSync(candidate, 'utf-8');
    }
    throw new NotFoundError(`fixture 文档不存在: ${name}/${file}`);
  }

  function withImpact(view: Record<string, unknown>): Record<string, unknown> {
    const diffs = (view.diffs as DiffEntry[]).map((diff) => ({
      ...diff,
      impact: buildImpact(diff),
    }));
    return { ...view, diffs };
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const pathname = url.pathname;
    const method = req.method ?? 'GET';
    try {
      if (pathname === '/api/fixtures' && method === 'GET') {
        sendJson(res, 200, { fixtures: listFixtures() });
        return;
      }
      const fixtureMatch = /^\/api\/fixtures\/([a-z0-9-]+)$/.exec(pathname);
      if (fixtureMatch && method === 'GET') {
        const name = fixtureMatch[1];
        sendJson(res, 200, {
          name,
          before: readFixtureDoc(name, 'before'),
          after: readFixtureDoc(name, 'after'),
        });
        return;
      }
      if (pathname === '/api/tickets' && method === 'GET') {
        sendJson(res, 200, { tickets: store.listTickets() });
        return;
      }
      if (pathname === '/api/tickets' && method === 'POST') {
        const body = (await readJson(req)) as { title?: string };
        sendJson(res, 201, store.createTicket(body.title ?? ''));
        return;
      }
      const ticketMatch = /^\/api\/tickets\/([^/]+)$/.exec(pathname);
      if (ticketMatch && method === 'GET') {
        sendJson(res, 200, withImpact(store.getTicketView(ticketMatch[1])));
        return;
      }
      const revisionsMatch = /^\/api\/tickets\/([^/]+)\/revisions$/.exec(pathname);
      if (revisionsMatch && method === 'POST') {
        const body = (await readJson(req)) as { before?: string; after?: string };
        const beforeResult = parseOpenApiText(body.before ?? '', 'before');
        if (!beforeResult.ok) {
          sendJson(res, 400, { error: 'invalid-document', ...beforeResult });
          return;
        }
        const afterResult = parseOpenApiText(body.after ?? '', 'after');
        if (!afterResult.ok) {
          sendJson(res, 400, { error: 'invalid-document', ...afterResult });
          return;
        }
        const beforeSpec = normalizeSpec(beforeResult.doc);
        const afterSpec = normalizeSpec(afterResult.doc);
        const beforeSummary = summarizeDoc(beforeResult.doc, beforeSpec);
        const afterSummary = summarizeDoc(afterResult.doc, afterSpec);
        const diffs = diffSpecs(beforeSpec, afterSpec);
        const result = store.addRevision(
          revisionsMatch[1],
          { doc: beforeResult.doc, spec: beforeSpec, summary: beforeSummary },
          { doc: afterResult.doc, spec: afterSpec, summary: afterSummary },
          diffs,
        );
        sendJson(res, result.reused ? 200 : 201, result);
        return;
      }
      const decisionMatch = /^\/api\/tickets\/([^/]+)\/diffs\/([^/]+)\/decision$/.exec(pathname);
      if (decisionMatch && method === 'PUT') {
        const body = (await readJson(req)) as {
          status?: string;
          reason?: string;
          operator?: string;
          deadline?: string | null;
          expectedVersion?: number;
        };
        const result = store.saveDecision(decisionMatch[1], decisionMatch[2], {
          status: body.status as 'accepted' | 'rejected' | 'exempt',
          reason: body.reason ?? '',
          operator: body.operator ?? '',
          deadline: body.deadline ?? null,
          expectedVersion: Number(body.expectedVersion ?? 0),
        });
        sendJson(res, 200, result);
        return;
      }
      const eventsMatch = /^\/api\/tickets\/([^/]+)\/events$/.exec(pathname);
      if (eventsMatch && method === 'GET') {
        sendJson(res, 200, { events: store.listEvents(eventsMatch[1]) });
        return;
      }
      if (method === 'GET' && sendStatic(res, pathname)) return;
      sendJson(res, 404, { error: 'not-found', path: pathname });
    } catch (err) {
      if (err instanceof ConflictError) {
        sendJson(res, 409, {
          error: 'version-conflict',
          message: '决议已被另一会话更新，请基于最新版本重试',
          current: err.current,
          attempted: err.attempted,
        });
        return;
      }
      if (err instanceof ValidationError) {
        sendJson(res, 400, { error: 'validation', message: err.message });
        return;
      }
      if (err instanceof NotFoundError) {
        sendJson(res, 404, { error: 'not-found', message: err.message });
        return;
      }
      sendJson(res, 500, {
        error: 'internal',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

 const server = createHttpServer((req, res) => {
    void handle(req, res);
  });

  return {
    server,
    close: () => {
      server.close();
      store.close();
    },
  };
}

interface CliArgs {
  host: string;
  port: number;
}

export function parseArgs(argv: string[]): CliArgs {
  let host = '127.0.0.1';
  let port = 5201;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--host' && argv[i + 1]) host = argv[++i];
    if (argv[i] === '--port' && argv[i + 1]) port = Number(argv[++i]);
  }
  if (!Number.isInteger(port) || port <= 0) throw new Error(`非法端口: ${argv.join(' ')}`);
  return { host, port };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const { host, port } = parseArgs(process.argv.slice(2));
  const app = createApp();
  app.server.listen(port, host, () => {
    console.log(`契约变更审议台已启动: http://${host}:${port}`);
  });
}
