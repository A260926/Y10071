import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Store, ValidationError } from '../src/store.js';
import { parseOpenApiText } from '../src/parse.js';
import { normalizeSpec, summarizeDoc } from '../src/normalize.js';
import { diffSpecs } from '../src/diff.js';
import { buildStorePair, loadDoc } from './helpers.js';

function rawFixture(name: string, which: 'before' | 'after'): string {
  const dir = join(process.cwd(), 'fixtures', name);
  return readFileSync(join(dir, `${which}.yaml`), 'utf-8');
}

describe('修订与决议继承', () => {
  let store: Store;
  let ticketId: string;

  beforeEach(() => {
    store = new Store(':memory:');
    ticketId = store.createTicket('ticket-title').id;
  });

  function upload(name: string) {
    const before = loadDoc(name, 'before');
    const after = loadDoc(name, 'after');
    const diffs = diffSpecs(before.spec, after.spec);
    return store.addRevision(ticketId, before, after, diffs);
  }

  function uploadPair(texts: { before: string; after: string }) {
    const b = parseOpenApiText(texts.before, 'before');
    const a = parseOpenApiText(texts.after, 'after');
    if (!b.ok || !a.ok) throw new Error('测试夹具解析失败');
    const beforeSpec = normalizeSpec(b.doc);
    const afterSpec = normalizeSpec(a.doc);
    return store.addRevision(
      ticketId,
      { doc: b.doc, spec: beforeSpec, summary: summarizeDoc(b.doc, beforeSpec) },
      { doc: a.doc, spec: afterSpec, summary: summarizeDoc(a.doc, afterSpec) },
      diffSpecs(beforeSpec, afterSpec),
    );
  }

  it('首次上传生成修订 #1 与规范化差异', () => {
    const result = upload('breaking-change');
    expect(result.reused).toBe(false);
    expect(result.revision.seq).toBe(1);
    const view = store.getTicketView(ticketId);
    expect(view.diffs).toHaveLength(5);
  });

  it('内容相同排版不同复用同一修订且保留决议', () => {
    const first = upload('breaking-change');
    const view1 = store.getTicketView(ticketId) as Record<string, unknown>;
    const diffs = view1.diffs as Array<{ identity: string }>;
    store.saveDecision(ticketId, diffs[0].identity, {
      status: 'accepted',
      reason: '可接受',
      operator: 'alice',
      expectedVersion: 0,
    });

    const b = parseOpenApiText(rawFixture('breaking-change', 'before'), 'before');
    const a = parseOpenApiText(rawFixture('breaking-change', 'after'), 'after');
    if (!b.ok || !a.ok) throw new Error('夹具解析失败');
    const second = store.addRevision(
      ticketId,
      buildStorePair(JSON.parse(JSON.stringify(b.doc))),
      buildStorePair(JSON.parse(JSON.stringify(a.doc))),
      [],
    );
    expect(second.reused).toBe(true);
    expect(second.revision.id).toBe(first.revision.id);
    expect(second.inherited).toBe(1);
    const view2 = store.getTicketView(ticketId) as Record<string, unknown>;
    const decided = (view2.diffs as Array<{ decision: { version: number } | null }>).find(
      (d) => d.decision !== null,
    );
    expect(decided!.decision!.version).toBe(1);
  });

  it('内容真变化生成新修订，持续存在的差异继承决议', () => {
    upload('breaking-change');
    const view1 = store.getTicketView(ticketId) as Record<string, unknown>;
    const enumDiff = (view1.diffs as Array<{ category: string; identity: string }>).find(
      (d) => d.category === 'enum-narrowed',
    )!;
    store.saveDecision(ticketId, enumDiff.identity, {
      status: 'rejected',
      reason: '不能收窄',
      operator: 'bob',
      expectedVersion: 0,
    });

    const before = loadDoc('breaking-change', 'before');
    const afterDoc = JSON.parse(JSON.stringify(loadDoc('breaking-change', 'after').doc)) as {
      components: { schemas: { User: { properties: Record<string, unknown> } } };
    };
    afterDoc.components.schemas.User.properties.nickname = { type: 'string' };
    const second = store.addRevision(
      ticketId,
      before,
      buildStorePair(afterDoc),
      diffSpecs(before.spec, normalizeSpec(afterDoc)),
    );
    expect(second.reused).toBe(false);
    expect(second.revision.seq).toBe(2);
    expect(second.inherited).toBe(1);

    const view2 = store.getTicketView(ticketId) as Record<string, unknown>;
    const inherited = (view2.diffs as Array<{ identity: string; decision: unknown }>).find(
      (d) => d.identity === enumDiff.identity,
    );
    expect(inherited?.decision).not.toBeNull();
  });

  it('新修订中消失的差异不能再被决议（旧修订只读）', () => {
    const beforeText = `
openapi: 3.0.3
info: {title: T, version: '1'}
paths:
  /things:
    get:
      parameters:
        - {name: debug, in: query, schema: {type: boolean}}
      responses: { '200': { description: ok } }
`;
    const afterText = `
openapi: 3.0.3
info: {title: T, version: '2'}
paths:
  /things:
    get:
      responses: { '200': { description: ok } }
`;
    uploadPair({ before: beforeText, after: afterText });
    let view = store.getTicketView(ticketId) as Record<string, unknown>;
    const removed = (view.diffs as Array<{ identity: string }>)[0];
    store.saveDecision(ticketId, removed.identity, {
      status: 'accepted',
      reason: '移除参数可接受',
      operator: 'carol',
      expectedVersion: 0,
    });

    const afterText2 = `
openapi: 3.0.3
info: {title: T, version: '3'}
paths:
  /things:
    get:
      parameters:
        - {name: debug, in: query, schema: {type: boolean}}
      responses: { '200': { description: ok } }
`;
    const second = uploadPair({ before: beforeText, after: afterText2 });
    expect(second.reused).toBe(false);
    view = store.getTicketView(ticketId);
    expect(view.diffs).toHaveLength(0);
    expect(() =>
      store.saveDecision(ticketId, removed.identity, {
        status: 'rejected',
        reason: '旧差异不应可改',
        operator: 'carol',
        expectedVersion: 1,
      }),
    ).toThrow(ValidationError);
  });

  it('旧修订在视图中标记为只读', () => {
    upload('breaking-change');
    const before = loadDoc('breaking-change', 'before');
    const afterDoc = JSON.parse(JSON.stringify(loadDoc('breaking-change', 'after').doc)) as {
      components: { schemas: { User: { properties: Record<string, unknown> } } };
    };
    afterDoc.components.schemas.User.properties.nickname = { type: 'string' };
    store.addRevision(ticketId, before, buildStorePair(afterDoc), diffSpecs(before.spec, normalizeSpec(afterDoc)));
    const view = store.getTicketView(ticketId) as Record<string, unknown>;
    const revisions = view.revisions as Array<{ seq: number; readOnly: boolean }>;
    expect(revisions.map((r) => [r.seq, r.readOnly])).toEqual([
      [2, false],
      [1, true],
    ]);
  });
});
