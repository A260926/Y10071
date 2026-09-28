import { describe, expect, it } from 'vitest';
import { parseOpenApi } from '../src/core/parse.js';
import { normalizeDoc } from '../src/core/normalize.js';
import { diffOperations } from '../src/core/diff.js';
import { fixture } from './helpers.js';

function diffsOf(name: string) {
  const b = parseOpenApi(fixture(name, 'before'));
  const a = parseOpenApi(fixture(name, 'after'));
  if ('error' in b) throw new Error(b.error.message);
  if ('error' in a) throw new Error(a.error.message);
  return diffOperations(normalizeDoc(b), normalizeDoc(a));
}

describe('规范化差异', () => {
  it('属性顺序变化不算变化（allOf 合并后与扁平结构等价）', () => {
    const diffs = diffsOf('allof-merge');
    expect(diffs).toHaveLength(0);
  });

  it('仅描述变化只产生 description-changed，且不产生结构差异', () => {
    const diffs = diffsOf('description-only');
    expect(diffs.length).toBeGreaterThanOrEqual(1);
    expect(diffs.every((d) => d.category === 'description-changed')).toBe(true);
  });

  it('循环 $ref 不会死循环，且能在引用结构内识别枚举收窄与必填变化', () => {
    const diffs = diffsOf('circular-ref');
    const cats = diffs.map((d) => d.category).sort();
    expect(cats).toContain('enum-narrowed');
    expect(cats).toContain('required-added');
    expect(cats).toContain('property-added');
  });

  it('同名 status 在 Ticket 与 User 两个作用域下互不串味：嵌套在 creator(User) 下的 status 不算变化', () => {
    const diffs = diffsOf('name-shadowing');
    const enumDiffs = diffs.filter((d) => d.category === 'enum-narrowed');
    expect(enumDiffs).toHaveLength(1);
    // 顶层 Ticket.status 的收窄位于 response schema/properties/status；
    // 嵌套 creator(User).status 没有被误报（否则会有两条 enum-narrowed）
    expect(enumDiffs[0].scope).toMatch(/properties\/status$/);
    expect(enumDiffs[0].scope).not.toMatch(/creator/);
  });

  it('breaking-change 示例覆盖：参数改名、required、枚举收窄、响应状态消失、nullable', () => {
    const diffs = diffsOf('breaking-change');
    const cats = new Set(diffs.map((d) => d.category));
    expect(cats.has('parameter-renamed')).toBe(true);
    expect(cats.has('required-added')).toBe(true);
    expect(cats.has('enum-narrowed')).toBe(true);
    expect(cats.has('response-status-removed')).toBe(true);
    expect(cats.has('nullable-removed')).toBe(true);
    expect(cats.has('property-added')).toBe(true);
  });

  it('同一份文档与自身比较时没有任何差异（含循环引用）', () => {
    const src = fixture('circular-ref', 'before');
    const p1 = parseOpenApi(src);
    const p2 = parseOpenApi(src);
    if ('error' in p1 || 'error' in p2) throw new Error('解析失败');
    expect(diffOperations(normalizeDoc(p1), normalizeDoc(p2))).toEqual([]);
  });

  it('JSON 与 YAML 只是排版不同时内容哈希一致', () => {
    const yaml = `
openapi: 3.0.3
info:
  title: X
  version: 1.0.0
paths: {}
`;
    const json = JSON.stringify({
      paths: {},
      openapi: '3.0.3',
      info: { version: '1.0.0', title: 'X' }
    });
    const y = parseOpenApi(yaml);
    const j = parseOpenApi(json);
    if ('error' in y || 'error' in j) throw new Error('解析失败');
    expect(y.contentHash).toBe(j.contentHash);
  });
});

describe('属性顺序', () => {
  it('仅属性声明顺序变化（JSON 重排）不产生任何差异', () => {
    const before = {
      openapi: '3.0.3',
      info: { title: 'O', version: '1.0.0' },
      paths: {
        '/x': {
          get: {
            responses: {
              '200': {
                description: 'ok',
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      required: ['a', 'b'],
                      properties: {
                        a: { type: 'string' },
                        b: { type: 'integer', nullable: false, enum: [1, 2, 3] }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    };
    const after = structuredClone(before);
    const schema = after.paths['/x'].get.responses['200'].content['application/json'].schema;
    schema.properties = { b: schema.properties.b, a: schema.properties.a };
    schema.required = ['b', 'a'];
    schema.properties.b.enum = [3, 2, 1];
    const bParsed = parseOpenApi(JSON.stringify(before));
    const aParsed = parseOpenApi(JSON.stringify(after));
    if ('error' in bParsed || 'error' in aParsed) throw new Error('解析失败');
    expect(diffOperations(normalizeDoc(bParsed), normalizeDoc(aParsed))).toEqual([]);
  });
});
