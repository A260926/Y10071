import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  ChangeCategory,
  DecisionRecord,
  DecisionState,
  DocSummary,
  EffectiveDecision,
  ParseError,
  RawDecision,
  RawDiff,
  RevisionView
} from '../core/types.js';
import { parseOpenApi } from '../core/parse.js';
import { normalizeDoc, NormDoc } from '../core/normalize.js';
import { diffOperations } from '../core/diff.js';
import { buildImpact } from '../core/impact.js';

export interface Clock {
  now(): Date;
}

export const SYSTEM_CLOCK: Clock = { now: () => new Date() };

export interface UploadInput {
  title?: string;
  caseId?: string;
  beforeSource: string;
  afterSource: string;
  beforeFormat?: 'json' | 'yaml';
  afterFormat?: 'json' | 'yaml';
}

export interface ConflictPayload {
  conflict: true;
  diffId: string;
  baseVersion: number;
  currentVersion: number;
  submitted: {
    actor: string;
    state: DecisionState;
    rationale: string;
    expiresAt: string | null;
  };
  current: DecisionRecord | null;
}

interface RevisionRow {
  id: string;
  case_id: string;
  revision_no: number;
  active: number;
  before_hash: string;
  after_hash: string;
  before_summary: string;
  after_summary: string;
  created_at: string;
}

interface DiffRow {
  id: string;
  revision_id: string;
  diff_key: string;
  category: ChangeCategory;
  scope: string;
  subject: string;
  before_json: string;
  after_json: string;
  impact: string;
}

interface DecisionRow {
  id: string;
  diff_id: string;
  base_version: number;
  state: DecisionState;
  actor: string;
  rationale: string;
  expires_at: string | null;
  decided_at: string;
  before_summary: string;
  after_summary: string;
}

function parsePair(input: UploadInput):
  | { ok: true; beforeParsed: any; afterParsed: any; beforeNorm: NormDoc; afterNorm: NormDoc; diffs: RawDiff[] }
  | { ok: false; error: ParseError; side: 'before' | 'after' } {
  const beforeParsed = parseOpenApi(input.beforeSource, input.beforeFormat);
  if ('error' in beforeParsed) return { ok: false, error: beforeParsed.error, side: 'before' };
  const afterParsed = parseOpenApi(input.afterSource, input.afterFormat);
  if ('error' in afterParsed) return { ok: false, error: afterParsed.error, side: 'after' };
  let beforeNorm: NormDoc;
  let afterNorm: NormDoc;
  try {
    beforeNorm = normalizeDoc(beforeParsed);
  } catch (err) {
    return { ok: false, error: err as ParseError, side: 'before' };
  }
  try {
    afterNorm = normalizeDoc(afterParsed);
  } catch (err) {
    return { ok: false, error: err as ParseError, side: 'after' };
  }
  return {
    ok: true,
    beforeParsed,
    afterParsed,
    beforeNorm,
    afterNorm,
    diffs: diffOperations(beforeNorm, afterNorm)
  };
}

export class ReviewService {
  constructor(
    private db: DatabaseSync,
    private clock: Clock = SYSTEM_CLOCK
  ) {}

  private isoNow(): string {
    return this.clock.now().toISOString();
  }

  private withTx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  private nextEventNo(tx: DatabaseSync, caseId: string): number {
    const row = tx.prepare('SELECT COALESCE(MAX(event_no), 0) + 1 AS next FROM events WHERE case_id = ?').get(caseId) as {
      next: number;
    };
    return row.next;
  }

  private insertEvent(
    tx: DatabaseSync,
    fields: {
      caseId: string;
      kind: string;
      revisionId?: string | null;
      diffId?: string | null;
      fromRevisionId?: string | null;
      state?: string | null;
      actor?: string | null;
      rationale?: string | null;
      expiresAt?: string | null;
      beforeSummary?: string | null;
      afterSummary?: string | null;
    }
  ): number {
    const eventNo = this.nextEventNo(tx, fields.caseId);
    tx.prepare(
      `INSERT INTO events
        (id, case_id, event_no, kind, revision_id, diff_id, from_revision_id, state, actor, rationale, expires_at, before_summary, after_summary, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      randomUUID(),
      fields.caseId,
      eventNo,
      fields.kind,
      fields.revisionId ?? null,
      fields.diffId ?? null,
      fields.fromRevisionId ?? null,
      fields.state ?? null,
      fields.actor ?? null,
      fields.rationale ?? null,
      fields.expiresAt ?? null,
      fields.beforeSummary ?? null,
      fields.afterSummary ?? null,
      this.isoNow()
    );
    return eventNo;
  }

  createOrUpload(input: UploadInput):
    | { ok: true; caseId: string; revisionId: string; revisionNo: number; reused: boolean; diffCount: number }
    | { ok: false; side: 'before' | 'after'; error: ParseError } {
    const parsed = parsePair(input);
    if (!parsed.ok) return { ok: false, side: parsed.side, error: parsed.error };

    const result = this.withTx(():
      | { ok: true; caseId: string; revisionId: string; revisionNo: number; reused: boolean; diffCount: number }
      | { ok: false; side: 'before' | 'after'; error: ParseError } => {
      let caseId = input.caseId ?? null;
      let title = input.title?.trim() || '未命名审议单';
      if (caseId) {
        const existing = this.db.prepare('SELECT id, title FROM cases WHERE id = ?').get(caseId) as
          | { id: string; title: string }
          | undefined;
        if (!existing) return { ok: false, side: 'after', error: { message: `审议单不存在: ${caseId}`, path: '/', line: 0, column: 0 } };
        title = existing.title;
      } else {
        caseId = randomUUID();
        this.db.prepare('INSERT INTO cases (id, title, created_at) VALUES (?, ?, ?)').run(caseId, title, this.isoNow());
      }

      const beforeHash = parsed.beforeParsed.contentHash;
      const afterHash = parsed.afterParsed.contentHash;
      const beforeSummary = JSON.stringify(parsed.beforeNorm.summary);
      const afterSummary = JSON.stringify(parsed.afterNorm.summary);

      const same = this.db
        .prepare('SELECT * FROM revisions WHERE case_id = ? AND before_hash = ? AND after_hash = ?')
        .get(caseId, beforeHash, afterHash) as RevisionRow | undefined;
      if (same) {
        const count = (this.db.prepare('SELECT COUNT(*) AS c FROM diffs WHERE revision_id = ?').get(same.id) as { c: number }).c;
        return { ok: true, caseId, revisionId: same.id, revisionNo: same.revision_no, reused: true, diffCount: count };
      }

      const revNoRow = this.db.prepare('SELECT COALESCE(MAX(revision_no), 0) + 1 AS next FROM revisions WHERE case_id = ?').get(caseId) as {
        next: number;
      };
      const revisionId = randomUUID();
      const createdAt = this.isoNow();

      const oldActive = this.db.prepare('SELECT id FROM revisions WHERE case_id = ? AND active = 1').get(caseId) as
        | { id: string }
        | undefined;
      if (oldActive) {
        this.db.prepare('UPDATE revisions SET active = 0 WHERE id = ?').run(oldActive.id);
      }

      this.db
        .prepare(
          `INSERT INTO revisions
            (id, case_id, revision_no, active, before_hash, after_hash, before_summary, after_summary, created_at)
           VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)`
        )
        .run(revisionId, caseId, revNoRow.next, beforeHash, afterHash, beforeSummary, afterSummary, createdAt);

      const insertDiff = this.db.prepare(
        `INSERT INTO diffs (id, revision_id, diff_key, category, scope, subject, before_json, after_json, impact)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      const newDiffs: Array<{ id: string; raw: RawDiff }> = [];
      for (const raw of parsed.diffs) {
        const id = randomUUID();
        insertDiff.run(
          id,
          revisionId,
          raw.key,
          raw.category,
          raw.scope,
          raw.subject,
          JSON.stringify(raw.beforeJson),
          JSON.stringify(raw.afterJson),
          buildImpact(raw)
        );
        newDiffs.push({ id, raw });
      }

      this.insertEvent(this.db, {
        caseId,
        kind: 'revision-created',
        revisionId,
        beforeSummary,
        afterSummary
      });

      // 继承：仅当旧活动修订存在且 diff_key 完全一致时，连同事件链一并继承
      if (oldActive) {
        const oldDiffs = this.db
          .prepare('SELECT id, diff_key FROM diffs WHERE revision_id = ?')
          .all(oldActive.id) as Array<{ id: string; diff_key: string }>;
        const newByKey = new Map(newDiffs.map((d) => [d.raw.key, d.id]));
        for (const old of oldDiffs) {
          const newDiffId = newByKey.get(old.diff_key);
          if (!newDiffId) continue;
          const decision = this.db.prepare('SELECT * FROM decisions WHERE diff_id = ?').get(old.id) as DecisionRow | undefined;
          if (!decision) continue;
          this.db
            .prepare(
              `INSERT INTO decisions
                (id, diff_id, base_version, state, actor, rationale, expires_at, decided_at, before_summary, after_summary)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            )
            .run(
              randomUUID(),
              newDiffId,
              0,
              decision.state,
              decision.actor,
              decision.rationale,
              decision.expires_at,
              decision.decided_at,
              beforeSummary,
              afterSummary
            );
          this.insertEvent(this.db, {
            caseId,
            kind: 'decision-inherited',
            revisionId,
            diffId: newDiffId,
            fromRevisionId: oldActive.id,
            state: decision.state,
            actor: decision.actor,
            rationale: decision.rationale,
            expiresAt: decision.expires_at,
            beforeSummary,
            afterSummary
          });
        }
      }

      return { ok: true, caseId, revisionId, revisionNo: revNoRow.next, reused: false, diffCount: newDiffs.length };
    });

    return result;
  }

  decide(
    caseId: string,
    diffId: string,
    baseVersion: number,
    decision: RawDecision
  ): { ok: true; decision: DecisionRecord; version: number } | { ok: false; code: 'not-found' | 'conflict'; payload?: ConflictPayload } {
    const diff = this.db
      .prepare(
        `SELECT d.id AS id, d.revision_id AS revision_id, r.case_id AS case_id
         FROM diffs d JOIN revisions r ON r.id = d.revision_id
         WHERE d.id = ? AND r.case_id = ? AND r.active = 1`
      )
      .get(diffId, caseId) as { id: string; revision_id: string; case_id: string } | undefined;
    if (!diff) return { ok: false, code: 'not-found' };

    if (!decision.actor.trim()) {
      throw Object.assign(new Error('操作者不能为空'), { status: 400 });
    }
    if (!decision.rationale.trim()) {
      throw Object.assign(new Error('理由不能为空'), { status: 400 });
    }
    if (!['accepted', 'rejected', 'exempted'].includes(decision.state)) {
      throw Object.assign(new Error('非法决议状态'), { status: 400 });
    }
    let expiresAt: string | null = null;
    if (decision.state === 'exempted') {
      if (!decision.expiresAt) throw Object.assign(new Error('豁免必须提供期限'), { status: 400 });
      const ts = Date.parse(decision.expiresAt);
      if (Number.isNaN(ts)) throw Object.assign(new Error('豁免期限格式非法'), { status: 400 });
      expiresAt = new Date(ts).toISOString();
    }

    return this.withTx(() => {
      const countRow = this.db.prepare('SELECT COUNT(*) AS c FROM decisions WHERE diff_id = ?').get(diffId) as { c: number };
      const currentVersion = countRow.c;
      if (currentVersion !== baseVersion) {
        const current = this.db.prepare('SELECT * FROM decisions WHERE diff_id = ? ORDER BY rowid DESC LIMIT 1').get(diffId) as
          | DecisionRow
          | undefined;
        return {
          ok: false as const,
          code: 'conflict' as const,
          payload: {
            conflict: true as const,
            diffId,
            baseVersion,
            currentVersion,
            submitted: {
              actor: decision.actor,
              state: decision.state,
              rationale: decision.rationale,
              expiresAt
            },
            current: current ? this.rowToDecision(current, currentVersion) : null
          }
        };
      }

      const revision = this.db.prepare('SELECT before_summary, after_summary FROM revisions WHERE id = ?').get(diff.revision_id) as {
        before_summary: string;
        after_summary: string;
      };
      const id = randomUUID();
      const decidedAt = this.isoNow();
      this.db
        .prepare(
          `INSERT INTO decisions
            (id, diff_id, base_version, state, actor, rationale, expires_at, decided_at, before_summary, after_summary)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          id,
          diffId,
          baseVersion,
          decision.state,
          decision.actor.trim(),
          decision.rationale.trim(),
          expiresAt,
          decidedAt,
          revision.before_summary,
          revision.after_summary
        );
      const eventNo = this.insertEvent(this.db, {
        caseId,
        kind: 'decision-made',
        revisionId: diff.revision_id,
        diffId,
        state: decision.state,
        actor: decision.actor.trim(),
        rationale: decision.rationale.trim(),
        expiresAt,
        beforeSummary: revision.before_summary,
        afterSummary: revision.after_summary
      });

      const record: DecisionRecord = {
        id,
        diffId,
        eventNo,
        baseVersion,
        state: decision.state,
        actor: decision.actor.trim(),
        rationale: decision.rationale.trim(),
        expiresAt,
        decidedAt,
        beforeSummary: JSON.parse(revision.before_summary) as DocSummary,
        afterSummary: JSON.parse(revision.after_summary) as DocSummary
      };
      return { ok: true as const, decision: record, version: currentVersion + 1 };
    });
  }

  private rowToDecision(row: DecisionRow, version: number): DecisionRecord {
    return {
      id: row.id,
      diffId: row.diff_id,
      eventNo: 0,
      baseVersion: row.base_version,
      state: row.state,
      actor: row.actor,
      rationale: row.rationale,
      expiresAt: row.expires_at,
      decidedAt: row.decided_at,
      beforeSummary: JSON.parse(row.before_summary) as DocSummary,
      afterSummary: JSON.parse(row.after_summary) as DocSummary
    };
  }

  listCases(): Array<{ id: string; title: string; createdAt: string; revisionCount: number; activeRevisionNo: number | null }> {
    const rows = this.db
      .prepare(
        `SELECT c.id AS id, c.title AS title, c.created_at AS created_at,
                COUNT(r.id) AS revision_count,
                MAX(CASE WHEN r.active = 1 THEN r.revision_no END) AS active_revision_no
         FROM cases c LEFT JOIN revisions r ON r.case_id = c.id
         GROUP BY c.id ORDER BY c.created_at DESC`
      )
      .all() as Array<{ id: string; title: string; created_at: string; revision_count: number; active_revision_no: number | null }>;
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      createdAt: r.created_at,
      revisionCount: r.revision_count,
      activeRevisionNo: r.active_revision_no
    }));
  }

  getCase(caseId: string): RevisionView | null {
    const revision = this.db
      .prepare('SELECT * FROM revisions WHERE case_id = ? AND active = 1')
      .get(caseId) as RevisionRow | undefined;
    if (!revision) return null;
    return this.getRevision(revision.id);
  }

  getRevision(revisionId: string): RevisionView | null {
    const revision = this.db.prepare('SELECT * FROM revisions WHERE id = ?').get(revisionId) as RevisionRow | undefined;
    if (!revision) return null;
    const diffRows = this.db.prepare('SELECT * FROM diffs WHERE revision_id = ? ORDER BY diff_key').all(revisionId) as unknown as DiffRow[];

    const revisionNos = this.db
      .prepare('SELECT id, revision_no, active, created_at FROM revisions WHERE case_id = ? ORDER BY revision_no')
      .all(revision.case_id) as Array<{ id: string; revision_no: number; active: number; created_at: string }>;
    const titleRow = this.db.prepare('SELECT title FROM cases WHERE id = ?').get(revision.case_id) as { title: string } | undefined;

    const diffs = diffRows.map((d) => {
      const decisionRows = this.db
        .prepare('SELECT * FROM decisions WHERE diff_id = ? ORDER BY rowid')
        .all(d.id) as unknown as DecisionRow[];
      const version = decisionRows.length;
      const latest = decisionRows[decisionRows.length - 1] ?? null;
      let decision: EffectiveDecision | null = null;
      if (latest) {
        const base = this.rowToDecision(latest, version);
        // 事件号取该 diff 最近一次“做出决议”的事件；继承决议没有独立新决议事件，继承事件单独可查
        const evt = this.db
          .prepare(
            "SELECT event_no FROM events WHERE diff_id = ? AND kind IN ('decision-made','decision-inherited') ORDER BY event_no DESC LIMIT 1"
          )
          .get(d.id) as { event_no: number } | undefined;
        base.eventNo = evt?.event_no ?? 0;
        const expiresAt: string | null = base.expiresAt ?? null;
        const expired = base.state === 'exempted' && expiresAt !== null && this.clock.now().getTime() > Date.parse(expiresAt);
        decision = {
          ...base,
          expired,
          effectiveState: expired ? 'rejected' : base.state
        };
      }
      return {
        id: d.id,
        key: d.diff_key,
        category: d.category,
        scope: d.scope,
        subject: d.subject,
        beforeJson: JSON.parse(d.before_json),
        afterJson: JSON.parse(d.after_json),
        impact: d.impact,
        decision,
        version
      };
    });

    const view: RevisionView = {
      id: revision.id,
      caseId: revision.case_id,
      title: titleRow?.title,
      revisions: revisionNos.map((r) => ({ id: r.id, revisionNo: r.revision_no, active: r.active === 1, createdAt: r.created_at })),
      revisionNo: revision.revision_no,
      createdAt: revision.created_at,
      readOnly: revision.active !== 1,
      beforeSummary: JSON.parse(revision.before_summary) as DocSummary,
      afterSummary: JSON.parse(revision.after_summary) as DocSummary,
      diffs
    };
    return view;
  }

  getEvents(caseId: string): Array<Record<string, unknown>> {
    return (
      this.db
        .prepare('SELECT * FROM events WHERE case_id = ? ORDER BY event_no')
        .all(caseId) as Array<Record<string, unknown>>
    ).map((e) => ({
      eventNo: e.event_no,
      kind: e.kind,
      revisionId: e.revision_id,
      diffId: e.diff_id,
      fromRevisionId: e.from_revision_id,
      state: e.state,
      actor: e.actor,
      rationale: e.rationale,
      expiresAt: e.expires_at,
      createdAt: e.created_at
    }));
  }
}
