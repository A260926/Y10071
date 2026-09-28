import { createHash } from 'node:crypto';

function stableStringify(value: unknown, indent: number, level: number): string {
  if (value === null) return 'null';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('文档中出现了非有限数值');
    return JSON.stringify(value);
  }
  if (typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    const pad = ' '.repeat(indent * (level + 1));
    const close = ' '.repeat(indent * level);
    return `[\n${value.map((v) => pad + stableStringify(v, indent, level + 1)).join(',\n')}\n${close}]`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    if (entries.length === 0) return '{}';
    const pad = ' '.repeat(indent * (level + 1));
    const close = ' '.repeat(indent * level);
    const body = entries
      .map(([k, v]) => `${JSON.stringify(k)}: ${stableStringify(v, indent, level + 1)}`)
      .join(',\n');
    return `{\n${pad}${body}\n${close}}`;
  }
  throw new Error(`无法规范化的类型: ${typeof value}`);
}

/** 与属性顺序无关的规范化文本：对象键排序、统一缩进。 */
export function canonicalText(value: unknown, indent = 2): string {
  return stableStringify(value, indent, 0);
}

export function contentHash(value: unknown): string {
  return createHash('sha256').update(canonicalText(value)).digest('hex');
}
