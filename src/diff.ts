import { createHash } from 'node:crypto';
import type { NormOperation, NormSchema, NormalizedSpec } from './normalize.js';

export type Category =
  | 'path-param-renamed'
  | 'required-changed'
  | 'enum-narrowed'
  | 'enum-widened'
  | 'response-removed'
  | 'response-added'
  | 'nullable-changed'
  | 'type-changed'
  | 'property-removed'
  | 'property-added'
  | 'operation-removed'
  | 'operation-added'
  | 'parameter-removed'
  | 'parameter-added';

export interface DiffEntry {
  identity: string;
  category: Category;
  location: string;
  subject: string;
  detail: Record<string, unknown>;
}

export function diffIdentity(category: string, location: string, subject: string): string {
  return createHash('sha1')
    .update(`${category}|${location}|${subject}`)
    .digest('hex')
    .slice(0, 16);
}

function entry(
  out: DiffEntry[],
  category: Category,
  location: string,
  subject: string,
  detail: Record<string, unknown>,
): void {
  out.push({ identity: diffIdentity(category, location, subject), category, location, subject, detail });
}

function enumKey(value: unknown): string {
  return JSON.stringify(value) ?? 'null';
}

function compareSchemas(
  before: NormSchema,
  after: NormSchema,
  location: string,
  subject: string,
  out: DiffEntry[],
): void {
  if (before.circularRef || after.circularRef) {
    if (before.circularRef !== after.circularRef) {
      entry(out, 'type-changed', location, subject, {
        before: before.circularRef ?? null,
        after: after.circularRef ?? null,
      });
    }
    return;
  }
  if (before.type !== after.type) {
    entry(out, 'type-changed', location, subject, {
      before: before.type ?? null,
      after: after.type ?? null,
    });
  }
  if (Boolean(before.nullable) !== Boolean(after.nullable)) {
    entry(out, 'nullable-changed', location, subject, {
      before: Boolean(before.nullable),
      after: Boolean(after.nullable),
    });
  }
  if (before.enum || after.enum) {
    const bSet = new Set((before.enum ?? []).map(enumKey));
    const aSet = new Set((after.enum ?? []).map(enumKey));
    const removed = [...bSet].filter((v) => !aSet.has(v));
    const added = [...aSet].filter((v) => !bSet.has(v));
    if (removed.length > 0 && added.length === 0) {
      entry(out, 'enum-narrowed', location, subject, {
        before: before.enum ?? null,
        after: after.enum ?? null,
        removed: removed.map((v) => JSON.parse(v)),
      });
    } else if (added.length > 0 && removed.length === 0) {
      entry(out, 'enum-widened', location, subject, {
        before: before.enum ?? null,
        after: after.enum ?? null,
        added: added.map((v) => JSON.parse(v)),
      });
    } else if (removed.length > 0 && added.length > 0) {
      entry(out, 'enum-narrowed', location, subject, {
        before: before.enum ?? null,
        after: after.enum ?? null,
        removed: removed.map((v) => JSON.parse(v)),
        added: added.map((v) => JSON.parse(v)),
      });
    }
  }
  const bReq = new Set(before.required ?? []);
  const aReq = new Set(after.required ?? []);
  for (const name of [...aReq].filter((n) => !bReq.has(n)).sort()) {
    entry(out, 'required-changed', location, `${subject}/required:${name}`, {
      property: name,
      change: 'added',
    });
  }
  for (const name of [...bReq].filter((n) => !aReq.has(n)).sort()) {
    entry(out, 'required-changed', location, `${subject}/required:${name}`, {
      property: name,
      change: 'removed',
    });
  }
  const bProps = before.properties ?? {};
  const aProps = after.properties ?? {};
  for (const name of Object.keys(bProps).sort()) {
    if (!(name in aProps)) {
      entry(out, 'property-removed', location, `${subject}/properties/${name}`, {
        property: name,
        before: bProps[name],
      });
    }
  }
  for (const name of Object.keys(aProps).sort()) {
    if (!(name in bProps)) {
      entry(out, 'property-added', location, `${subject}/properties/${name}`, {
        property: name,
        after: aProps[name],
      });
    }
  }
  for (const name of Object.keys(bProps).sort()) {
    if (name in aProps) {
      compareSchemas(bProps[name], aProps[name], location, `${subject}/properties/${name}`, out);
    }
  }
  if (before.items && after.items) {
    compareSchemas(before.items, after.items, location, `${subject}/items`, out);
  }
}

function compareOperations(
  before: NormOperation,
  after: NormOperation,
  out: DiffEntry[],
  pathRenamed = false,
): void {
  const location = `${after.method} ${after.pathKey}`;
  const bParams = new Map(before.parameters.map((p) => [`${p.in}:${p.name}`, p]));
  const aParams = new Map(after.parameters.map((p) => [`${p.in}:${p.name}`, p]));
  const pairs: Array<[NormOperation['parameters'][number], NormOperation['parameters'][number], string]> = [];
  const usedBefore = new Set<string>();
  const usedAfter = new Set<string>();
  for (const [key, bParam] of [...bParams.entries()].sort()) {
    const aParam = aParams.get(key);
    if (!aParam) continue;
    pairs.push([bParam, aParam, key]);
    usedBefore.add(key);
    usedAfter.add(key);
  }
  if (pathRenamed) {
    const leftBefore = [...bParams.entries()]
      .filter(([key, p]) => !usedBefore.has(key) && p.in === 'path')
      .sort(([x], [y]) => x.localeCompare(y));
    const leftAfter = [...aParams.entries()]
      .filter(([key, p]) => !usedAfter.has(key) && p.in === 'path')
      .sort(([x], [y]) => x.localeCompare(y));
    for (let i = 0; i < Math.min(leftBefore.length, leftAfter.length); i += 1) {
      const [bKey, bParam] = leftBefore[i];
      const [aKey, aParam] = leftAfter[i];
      pairs.push([bParam, aParam, `path:${bKey}->${aKey}`]);
      usedBefore.add(bKey);
      usedAfter.add(aKey);
    }
  }
  for (const [key, param] of [...bParams.entries()].sort()) {
    if (!usedBefore.has(key)) {
      entry(out, 'parameter-removed', location, `parameter:${key}`, {
        in: param.in,
        name: param.name,
      });
    }
  }
  for (const [key, param] of [...aParams.entries()].sort()) {
    if (!usedAfter.has(key)) {
      entry(out, 'parameter-added', location, `parameter:${key}`, {
        in: param.in,
        name: param.name,
        required: param.required,
      });
    }
  }
  for (const [bParam, aParam, key] of pairs) {
    if (bParam.required !== aParam.required) {
      entry(out, 'required-changed', location, `parameter:${key}/required`, {
        in: bParam.in,
        name: bParam.name,
        change: aParam.required ? 'added' : 'removed',
      });
    }
    compareSchemas(bParam.schema, aParam.schema, location, `parameter:${key}/schema`, out);
  }
  for (const mediaType of Object.keys(before.requestBodies).sort()) {
    const afterSchema = after.requestBodies[mediaType];
    if (afterSchema) {
      compareSchemas(
        before.requestBodies[mediaType],
        afterSchema,
        location,
        `requestBody:${mediaType}`,
        out,
      );
    }
  }
  for (const status of Object.keys(before.responses).sort()) {
    if (!(status in after.responses)) {
      entry(out, 'response-removed', location, `response:${status}`, { status });
      continue;
    }
    const bMedia = before.responses[status];
    const aMedia = after.responses[status];
    for (const mediaType of Object.keys(bMedia).sort()) {
      if (aMedia[mediaType]) {
        compareSchemas(
          bMedia[mediaType],
          aMedia[mediaType],
          location,
          `response:${status}:${mediaType}`,
          out,
        );
      }
    }
  }
  for (const status of Object.keys(after.responses).sort()) {
    if (!(status in before.responses)) {
      entry(out, 'response-added', location, `response:${status}`, { status });
    }
  }
}

export function diffSpecs(before: NormalizedSpec, after: NormalizedSpec): DiffEntry[] {
  const out: DiffEntry[] = [];
  const afterByExact = new Map(after.operations.map((op) => [`${op.method} ${op.path}`, op]));
  const afterByErased = new Map(after.operations.map((op) => [`${op.method} ${op.pathKey}`, op]));
  const paired = new Set<NormOperation>();
  for (const bOp of before.operations) {
    const exact = afterByExact.get(`${bOp.method} ${bOp.path}`);
    if (exact) {
      paired.add(exact);
      compareOperations(bOp, exact, out);
      continue;
    }
    const renamed = afterByErased.get(`${bOp.method} ${bOp.pathKey}`);
    if (renamed && !paired.has(renamed)) {
      paired.add(renamed);
      entry(out, 'path-param-renamed', `${bOp.method} ${bOp.pathKey}`, `path:${bOp.pathKey}`, {
        before: bOp.path,
        after: renamed.path,
      });
      compareOperations(bOp, renamed, out, true);
      continue;
    }
    entry(out, 'operation-removed', `${bOp.method} ${bOp.pathKey}`, `operation:${bOp.method} ${bOp.path}`, {
      method: bOp.method,
      path: bOp.path,
    });
  }
  for (const aOp of after.operations) {
    if (!paired.has(aOp)) {
      entry(out, 'operation-added', `${aOp.method} ${aOp.pathKey}`, `operation:${aOp.method} ${aOp.path}`, {
        method: aOp.method,
        path: aOp.path,
      });
    }
  }
  return out.sort((a, b) => a.identity.localeCompare(b.identity));
}
