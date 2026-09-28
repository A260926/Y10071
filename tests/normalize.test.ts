import { describe, expect, it } from 'vitest';
import { parseOpenApiText } from '../src/parse.js';
import { canonicalHash, normalizeSchema, normalizeSpec, stableStringify } from '../src/normalize.js';
import { diffSpecs } from '../src/diff.js';
import { fixtureDiffs, loadDoc } from './helpers.js';

function specOf(text: string) {
  const result = parseOpenApiText(text, 'before');
  if (!result.ok) throw new Error(result.message);
  return normalizeSpec(result.doc);
}

describe('规范化', () => {
  it('属性顺序与排版变化产生相同规范化哈希', () => {
    const jsonText = JSON.stringify({
      openapi: '3.0.3',
      info: { title: 'T', version: '1.0.0' },
      paths: {
        '/x': {
          get: {
            responses: {
              '200': {
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      required: ['a', 'b'],
                      properties: {
                        b: { type: 'string' },
                        a: { enum: ['z', 'a', 'm'], type: 'string' },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });
    const yamlText = `
openapi: 3.0.3
info: {version: 1.0.0, title: T}
paths:
  /x:
    get:
      responses:
        '200':
          content:
            application/json:
              schema:
                type: object
                required: [b, a]
                properties:
                  a: {type: string, enum: [m, z, a]}
                  b: {type: string}
`;
    expect(canonicalHash(specOf(jsonText))).toBe(canonicalHash(specOf(yamlText)));
    expect(diffSpecs(specOf(jsonText), specOf(yamlText))).toHaveLength(0);
  });

  it('只有描述变化不产生差异', () => {
    expect(fixtureDiffs('description-only')).toHaveLength(0);
    expect(loadDoc('description-only', 'before').summary.sha256).toBe(
      loadDoc('description-only', 'after').summary.sha256,
    );
  });

  it('引用循环不会无限递归并保留循环标记', () => {
    const before = loadDoc('circular-refs', 'before').spec;
    const after = loadDoc('circular-refs', 'after').spec;
    const serialized = stableStringify(before);
    expect(serialized).toContain('circularRef');
    const diffs = diffSpecs(before, after);
    const required = diffs.filter((d) => d.category === 'required-changed');
    expect(required).toHaveLength(1);
    expect(required[0].detail).toMatchObject({ property: 'weight', change: 'added' });
  });

  it('allOf 合并 required 与 properties', () => {
    const merged = normalizeSchema(
      {
        allOf: [
          { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
          { type: 'object', required: ['name'], properties: { name: { type: 'string' } } },
        ],
      },
      {},
      [],
    );
    expect(merged.required).toEqual(['id', 'name']);
    expect(Object.keys(merged.properties ?? {})).toEqual(['id', 'name']);
    const diffs = fixtureDiffs('allof-merge');
    expect(diffs.filter((d) => d.category === 'required-changed')).toHaveLength(1);
  });

  it('同名属性在不同作用域下分别定位', () => {
    const diffs = fixtureDiffs('same-name-scopes');
    const typeChanges = diffs.filter((d) => d.category === 'type-changed');
    expect(typeChanges).toHaveLength(1);
    expect(typeChanges[0].location).toBe('GET /b/things');
    expect(typeChanges[0].subject).toContain('/properties/name');
  });

  it('breaking-change fixture 覆盖五个核心类别', () => {
    const categories = new Set(fixtureDiffs('breaking-change').map((d) => d.category));
    expect(categories).toEqual(
      new Set([
        'path-param-renamed',
        'required-changed',
        'enum-narrowed',
        'response-removed',
        'nullable-changed',
      ]),
    );
  });

  it('OpenAPI 3.1 type 数组中的 null 规范化为 nullable', () => {
    const spec = specOf(`
openapi: 3.1.0
info: {title: T, version: 1}
paths:
  /x:
    get:
      responses:
        '200':
          content:
            application/json:
              schema: {type: object, properties: {v: {type: [string, "null"]}}}
`);
    expect(spec.operations[0].responses['200']['application/json'].properties?.v.nullable).toBe(true);
  });
});
