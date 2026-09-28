import { ChangeCategory, RawDiff } from './types.js';
import { NormDoc, NormParameter, NormSchema } from './normalize.js';

export type Segments = string[];

function escapeSeg(seg: string): string {
  return seg.replace(/~/g, '~0').replace(/\//g, '~1');
}

function jp(segs: Segments): string {
  if (segs.length === 0) return '';
  return segs.map(escapeSeg).join('/');
}

function makePush(out: RawDiff[]) {
  return (segs: Segments, category: ChangeCategory, subject: string, before: unknown, after: unknown): void => {
    const key = `v1/${category}/${jp(segs)}${subject ? '/' + escapeSeg(subject) : ''}`;
    out.push({
      key,
      category,
      scope: '/' + jp(segs),
      subject,
      beforeValue: before,
      afterValue: after,
      beforeJson: compact(before),
      afterJson: compact(after)
    });
  };
}

function compact(v: unknown): unknown {
  if (v === undefined) return null;
  return v;
}

function typesOf(s: NormSchema): string[] {
  return [...s.type].sort();
}

function normalizeEnum(s: NormSchema): unknown[] | null {
  if (!Array.isArray(s.enum)) return null;
  return s.enum;
}

function stableKey(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'object') return JSON.stringify(value);
  return JSON.stringify(value);
}

/**
 * 递归比较两个规范化 schema。属性顺序不参与比较（normalize 后属性集合化）。
 * 返回该 schema 子树下产生的差异；描述差异仅在该子树无其他差异时保留。
 */
function diffSchema(before: NormSchema, after: NormSchema, segs: Segments, out: RawDiff[]): void {
  const local: RawDiff[] = [];
  const push = makePush(local);

  if (before.cycleRef || after.cycleRef || before.externalRef || after.externalRef) {
    const b = before.cycleRef ?? before.externalRef ?? null;
    const a = after.cycleRef ?? after.externalRef ?? null;
    if (b !== a) push(segs, 'ref-target-changed', '', b, a);
    out.push(...local);
    return;
  }

  const bt = typesOf(before);
  const at = typesOf(after);
  if (bt.join(',') !== at.join(',')) {
    push(segs, 'type-changed', '', bt, at);
  }

  if (before.nullable !== after.nullable) {
    push(segs, after.nullable ? 'nullable-added' : 'nullable-removed', '', before.nullable, after.nullable);
  }

  const be = normalizeEnum(before);
  const ae = normalizeEnum(after);
  if (be !== null || ae !== null) {
    if (be === null && ae !== null) {
      push(segs, 'enum-narrowed', 'enum', null, ae);
    } else if (ae === null && be !== null) {
      push(segs, 'enum-widened', 'enum', be, null);
    } else if (be !== null && ae !== null) {
      const bSet = new Set(be.map(stableKey));
      const aSet = new Set(ae.map(stableKey));
      const removed = be.filter((v) => !aSet.has(stableKey(v)));
      const added = ae.filter((v) => !bSet.has(stableKey(v)));
      if (removed.length && !added.length) {
        push(segs, 'enum-narrowed', 'enum', be, ae);
      } else if (added.length && !removed.length) {
        push(segs, 'enum-widened', 'enum', be, ae);
      } else if (removed.length || added.length) {
        push(segs, 'enum-replaced', 'enum', be, ae);
      }
    }
  }

  if ((before.description ?? null) !== (after.description ?? null)) {
    push(segs, 'description-changed', 'description', before.description ?? '', after.description ?? '');
  }

  const bProps = before.properties ?? {};
  const aProps = after.properties ?? {};
  const propNames = Array.from(new Set([...Object.keys(bProps), ...Object.keys(aProps)])).sort();
  let childHasChange = false;
  for (const name of propNames) {
    const childSegs = [...segs, 'properties', name];
    if (!(name in bProps) && name in aProps) {
      push(segs, 'property-added', name, null, describeSchema(aProps[name]));
      childHasChange = true;
    } else if (name in bProps && !(name in aProps)) {
      push(segs, 'property-removed', name, describeSchema(bProps[name]), null);
      childHasChange = true;
    } else {
      const beforeLen = local.length;
      diffSchema(bProps[name], aProps[name], childSegs, local);
      if (local.length > beforeLen) childHasChange = true;
    }
  }

  const bReq = new Set(before.required ?? []);
  const aReq = new Set(after.required ?? []);
  for (const name of Array.from(bReq).filter((n) => !aReq.has(n)).sort()) {
    push(segs, 'required-removed', name, true, false);
    childHasChange = true;
  }
  for (const name of Array.from(aReq).filter((n) => !bReq.has(n)).sort()) {
    push(segs, 'required-added', name, false, true);
    childHasChange = true;
  }

  const bItems = before.items ?? null;
  const aItems = after.items ?? null;
  if (bItems && aItems) {
    const beforeLen = local.length;
    diffSchema(bItems, aItems, [...segs, 'items'], local);
    if (local.length > beforeLen) childHasChange = true;
  } else if (bItems && !aItems) {
    push([...segs], 'type-changed', 'items', describeSchema(bItems), null);
    childHasChange = true;
  } else if (!bItems && aItems) {
    push([...segs], 'type-changed', 'items', null, describeSchema(aItems));
    childHasChange = true;
  }

  if (local.length > 0) {
    if (!childHasChange && local.length === 1 && local[0].category === 'description-changed') {
      out.push(local[0]);
    } else {
      out.push(...local.filter((d) => d.category !== 'description-changed'));
    }
  }
}

/** schema 的只读快照值：规范化后的纯数据。 */
export function describeSchema(s: NormSchema): unknown {
  return {
    type: s.type,
    nullable: s.nullable,
    enum: s.enum ?? null,
    required: s.required ?? null,
    properties: s.properties
      ? Object.fromEntries(Object.entries(s.properties).map(([k, v]) => [k, { type: v.type, nullable: v.nullable }]))
      : null,
    items: s.items ? { type: s.items.type, nullable: s.items.nullable } : null,
    cycleRef: s.cycleRef ?? null,
    externalRef: s.externalRef ?? null,
    description: s.description ?? null
  };
}

function paramType(p: NormParameter): string {
  return [...p.schema.type].sort().join(',');
}

/** 参数身份：按位置（in + 序号）稳定标识，改名时身份不变；无改名则直接用名称。 */
function diffParameterLists(before: NormParameter[], after: NormParameter[], segs: Segments, out: RawDiff[]): void {
  const bByName = new Map(before.map((p) => [`${p.in}:${p.name}`, p]));
  const aByName = new Map(after.map((p) => [`${p.in}:${p.name}`, p]));

  const bUnmatched = before.filter((p) => !aByName.has(`${p.in}:${p.name}`));
  const aUnmatched = after.filter((p) => !bByName.has(`${p.in}:${p.name}`));
  const renamePairs = new Map<NormParameter, NormParameter>();
  const push = makePush(out);
  const renamedAfter = new Set<NormParameter>();
  for (const bp of bUnmatched) {
    const sameTypeBefore = bUnmatched.filter((q) => q.in === bp.in && paramType(q) === paramType(bp));
    const candidates = aUnmatched.filter((q) => q.in === bp.in && paramType(q) === paramType(bp));
    if (sameTypeBefore.length === 1 && candidates.length === 1) {
      renamePairs.set(bp, candidates[0]);
      renamedAfter.add(candidates[0]);
    }
  }

  const indexByIn = new Map<string, number>();
  const posSegs = (p: NormParameter): Segments => {
    const idx = indexByIn.get(p.in) ?? 0;
    indexByIn.set(p.in, idx + 1);
    return [...segs, 'parameters', p.in, `#${idx}`];
  };
  const matchedAfter = new Set<NormParameter>();

  for (const bp of before) {
    const renamed = renamePairs.get(bp);
    const ap = renamed ?? aByName.get(`${bp.in}:${bp.name}`);
    if (!ap) {
      push([...segs, 'parameters', bp.in, bp.name], 'parameter-removed', bp.name, describeParameter(bp), null);
      continue;
    }
    matchedAfter.add(ap);
    const paramSegs = renamed ? posSegs(bp) : [...segs, 'parameters', bp.in, bp.name];
    if (renamed) push(paramSegs, 'parameter-renamed', 'name', bp.name, ap.name);
    if (bp.required !== ap.required) {
      push(paramSegs, 'parameter-required-changed', 'required', bp.required, ap.required);
    }
    diffSchema(bp.schema, ap.schema, [...paramSegs, 'schema'], out);
    if ((bp.description ?? null) !== (ap.description ?? null)) {
      push(paramSegs, 'description-changed', 'description', bp.description ?? '', ap.description ?? '');
    }
  }

  for (const ap of after) {
    if (matchedAfter.has(ap)) continue;
    push([...segs, 'parameters', ap.in, ap.name], 'parameter-added', ap.name, null, describeParameter(ap));
  }
}

function describeParameter(p: NormParameter): unknown {
  return { name: p.name, in: p.in, required: p.required, schema: describeSchema(p.schema), description: p.description ?? null };
}

function canonicalPath(path: string): string {
  return path.replace(/\{[^}/]+\}/g, '{}');
}

export function diffOperations(before: NormDoc, after: NormDoc): RawDiff[] {
  const out: RawDiff[] = [];
  const push = makePush(out);
  const bMap = new Map(before.operations.map((o) => [`${canonicalPath(o.path)} ${o.method}`, o]));
  const aMap = new Map(after.operations.map((o) => [`${canonicalPath(o.path)} ${o.method}`, o]));
  const keys = Array.from(new Set([...bMap.keys(), ...aMap.keys()])).sort();

  for (const key of keys) {
    const b = bMap.get(key);
    const a = aMap.get(key);
    if (b && !a) {
      const segs = ['paths', b.path, b.method];
      push(segs, 'endpoint-removed', '', `${b.method.toUpperCase()} ${b.path}`, null);
      continue;
    }
    if (!b && a) {
      const segs = ['paths', a.path, a.method];
      push(segs, 'endpoint-added', '', null, `${a.method.toUpperCase()} ${a.path}`);
      continue;
    }
    if (!b || !a) continue;
    const segs = ['paths', b.path, b.method];

    diffParameterLists(b.op.parameters, a.op.parameters, segs, out);

    const bb = b.op.requestBody;
    const ab = a.op.requestBody;
    if (bb && ab) {
      if (bb.required !== ab.required) {
        push([...segs, 'requestBody'], bb.required ? 'required-removed' : 'required-added', 'requestBody', bb.required, ab.required);
      }
      diffSchema(bb.schema, ab.schema, [...segs, 'requestBody', 'content', 'application/json', 'schema'], out);
    } else if (bb && !ab) {
      push([...segs, 'requestBody'], 'property-removed', 'requestBody', { required: bb.required }, null);
    } else if (!bb && ab) {
      push([...segs, 'requestBody'], 'property-added', 'requestBody', null, { required: ab.required });
    }

    const bStatus = Object.keys(b.op.responses).sort();
    const aStatus = Object.keys(a.op.responses).sort();
    for (const status of bStatus) {
      if (!aStatus.includes(status)) {
        push([...segs, 'responses', status], 'response-status-removed', status, describeResponse(b.op.responses[status]), null);
      }
    }
    for (const status of aStatus) {
      if (!bStatus.includes(status)) {
        push([...segs, 'responses', status], 'response-status-added', status, null, describeResponse(a.op.responses[status]));
      }
    }
    for (const status of bStatus) {
      if (!aStatus.includes(status)) continue;
      const br = b.op.responses[status].schema;
      const ar = a.op.responses[status].schema;
      if (br && ar) {
        diffSchema(br, ar, [...segs, 'responses', status, 'content', 'application/json', 'schema'], out);
      } else if (br !== ar) {
        push([...segs, 'responses', status], 'type-changed', 'body', br ? 'json' : null, ar ? 'json' : null);
      }
    }
  }

  return out.sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
}

function describeResponse(r: { description?: string; schema: NormSchema | null }): unknown {
  return { description: r.description ?? null, schema: r.schema ? describeSchema(r.schema) : null };
}
