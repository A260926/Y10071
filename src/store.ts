import { createRequire } from 'node:module';
import { randomUUID, createHash } from 'node:crypto';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { clock } from './clock.js';
import type { DiffEntry } from './diff.js';
import type { DocSummary, NormalizedSpec } from './normalize.js';
import { canonicalHash, stableStringify } from './normalize.js';

const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire('node:sqlite') as typeof import('node:sqlite');

export type DecisionStatus = 'accepted' | 'rejected' | 'exempt';
export type EffectiveStatus = DecisionStatus | 'expired' | 'pending';

export interface DecisionRow {
  status: DecisionStatus;
  reason: string;
  operator: string;
  deadline: string | null;
  version: number;
  beforeHash: string;
  afterHash: string;
  updatedAt: string;
}

export interface DecisionView extends DecisionRow {
  effectiveStatus: EffectiveStatus;
}

export interface DiffView extends DiffEntry {
  decision: DecisionView | null;
}

export class ConflictError extends Error {
  constructor(
    public current: DecisionView | null,
    public attempted: Record<string, unknown>,
  ) {
    super('version-conflict');
  }
}

export class ValidationError extends Error {}

export class NotFoundError extends Error {}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tickets (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS revisions (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  before_summary TEXT NOT NULL,
  after_summary TEXT NOT NULL,
  canonical_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (ticket_id, canonical_hash)
);
CREATE TABLE IF NOT EXISTS revision_diffs (
  revision_id TEXT NOT NULL,
  identity TEXT NOT NULL,
  category TEXT NOT NULL,
  location TEXT NOT NULL,
  subject TEXT NOT NULL,
  detail TEXT NOT NULL,
  PRIMARY KEY (revision_id, identity)
);
CREATE TABLE IF NOT EXISTS decision_state (
  ticket_id TEXT NOT NULL,
  identity TEXT NOT NULL,
  status TEXT NOT NULL,
  reason TEXT NOT NULL,
  operator TEXT NOT NULL,
  deadline TEXT,
  version INTEGER NOT NULL,
  before_hash TEXT NOT NULL,
  after_hash TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (ticket_id, identity)
);
CREATE TABLE IF NOT EXISTS events (
  ticket_id TEXT NOT NULL,
  event_no INTEGER NOT NULL,
  identity TEXT NOT NULL,
  status TEXT NOT NULL,
  reason TEXT NOT NULL,
  operator TEXT NOT NULL,
  deadline TEXT,
  before_hash TEXT NOT NULL,
  after_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (ticket_id, event_no)
);
`;

export function effectiveStatus(row: DecisionRow | null, now: Date): EffectiveStatus {
  if (!row) return 'pending';
  if (row.status === 'exempt' && row.deadline && now.getTime() >= Date.parse(row.deadline)) {
    return 'expired';
  }
  return row.status;
}

function toDecisionView(row: Record<string, unknown> | undefined): DecisionView | null {
  if (!row) return null;
  const decision: DecisionRow = {
    status: row.status as DecisionStatus,
    reason: row.reason as string,
    operator: row.operator as string,
    deadline: (row.deadline as string | null) ?? null,
    version: row.version as number,
    beforeHash: row.before_hash as string,
    afterHash: row.after_hash as string,
    updatedAt: row.updated_at as string,
  };
  return { ...decision, effectiveStatus: effectiveStatus(decision, clock.now()) };
}

export class Store {
  private db: DatabaseSyncType;

  constructor(path = ':memory:') {
    this.db = new DatabaseSync(path);
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  createTicket(title: string): { id: string; title: string } {
    if (!title || !title.trim()) throw new ValidationError('标题不能为空');
    const id = randomUUID();
    this.db
      .prepare('INSERT INTO tickets (id, title, created_at) VALUES (?, ?, ?)')
      .run(id, title.trim(), clock.now().toISOString());
    return { id, title: title.trim() };
  }

  listTickets(): unknown[] {
    return this.db
      .prepare(
        `SELECT t.id, t.title, t.created_at AS createdAt,
           (SELECT COUNT(*) FROM revisions r WHERE r.ticket_id = t.id) AS revisions
         FROM tickets t ORDER BY t.created_at DESC`,
      )
      .all();
  }

  private requireTicket(ticketId: string): void {
    const row = this.db.prepare('SELECT id FROM tickets WHERE id = ?').get(ticketId);
    if (!row) throw new NotFoundError('审议单不存在');
  }

  currentRevision(ticketId: string): Record<string, unknown> | undefined {
    return this.db
      .prepare(
        `SELECT id, seq, before_summary AS beforeSummary, after_summary AS afterSummary,
                canonical_hash AS canonicalHash, created_at AS createdAt
         FROM revisions WHERE ticket_id = ? ORDER BY seq DESC LIMIT 1`,
      )
      .get(ticketId);
  }

  addRevision(
    ticketId: string,
    before: { doc: unknown; spec: NormalizedSpec; summary: DocSummary },
    after: { doc: unknown; spec: NormalizedSpec; summary: DocSummary },
    diffs: DiffEntry[],
  ): { reused: boolean; revision: Record<string, unknown>; inherited: number } {
    this.requireTicket(ticketId);
    const pairHash = createHash('sha256')
      .update(`${canonicalHash(before.spec)}\n${canonicalHash(after.spec)}`)
      .digest('hex');
    const existing = this.db
      .prepare('SELECT id FROM revisions WHERE ticket_id = ? AND canonical_hash = ?')
      .get(ticketId, pairHash) as { id: string } | undefined;
    if (existing) {
      const revision = this.db
        .prepare(
          `SELECT id, seq, before_summary AS beforeSummary, after_summary AS afterSummary,
                  canonical_hash AS canonicalHash, created_at AS createdAt
           FROM revisions WHERE id = ?`,
        )
        .get(existing.id) as Record<string, unknown>;
      const inherited = this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM revision_diffs rd
           JOIN decision_state ds ON ds.ticket_id = ? AND ds.identity = rd.identity
           WHERE rd.revision_id = ?`,
        )
        .get(ticketId, existing.id) as { n: number };
      return { reused: true, revision, inherited: inherited.n };
    }
    const id = randomUUID();
    const now = clock.now().toISOString();
    this.db.exec('BEGIN');
    try {
      const seqRow = this.db
        .prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM revisions WHERE ticket_id = ?')
        .get(ticketId) as { seq: number };
      this.db
        .prepare(
          `INSERT INTO revisions (id, ticket_id, seq, before_summary, after_summary, canonical_hash, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          ticketId,
          seqRow.seq,
          JSON.stringify(before.summary),
          JSON.stringify(after.summary),
          pairHash,
          now,
        );
      const insertDiff = this.db.prepare(
        `INSERT INTO revision_diffs (revision_id, identity, category, location, subject, detail)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      for (const diff of diffs) {
        insertDiff.run(
          id,
          diff.identity,
          diff.category,
          diff.location,
          diff.subject,
          stableStringify(diff.detail),
        );
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    const revision = this.db
      .prepare(
        `SELECT id, seq, before_summary AS beforeSummary, after_summary AS afterSummary,
                canonical_hash AS canonicalHash, created_at AS createdAt
         FROM revisions WHERE id = ?`,
      )
      .get(id) as Record<string, unknown>;
    const inherited = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM revision_diffs rd
         JOIN decision_state ds ON ds.ticket_id = ? AND ds.identity = rd.identity
         WHERE rd.revision_id = ?`,
      )
      .get(ticketId, id) as { n: number };
    return { reused: false, revision, inherited: inherited.n };
  }

  getTicketView(ticketId: string): Record<string, unknown> {
    this.requireTicket(ticketId);
    const ticket = this.db
      .prepare('SELECT id, title, created_at AS createdAt FROM tickets WHERE id = ?')
      .get(ticketId);
    const revisions = this.db
      .prepare(
        `SELECT id, seq, before_summary AS beforeSummary, after_summary AS afterSummary,
                canonical_hash AS canonicalHash, created_at AS createdAt
         FROM revisions WHERE ticket_id = ? ORDER BY seq DESC`,
      )
      .all(ticketId) as Record<string, unknown>[];
    const current = revisions[0];
    let diffs: DiffView[] = [];
    if (current) {
      const rows = this.db
        .prepare(
          `SELECT identity, category, location, subject, detail FROM revision_diffs
           WHERE revision_id = ? ORDER BY category, location, subject`,
        )
        .all(current.id as string) as Record<string, unknown>[];
      const decisionStmt = this.db.prepare(
        'SELECT * FROM decision_state WHERE ticket_id = ? AND identity = ?',
      );
      diffs = rows.map((row) => ({
        identity: row.identity as string,
        category: row.category as DiffEntry['category'],
        location: row.location as string,
        subject: row.subject as string,
        detail: JSON.parse(row.detail as string),
        decision: toDecisionView(
          decisionStmt.get(ticketId, row.identity as string) as Record<string, unknown> | undefined,
        ),
      }));
    }
    return {
      ticket,
      revisions: revisions.map((r) => ({ ...r, readOnly: current ? r.id !== current.id : false })),
      currentRevisionId: current ? current.id : null,
      diffs,
      now: clock.now().toISOString(),
    };
  }

  saveDecision(
    ticketId: string,
    identity: string,
    input: {
      status: DecisionStatus;
      reason: string;
      operator: string;
      deadline?: string | null;
      expectedVersion: number;
    },
  ): { decision: DecisionView; eventNo: number } {
    this.requireTicket(ticketId);
    if (!['accepted', 'rejected', 'exempt'].includes(input.status)) {
      throw new ValidationError(`非法决议状态: ${input.status}`);
    }
    if (!input.operator || !input.operator.trim()) throw new ValidationError('操作者不能为空');
    if (!input.reason || !input.reason.trim()) throw new ValidationError('理由不能为空');
    const now = clock.now();
    if (input.status === 'exempt') {
      if (!input.deadline || Number.isNaN(Date.parse(input.deadline))) {
        throw new ValidationError('豁免必须提供有效期限');
      }
      if (Date.parse(input.deadline) <= now.getTime()) {
        throw new ValidationError('豁免期限必须晚于当前时间');
      }
    }
    const current = this.currentRevision(ticketId);
    if (!current) throw new ValidationError('请先上传一对文档生成修订');
    const inCurrent = this.db
      .prepare('SELECT 1 AS ok FROM revision_diffs WHERE revision_id = ? AND identity = ?')
      .get(current.id as string, identity);
    if (!inCurrent) {
      throw new ValidationError('该差异不属于当前修订（旧修订为只读）');
    }
    const attempted = {
      status: input.status,
      reason: input.reason,
      operator: input.operator,
      deadline: input.deadline ?? null,
      expectedVersion: input.expectedVersion,
    };
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existingRow = this.db
        .prepare('SELECT * FROM decision_state WHERE ticket_id = ? AND identity = ?')
        .get(ticketId, identity) as Record<string, unknown> | undefined;
      const currentVersion = existingRow ? (existingRow.version as number) : 0;
      if (input.expectedVersion !== currentVersion) {
        throw new ConflictError(toDecisionView(existingRow), attempted);
      }
      const eventRow = this.db
        .prepare('SELECT COALESCE(MAX(event_no), 0) + 1 AS no FROM events WHERE ticket_id = ?')
        .get(ticketId) as { no: number };
      const beforeHash = (JSON.parse(current.beforeSummary as string) as DocSummary).sha256;
      const afterHash = (JSON.parse(current.afterSummary as string) as DocSummary).sha256;
      const nowIso = now.toISOString();
      this.db
        .prepare(
          `INSERT INTO events (ticket_id, event_no, identity, status, reason, operator, deadline, before_hash, after_hash, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          ticketId,
          eventRow.no,
          identity,
          input.status,
          input.reason.trim(),
          input.operator.trim(),
          input.status === 'exempt' ? input.deadline! : null,
          beforeHash,
          afterHash,
          nowIso,
        );
      this.db
        .prepare(
          `INSERT INTO decision_state (ticket_id, identity, status, reason, operator, deadline, version, before_hash, after_hash, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (ticket_id, identity) DO UPDATE SET
             status = excluded.status, reason = excluded.reason, operator = excluded.operator,
             deadline = excluded.deadline, version = excluded.version,
             before_hash = excluded.before_hash, after_hash = excluded.after_hash,
             updated_at = excluded.updated_at`,
        )
        .run(
          ticketId,
          identity,
          input.status,
          input.reason.trim(),
          input.operator.trim(),
          input.status === 'exempt' ? input.deadline! : null,
          currentVersion + 1,
          beforeHash,
          afterHash,
          nowIso,
        );
      this.db.exec('COMMIT');
      const row = this.db
        .prepare('SELECT * FROM decision_state WHERE ticket_id = ? AND identity = ?')
        .get(ticketId, identity) as Record<string, unknown>;
      return { decision: toDecisionView(row)!, eventNo: eventRow.no };
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  listEvents(ticketId: string): unknown[] {
    this.requireTicket(ticketId);
    return this.db
      .prepare(
        `SELECT event_no AS eventNo, identity, status, reason, operator, deadline,
                before_hash AS beforeHash, after_hash AS afterHash, created_at AS createdAt
         FROM events WHERE ticket_id = ? ORDER BY event_no`,
      )
      .all(ticketId);
  }
}
