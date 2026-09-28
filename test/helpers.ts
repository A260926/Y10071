import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ReviewService, type Clock } from '../src/server/service.js';
import { openDatabase } from '../src/server/db.js';

export function fixture(name: string, side: 'before' | 'after'): string {
  return readFileSync(join(process.cwd(), 'fixtures', name, `${side}.yaml`), 'utf8');
}

export class FakeClock implements Clock {
  current: Date;
  constructor(initial = '2026-01-01T00:00:00.000Z') {
    this.current = new Date(initial);
  }
  now(): Date {
    return this.current;
  }
  set(iso: string): void {
    this.current = new Date(iso);
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

export function makeService(clock?: Clock): { db: DatabaseSync; service: ReviewService } {
  const db = openDatabase(':memory:');
  return { db, service: new ReviewService(db, clock ?? new FakeClock()) };
}

export function upload(
  service: ReviewService,
  name: string,
  opts: { caseId?: string } = {}
): { caseId: string; revisionId: string; revisionNo: number; reused: boolean; diffCount: number } {
  const result = service.createOrUpload({
    title: name,
    caseId: opts.caseId,
    beforeSource: fixture(name, 'before'),
    afterSource: fixture(name, 'after')
  });
  if (!result.ok) throw new Error(`${name} 导入失败: ${result.error.path} ${result.error.message}`);
  return result;
}
