import { createHash } from 'node:crypto';

export interface NormSchema {
  type?: string;
  nullable?: boolean;
  format?: string;
  enum?: unknown[];
  required?: string[];
  properties?: Record<string, NormSchema>;
  items?: NormSchema;
  circularRef?: string;
}

export interface NormParam {
  name: string;
  in: string;
  required: boolean;
  schema: NormSchema;
}

export interface NormOperation {
  method: string;
  path: string;
  pathKey: string;
  parameters: NormParam[];
  requestBodies: Record<string, NormSchema>;
  responses: Record<string, Record<string, NormSchema>>;
}

export interface NormalizedSpec {
  operations: NormOperation[];
}

export interface DocSummary {
  title: string;
  version: string;
  sha256: string;
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function erasePathParams(path: string): string {
  return path.replace(/\{[^}]+\}/g, '{}');
}

type Components = {
  schemas?: Record<string, unknown>;
  parameters?: Record<string, unknown>;
};

function resolveRef(ref: string, components: Components): unknown {
  const match = /^#\/components\/(schemas|parameters)\/([^/]+)$/.exec(ref);
  if (!match) return undefined;
  const bucket = match[1] === 'schemas' ? components.schemas : components.parameters;
  return bucket?.[decodeURIComponent(match[2])];
}

function mergeSchema(a: NormSchema, b: NormSchema): NormSchema {
  const out: NormSchema = { ...a, ...b };
  if (a.type !== undefined && b.type === undefined) out.type = a.type;
  if (a.format !== undefined && b.format === undefined) out.format = a.format;
  out.nullable = Boolean(a.nullable || b.nullable) || undefined;
  if (a.required || b.required) {
    out.required = [...new Set([...(a.required ?? []), ...(b.required ?? [])])].sort();
  }
  if (a.enum && b.enum) {
    const bSet = new Set(b.enum.map(stableStringify));
    out.enum = a.enum.filter((v) => bSet.has(stableStringify(v)));
  }
  if (a.properties || b.properties) {
    const props: Record<string, NormSchema> = { ...(a.properties ?? {}) };
    for (const [key, value] of Object.entries(b.properties ?? {})) {
      props[key] = props[key] ? mergeSchema(props[key], value) : value;
    }
    out.properties = Object.fromEntries(
      Object.entries(props).sort(([x], [y]) => x.localeCompare(y)),
    );
  }
  if (a.items && b.items) out.items = mergeSchema(a.items, b.items);
  else out.items = a.items ?? b.items;
  if (out.nullable === undefined) delete out.nullable;
  return out;
}

function normalizeOwn(
  node: Record<string, unknown>,
  components: Components,
  stack: string[],
): NormSchema {
  const out: NormSchema = {};
  let type = node.type;
  let nullable = node.nullable === true;
  if (Array.isArray(type)) {
    const types = type.filter((t): t is string => typeof t === 'string');
    if (types.includes('null')) nullable = true;
    const nonNull = types.filter((t) => t !== 'null').sort();
    type = nonNull.length === 1 ? nonNull[0] : nonNull.length > 1 ? nonNull.join('|') : undefined;
  }
  if (typeof type === 'string') out.type = type;
  if (nullable) out.nullable = true;
  if (typeof node.format === 'string') out.format = node.format;
  if (Array.isArray(node.enum)) {
    out.enum = [...node.enum].sort((x, y) => stableStringify(x).localeCompare(stableStringify(y)));
  }
  if (Array.isArray(node.required)) {
    const req = [...new Set(node.required.filter((x): x is string => typeof x === 'string'))].sort();
    if (req.length > 0) out.required = req;
  }
  if (node.properties && typeof node.properties === 'object') {
    const props: Record<string, NormSchema> = {};
    for (const key of Object.keys(node.properties as Record<string, unknown>).sort()) {
      props[key] = normalizeSchema(
        (node.properties as Record<string, unknown>)[key],
        components,
        stack,
      );
    }
    out.properties = props;
  }
  if (node.items !== undefined) {
    out.items = normalizeSchema(node.items, components, stack);
  }
  return out;
}

export function normalizeSchema(
  raw: unknown,
  components: Components = {},
  stack: string[] = [],
): NormSchema {
  if (!raw || typeof raw !== 'object') return {};
  const node = raw as Record<string, unknown>;
  if (typeof node.$ref === 'string') {
    const ref = node.$ref;
    if (stack.includes(ref)) return { circularRef: ref };
    const target = resolveRef(ref, components);
    if (target === undefined) return { circularRef: ref };
    return normalizeSchema(target, components, [...stack, ref]);
  }
  let out: NormSchema = {};
  if (Array.isArray(node.allOf)) {
    for (const sub of node.allOf) {
      out = mergeSchema(out, normalizeSchema(sub, components, stack));
    }
  }
  return mergeSchema(out, normalizeOwn(node, components, stack));
}

function normalizeParam(raw: unknown, components: Components): NormParam | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  let node = raw as Record<string, unknown>;
  if (typeof node.$ref === 'string') {
    const target = resolveRef(node.$ref, components);
    if (!target || typeof target !== 'object') return undefined;
    node = target as Record<string, unknown>;
  }
  if (typeof node.name !== 'string' || typeof node.in !== 'string') return undefined;
  return {
    name: node.name,
    in: node.in,
    required: node.required === true,
    schema: normalizeSchema(node.schema, components),
  };
}

const METHODS = ['get', 'put', 'post', 'delete', 'patch', 'head', 'options', 'trace'] as const;

export function normalizeSpec(doc: unknown): NormalizedSpec {
  const root = (doc ?? {}) as Record<string, unknown>;
  const components = (root.components ?? {}) as Components;
  const operations: NormOperation[] = [];
  const paths = (root.paths ?? {}) as Record<string, Record<string, unknown>>;
  for (const path of Object.keys(paths).sort()) {
    const item = paths[path] ?? {};
    const shared = Array.isArray(item.parameters) ? item.parameters : [];
    for (const method of METHODS) {
      const op = item[method] as Record<string, unknown> | undefined;
      if (!op || typeof op !== 'object') continue;
      const rawParams = [...shared, ...(Array.isArray(op.parameters) ? op.parameters : [])];
      const paramMap = new Map<string, NormParam>();
      for (const raw of rawParams) {
        const param = normalizeParam(raw, components);
        if (param) paramMap.set(`${param.in}:${param.name}`, param);
      }
      const parameters = [...paramMap.values()].sort((a, b) =>
        `${a.in}:${a.name}`.localeCompare(`${b.in}:${b.name}`),
      );
      const requestBodies: Record<string, NormSchema> = {};
      const reqContent =
        ((op.requestBody as Record<string, unknown> | undefined)?.content as
          | Record<string, { schema?: unknown }>
          | undefined) ?? {};
      for (const mediaType of Object.keys(reqContent).sort()) {
        requestBodies[mediaType] = normalizeSchema(reqContent[mediaType]?.schema, components);
      }
      const responses: Record<string, Record<string, NormSchema>> = {};
      const rawResponses = (op.responses ?? {}) as Record<
        string,
        { content?: Record<string, { schema?: unknown }> }
      >;
      for (const status of Object.keys(rawResponses).sort()) {
        const content = rawResponses[status]?.content ?? {};
        const media: Record<string, NormSchema> = {};
        for (const mediaType of Object.keys(content).sort()) {
          media[mediaType] = normalizeSchema(content[mediaType]?.schema, components);
        }
        responses[status] = media;
      }
      operations.push({
        method: method.toUpperCase(),
        path,
        pathKey: erasePathParams(path),
        parameters,
        requestBodies,
        responses,
      });
    }
  }
  return { operations };
}

export function canonicalHash(spec: NormalizedSpec): string {
  return sha256(stableStringify(spec));
}

export function summarizeDoc(doc: unknown, spec: NormalizedSpec): DocSummary {
  const root = (doc ?? {}) as Record<string, unknown>;
  const info = (root.info ?? {}) as Record<string, unknown>;
  return {
    title: typeof info.title === 'string' ? info.title : '',
    version: typeof info.version === 'string' ? info.version : '',
    sha256: canonicalHash(spec),
  };
}
