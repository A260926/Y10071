import { resolve } from 'node:path';
import { openDatabase } from './db.js';
import { createApiServer } from './http.js';
import { ReviewService } from './service.js';

const host = process.env.HOST ?? '127.0.0.1';
const port = Number(process.env.PORT ?? 5201);
const dbPath = process.env.DB_PATH ?? resolve(process.cwd(), 'data/review.db');

const db = openDatabase(dbPath);
const service = new ReviewService(db);
const server = createApiServer({ service, db });

server.listen(port, host, () => {
  console.log(`契约变更审议台 API: http://${host}:${port} (db: ${dbPath})`);
});
