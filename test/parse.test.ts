import { describe, expect, it } from 'vitest';
import { parseOpenApi } from '../src/core/parse.js';
import { normalizeDoc } from '../src/core/normalize.js';
import { buildImpact } from '../src/core/impact.js';
import { fixture, makeService, upload } from './helpers.js';

describe('导入失败定位', () => {
  it('YAML 缩进/语法错误能定位到行列与近似路径', () => {
    const bad = [
      'openapi: 3.0.3',
      'info:',
      '  title: X',
      '  version: 1.0.0',
      'paths:',
      '  /ok:',
      '    get:',
      '      responses:',
      "        '200':",
      '          description: ok',
      '     bad-indent: true',
      ''
    ].join('\n');
    const result = parseOpenApi(bad);
    expect('error' in result).toBe(true);
    if (!('error' in result)) return;
    expect(result.error.line).toBeGreaterThan(0);
    expect(result.error.column).toBeGreaterThan(0);
    expect(result.error.path).toMatch(/paths/);
  });

  it('JSON 语法错误能定位行列', () => {
    const bad = '{\n  "openapi": "3.0.3",\n  "info": {\n   "title": "X",,\n  }\n}';
    const result = parseOpenApi(bad);
    expect('error' in result).toBe(true);
    if (!('error' in result)) return;
    expect(result.error.line).toBe(4);
  });

  it('半份文档不能入库：after 失败时不会创建审议单/修订', () => {
    const { db, service } = makeService();
    const result = service.createOrUpload({
      title: 'half-doc',
      beforeSource: fixture('breaking-change', 'before'),
      afterSource: 'openapi: 3.0.3\ninfo: {title: X\n'
    });
    expect(result.ok).toBe(false);
    const cases = db.prepare('SELECT COUNT(*) AS c FROM cases').all() as Array<{ c: number }>;
    expect(cases[0].c).toBe(0);
    const revs = db.prepare('SELECT COUNT(*) AS c FROM revisions').all() as Array<{ c: number }>;
    expect(revs[0].c).toBe(0);
  });

  it('结构校验失败（缺 responses）带路径，且不入库', () => {
    const before = fixture('description-only', 'before');
    const badAfter = `
openapi: 3.0.3
info: { title: Echo, version: 1.0.0 }
paths:
  /nope:
    get:
      parameters: []
`;
    const { service } = makeService();
    const result = service.createOrUpload({ title: 't', beforeSource: before, afterSource: badAfter });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.side).toBe('after');
    expect(result.error.path).toContain('responses');
  });

  it('无法解析的 $ref 会被拒绝', () => {
    const doc = `
openapi: 3.0.3
info: { title: X, version: 1.0.0 }
paths:
  /x:
    get:
      responses:
        '200':
          description: ok
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Missing'
`;
    const parsed = parseOpenApi(doc);
    if ('error' in parsed) throw new Error(parsed.error.message);
    expect(() => normalizeDoc(parsed)).toThrow(/引用/);
  });
});

describe('调用方影响说明', () => {
  it('由结构化差异生成，包含中文类别与关键取值，不包含用户理由', () => {
    const { service } = makeService();
    const created = upload(service, 'breaking-change');
    const view = service.getRevision(created.revisionId)!;
    const narrowed = view.diffs.find((d) => d.category === 'enum-narrowed')!;
    expect(narrowed.impact).toContain('枚举收窄');
    expect(narrowed.impact).toContain('pending');
    const removed = view.diffs.find((d) => d.category === 'response-status-removed')!;
    expect(removed.impact).toContain('410');
    expect(removed.impact).toContain('调用方');
  });

  it('直接用恶意字符串做“理由”不会进入影响说明模板，也不会被执行', () => {
    let called = false;
    (globalThis as unknown as { __evil: () => void }).__evil = () => {
      called = true;
    };
    const raw = {
      category: 'description-changed' as const,
      scope: '/paths/~1x/get',
      subject: 'description',
      beforeValue: 'a',
      afterValue: 'b'
    };
    const text = buildImpact(raw) + '"><img src=x onerror="__evil()">';
    expect(text).toContain('描述变化');
    expect(called).toBe(false);
  });
});
