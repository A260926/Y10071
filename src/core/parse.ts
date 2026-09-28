import { parseDocument } from 'yaml';
import { ParseError, ParsedDoc } from './types.js';
import { canonicalText, contentHash } from './canonical.js';

export function detectFormat(source: string): 'json' | 'yaml' {
  const head = source.trimStart();
  if (head.startsWith('{') || head.startsWith('[')) return 'json';
  return 'yaml';
}

function lineColAt(source: string, offset: number): { line: number; column: number } {
  let line = 1;
  let column = 1;
  for (let i = 0; i < offset && i < source.length; i++) {
    if (source[i] === '\n') {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }
  return { line, column };
}

interface PathToken {
  offset: number;
  indent: number;
  key: string | null;
  marker: boolean;
  inlineKey: string | null;
}

const KEY_RE = /^\s*(?:"([^"]+)"|'([^']+)'|([\w.$-]+))\s*:/;

function tokenize(source: string): PathToken[] {
  const tokens: PathToken[] = [];
  const lines = source.split('\n');
  let offset = 0;
  for (const line of lines) {
    const indent = line.length - line.trimStart().length;
    const rest = line.slice(indent);
    if (rest.startsWith('- ') || rest === '-') {
      const afterMarker = rest.slice(rest === '-' ? 1 : 2);
      const m = afterMarker.match(KEY_RE);
      let inlineKey: string | null = null;
      if (m) inlineKey = m[1] ?? m[2] ?? m[3] ?? null;
      tokens.push({ offset: offset + indent, indent, key: null, marker: true, inlineKey });
      if (inlineKey !== null) {
        tokens.push({
          offset: offset + indent + (rest.length - afterMarker.length),
          indent: indent + (rest.length - afterMarker.length),
          key: inlineKey,
          marker: false,
          inlineKey: null
        });
      }
    } else {
      const m = rest.match(KEY_RE);
      if (m) tokens.push({ offset: offset + indent, indent, key: m[1] ?? m[2] ?? m[3] ?? null, marker: false, inlineKey: null });
    }
    offset += line.length + 1;
  }
  return tokens;
}

/** 根据字节偏移，按缩进栈近似还原文档路径（JSON/YAML 均适用）。 */
export function locatePath(source: string, targetOffset: number): string {
  const tokens = tokenize(source);
  const stack: Array<{ indent: number; segment: string }> = [];
  let arrayIndex = -1;
  let arrayIndent = -1;
  for (const tok of tokens) {
    if (tok.offset > targetOffset) break;
    if (tok.marker) {
      while (stack.length && stack[stack.length - 1].indent >= tok.indent) stack.pop();
      if (arrayIndent !== tok.indent) {
        arrayIndent = tok.indent;
        arrayIndex = 0;
      } else {
        arrayIndex += 1;
      }
      while (stack.length && stack[stack.length - 1].indent >= tok.indent) stack.pop();
      stack.push({ indent: tok.indent, segment: String(arrayIndex) });
    } else if (tok.key !== null) {
      while (stack.length && stack[stack.length - 1].indent >= tok.indent) stack.pop();
      stack.push({ indent: tok.indent, segment: tok.key });
    }
  }
  return '/' + stack.map((s) => s.segment).join('/');
}

export function parseOpenApi(source: string, fallbackFormat?: 'json' | 'yaml'): ParsedDoc | { error: ParseError } {
  const format = fallbackFormat ?? detectFormat(source);
  if (!source.trim()) {
    return { error: { message: '文档内容为空', path: '/', line: 1, column: 1 } };
  }

  if (format === 'json') {
    try {
      const doc = JSON.parse(source);
      const pretty = canonicalText(doc);
      return { doc, pretty, contentHash: contentHash(doc), format };
    } catch (err) {
      const message = (err as Error).message;
      const match = /position (\d+)/.exec(message);
      const offset = match ? Number(match[1]) : 0;
      const { line, column } = lineColAt(source, offset);
      return { error: { message, path: locatePath(source, offset), line, column } };
    }
  }

  const yamlDoc = parseDocument(source, { prettyErrors: false });
  if (yamlDoc.errors.length > 0) {
    const first = yamlDoc.errors[0];
    const offset = first.pos[0];
    const { line, column } = lineColAt(source, offset);
    return {
      error: {
        message: first.message,
        path: locatePath(source, offset),
        line,
        column
      }
    };
  }
  const doc = yamlDoc.toJS();
  if (doc === null || typeof doc !== 'object') {
    return { error: { message: 'YAML 顶层不是对象', path: '/', line: 1, column: 1 } };
  }
  return { doc: doc as unknown, pretty: canonicalText(doc), contentHash: contentHash(doc), format };
}
