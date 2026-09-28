import { parseDocument } from 'yaml';

export interface ParseFailure {
  ok: false;
  document: 'before' | 'after';
  message: string;
  line: number | null;
  col: number | null;
  snippet: string | null;
}

export interface ParseSuccess {
  ok: true;
  doc: unknown;
}

export type ParseResult = ParseSuccess | ParseFailure;

function snippetAt(text: string, line: number | null): string | null {
  if (line === null) return null;
  const lines = text.split('\n');
  if (line < 1 || line > lines.length) return null;
  for (let i = line; i >= Math.max(1, line - 3); i -= 1) {
    const content = lines[i - 1].trim();
    if (content) return `${i}: ${content}`.slice(0, 200);
  }
  return lines[line - 1].trim().slice(0, 200) || null;
}

export function parseOpenApiText(text: string, which: 'before' | 'after'): ParseResult {
  if (!text || !text.trim()) {
    return { ok: false, document: which, message: '文档内容为空', line: null, col: null, snippet: null };
  }
  let parsed: unknown;
  try {
    const document = parseDocument(text, { prettyErrors: true });
    if (document.errors.length > 0) {
      const err = document.errors[0];
      const linePos = err.linePos?.[0];
      return {
        ok: false,
        document: which,
        message: err.message.split('\n')[0],
        line: linePos?.line ?? null,
        col: linePos?.col ?? null,
        snippet: snippetAt(text, linePos?.line ?? null),
      };
    }
    parsed = document.toJS();
  } catch (err) {
    return {
      ok: false,
      document: which,
      message: err instanceof Error ? err.message : String(err),
      line: null,
      col: null,
      snippet: null,
    };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      ok: false,
      document: which,
      message: '文档根节点必须是对象（OpenAPI 文档）',
      line: null,
      col: null,
      snippet: null,
    };
  }
  const root = parsed as Record<string, unknown>;
  if (typeof root.openapi !== 'string' && typeof root.swagger !== 'string') {
    return {
      ok: false,
      document: which,
      message: '缺少 openapi 版本字段，不是有效的 OpenAPI 文档',
      line: null,
      col: null,
      snippet: null,
    };
  }
  if (root.paths !== undefined && (typeof root.paths !== 'object' || root.paths === null)) {
    return {
      ok: false,
      document: which,
      message: 'paths 字段必须是对象',
      line: null,
      col: null,
      snippet: null,
    };
  }
  return { ok: true, doc: parsed };
}
