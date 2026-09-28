import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseOpenApiText } from '../src/parse.js';
import { normalizeSpec, summarizeDoc, type NormalizedSpec, type DocSummary } from '../src/normalize.js';
import { diffSpecs, type DiffEntry } from '../src/diff.js';

export interface LoadedDoc {
  doc: unknown;
  spec: NormalizedSpec;
  summary: DocSummary;
}

export function loadDoc(name: string, which: 'before' | 'after'): LoadedDoc {
  const dir = join(process.cwd(), 'fixtures', name);
  const file = ['yaml', 'yml', 'json']
    .map((ext) => join(dir, `${which}.${ext}`))
    .find((candidate) => existsSync(candidate));
  if (!file) throw new Error(`fixture 不存在: ${name}/${which}`);
  const result = parseOpenApiText(readFileSync(file, 'utf-8'), which);
  if (!result.ok) throw new Error(`fixture 解析失败 ${name}/${which}: ${result.message}`);
  const spec = normalizeSpec(result.doc);
  return { doc: result.doc, spec, summary: summarizeDoc(result.doc, spec) };
}

export function fixtureDiffs(name: string): DiffEntry[] {
  return diffSpecs(loadDoc(name, 'before').spec, loadDoc(name, 'after').spec);
}

export function buildStorePair(doc: unknown) {
  const spec = normalizeSpec(doc);
  return { doc, spec, summary: summarizeDoc(doc, spec) };
}
