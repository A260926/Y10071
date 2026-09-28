import { describe, expect, it } from 'vitest';
import { fixture, makeService, upload, FakeClock } from './helpers.js';
import { parseOpenApi } from '../src/core/parse.js';

const makeMutationAfter = (): string => `
openapi: 3.0.3
info: { title: Pet Store, version: 2.1.0 }
paths:
  /pets/{id}:
    get:
      parameters:
        - { name: id, in: path, required: true, schema: { type: integer } }
      responses:
        '200':
          description: ok
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Pet'
    post:
      parameters:
        - { name: id, in: path, required: true, schema: { type: integer } }
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/Pet'
      responses:
        '200': { description: ok }
components:
  schemas:
    Pet:
      type: object
      required: [id, name, status, kind]
      properties:
        id: { type: integer }
        name: { type: string }
        status: { type: string, enum: [available, sold] }
        kind: { type: string }
        nickname: { type: string, nullable: false }
        tag: { type: string }
`;

describe('修订与决议继承', () => {
  it('重新上传排版不同但内容相同的文档：复用修订、不冲掉决议', () => {
    const { service } = makeService();
    const first = upload(service, 'breaking-change');
    const view1 = service.getRevision(first.revisionId)!;
    const enumDiff = view1.diffs.find((d) => d.category === 'enum-narrowed')!;
    const decided = service.decide(first.caseId, enumDiff.id, 0, {
      state: 'accepted',
      actor: 'alice',
      rationale: '已与调用方确认'
    });
    expect(decided.ok).toBe(true);

    const reformatted = (() => {
      const p = parseOpenApi(fixture('breaking-change', 'before'));
      return 'error' in p ? '' : JSON.stringify(p.doc);
    })();

    const again = service.createOrUpload({
      caseId: first.caseId,
      beforeSource: reformatted,
      afterSource: fixture('breaking-change', 'after')
    });
    if (!again.ok) throw new Error(again.error.message);
    expect(again.reused).toBe(true);
    expect(again.revisionNo).toBe(first.revisionNo);

    const view = service.getCase(first.caseId)!;
    const d = view.diffs.find((x) => x.id === enumDiff.id)!;
    expect(d.decision?.actor).toBe('alice');
    expect(d.decision?.state).toBe('accepted');
  });

  it('内容真变化时生成新修订，旧修订只读，相同身份的差异继承决议', () => {
    const { service } = makeService();
    const first = upload(service, 'breaking-change');
    const r1 = service.getRevision(first.revisionId)!;
    const enumDiff = r1.diffs.find((d) => d.category === 'enum-narrowed')!;
    const decided = service.decide(first.caseId, enumDiff.id, 0, {
      state: 'rejected',
      actor: 'bob',
      rationale: '不允许收窄'
    });
    expect(decided.ok).toBe(true);

    const second = service.createOrUpload({
      caseId: first.caseId,
      beforeSource: fixture('breaking-change', 'before'),
      afterSource: makeMutationAfter()
    });
    if (!second.ok) throw new Error(second.error.message);
    expect(second.reused).toBe(false);
    expect(second.revisionNo).toBe(2);

    const oldView = service.getRevision(first.revisionId)!;
    expect(oldView.readOnly).toBe(true);
    const newView = service.getRevision(second.revisionId)!;
    expect(newView.readOnly).toBe(false);

    const inheritedEnum = newView.diffs.find((d) => d.category === 'enum-narrowed')!;
    expect(inheritedEnum.key).toBe(enumDiff.key);
    expect(inheritedEnum.decision?.state).toBe('rejected');
    expect(inheritedEnum.decision?.actor).toBe('bob');
    expect(inheritedEnum.version).toBe(1);

    const tagAdded = newView.diffs.find((d) => d.category === 'property-added' && d.subject === 'tag');
    expect(tagAdded).toBeTruthy();
    expect(tagAdded!.decision).toBeNull();

    const events = service.getEvents(first.caseId);
    const nos = events.map((e) => e.eventNo as number);
    expect(nos).toEqual([...Array(nos.length)].map((_, i) => i + 1));
    expect(events.some((e) => e.kind === 'decision-inherited')).toBe(true);
  });

  it('旧修订只读时不能再写入决议', () => {
    const { service } = makeService();
    const first = upload(service, 'breaking-change');
    const r1 = service.getRevision(first.revisionId)!;
    service.decide(first.caseId, r1.diffs[0].id, 0, { state: 'accepted', actor: 'a', rationale: 'x' });
    service.createOrUpload({
      caseId: first.caseId,
      beforeSource: fixture('breaking-change', 'before'),
      afterSource: makeMutationAfter()
    });
    const res = service.decide(first.caseId, r1.diffs[1].id, 0, { state: 'accepted', actor: 'a', rationale: 'x' });
    expect(res.ok).toBe(false);
    expect((res as { code: string }).code).toBe('not-found');
  });
});

describe('豁免期限（读取时刻推导，无后台改写）', () => {
  it('到期前为 exempted，到期后 effectiveState 推导为 rejected，历史决议行不变', () => {
    const clock = new FakeClock('2026-03-01T00:00:00.000Z');
    const { service, db } = makeService(clock);
    const created = upload(service, 'breaking-change');
    const view = service.getRevision(created.revisionId)!;
    const diff = view.diffs[0];
    const r = service.decide(created.caseId, diff.id, 0, {
      state: 'exempted',
      actor: 'carol',
      rationale: '灰度期间临时放行',
      expiresAt: '2026-04-01T00:00:00Z'
    });
    expect(r.ok).toBe(true);

    clock.set('2026-03-15T00:00:00.000Z');
    const before = service.getCase(created.caseId)!.diffs.find((d) => d.id === diff.id)!;
    expect(before.decision?.effectiveState).toBe('exempted');
    expect(before.decision?.expired).toBe(false);

    clock.set('2026-04-01T00:00:00.001Z');
    const after = service.getCase(created.caseId)!.diffs.find((d) => d.id === diff.id)!;
    expect(after.decision?.expired).toBe(true);
    expect(after.decision?.effectiveState).toBe('rejected');
    expect(after.decision?.state).toBe('exempted');

    const row = db.prepare('SELECT state, expires_at FROM decisions WHERE diff_id = ?').get(diff.id) as {
      state: string;
      expires_at: string;
    };
    expect(row.state).toBe('exempted');
    expect(row.expires_at).toBe('2026-04-01T00:00:00.000Z');
  });

  it('豁免必须带期限', () => {
    const { service } = makeService();
    const created = upload(service, 'breaking-change');
    const diff = service.getRevision(created.revisionId)!.diffs[0];
    expect(() =>
      service.decide(created.caseId, diff.id, 0, { state: 'exempted', actor: 'a', rationale: 'r' })
    ).toThrow(/期限/);
  });
});

describe('并发写入（乐观锁版本号）', () => {
  it('两个页面同时基于版本 0 保存，后保存收到 409 冲突且带双方内容', () => {
    const { service } = makeService();
    const created = upload(service, 'breaking-change');
    const diff = service.getRevision(created.revisionId)!.diffs[0];

    const first = service.decide(created.caseId, diff.id, 0, {
      state: 'accepted',
      actor: 'alice',
      rationale: '甲方理由'
    });
    expect(first.ok).toBe(true);

    const second = service.decide(created.caseId, diff.id, 0, {
      state: 'rejected',
      actor: 'bob',
      rationale: '乙方理由'
    });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.code).toBe('conflict');
    expect(second.payload!.baseVersion).toBe(0);
    expect(second.payload!.currentVersion).toBe(1);
    expect(second.payload!.submitted.actor).toBe('bob');
    expect(second.payload!.current?.actor).toBe('alice');
    expect(second.payload!.current?.rationale).toBe('甲方理由');

    const retry = service.decide(created.caseId, diff.id, 1, {
      state: 'rejected',
      actor: 'bob',
      rationale: '乙方理由'
    });
    expect(retry.ok).toBe(true);
    if (retry.ok) expect(retry.version).toBe(2);
  });
});
