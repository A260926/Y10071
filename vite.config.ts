import { defineConfig, type Plugin } from 'vite';
import { resolve } from 'node:path';
import { createReadStream, statSync, existsSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';

const repoRoot = resolve(__dirname);

function sendFile(res: ServerResponse, absPath: string): void {
  if (!existsSync(absPath) || !statSync(absPath).isFile()) {
    res.statusCode = 404;
    res.end('not found');
    return;
  }
  const type = absPath.endsWith('.yaml') || absPath.endsWith('.yml') ? 'application/yaml; charset=utf-8' : 'text/plain; charset=utf-8';
  res.setHeader('content-type', type);
  createReadStream(absPath).pipe(res);
}

function devPlugin(): Plugin {
  return {
    name: 'contract-review-dev',
    configureServer(server) {
      let handler: ((req: IncomingMessage, res: ServerResponse) => void) | null = null;
      server.middlewares.use(async (req, res, next) => {
        const url = req.url ?? '/';
        if (url.startsWith('/fixtures/')) {
          const rel = decodeURIComponent(url.slice('/fixtures/'.length).split('?')[0]);
          if (rel.includes('..')) {
            res.statusCode = 400;
            res.end('bad path');
            return;
          }
          sendFile(res as unknown as ServerResponse, resolve(repoRoot, 'fixtures', rel));
          return;
        }
        if (!url.startsWith('/api/')) return next();
        try {
          if (!handler) {
            const mod = (await server.ssrLoadModule(resolve(repoRoot, 'src/server/http.ts'))) as typeof import('./src/server/http.js');
            const dbMod = (await server.ssrLoadModule(resolve(repoRoot, 'src/server/db.ts'))) as typeof import('./src/server/db.js');
            const svcMod = (await server.ssrLoadModule(resolve(repoRoot, 'src/server/service.ts'))) as typeof import('./src/server/service.js');
            const dbPath = process.env.DB_PATH ?? resolve(repoRoot, 'data/review.db');
            const db = dbMod.openDatabase(dbPath);
            const service = new svcMod.ReviewService(db);
            const nodeServer = mod.createApiServer({ service, db });
            handler = (nodeReq, nodeRes) => {
              nodeServer.emit('request', nodeReq, nodeRes);
            };
          }
          handler(req as IncomingMessage, res as unknown as ServerResponse);
        } catch (err) {
          res.statusCode = 500;
          res.setHeader('content-type', 'application/json; charset=utf-8');
          res.end(JSON.stringify({ error: (err as Error).message }));
        }
      });
    }
  };
}

export default defineConfig({
  root: resolve(repoRoot, 'web'),
  publicDir: false,
  plugins: [devPlugin()],
  server: {
    host: '127.0.0.1',
    port: 5201,
    strictPort: false,
    fs: { allow: [repoRoot] }
  },
  build: { outDir: resolve(repoRoot, 'dist') }
});
