import { DocSummary, ParseError, ParsedDoc } from './types.js';

export type Jsonish = unknown;

export interface NormSchema {
  type: string[];
  nullable: boolean;
  enum?: Jsonish[];
  properties?: Record<string, NormSchema>;
  required?: string[];
  items?: NormSchema;
  description?: string;
  /** 循环引用落点：以引用目标指针作为原子值 */
  cycleRef?: string;
  /** 无法解析的外部引用 */
  externalRef?: string;
  $ref?: string;
}

export interface NormParameter {
  name: string;
  in: string;
  description?: string;
  required: boolean;
  schema: NormSchema;
}

export interface NormBody {
  required: boolean;
  schema: NormSchema;
}

export interface NormResponse {
  description?: string;
  schema: NormSchema | null;
}

export interface NormOperation {
  path: string;
  method: string;
  parameters: NormParameter[];
  requestBody: NormBody | null;
  responses: Record<string, NormResponse>;
}

export interface NormDoc {
  summary: DocSummary;
  operations: Array<{ path: string; method: string; op: NormOperation }>;
}

const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace']);

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function derefPointer(root: unknown, pointer: string): unknown {
  if (!pointer.startsWith('#/')) return undefined;
  let cur: unknown = root;
  for (const raw of pointer.slice(2).split('/')) {
    const part = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (Array.isArray(cur)) {
      cur = cur[Number(part)];
    } else if (isObj(cur)) {
      cur = cur[part];
    } else {
      return undefined;
    }
  }
  return cur;
}

function asStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v.filter((x): x is string => typeof x === 'string');
}

function mergeSchemaList(root: unknown, list: unknown[], active: Set<string>, cache: Map<string, NormSchema>): NormSchema {
  const merged: NormSchema = { type: [], nullable: false };
  for (const part of list) {
    const sub = normalizeSchema(part, root, active, cache);
    if (sub.cycleRef || sub.externalRef) return sub;
    if (sub.type.length) {
      for (const t of sub.type) if (!merged.type.includes(t)) merged.type.push(t);
    }
    merged.nullable = merged.nullable || sub.nullable;
    if (sub.enum !== undefined) merged.enum = sub.enum;
    if (sub.description !== undefined) merged.description = sub.description;
    if (sub.items) merged.items = sub.items;
    if (sub.properties) {
      merged.properties = { ...(merged.properties ?? {}), ...sub.properties };
    }
    if (sub.required) {
      merged.required = Array.from(new Set([...(merged.required ?? []), ...sub.required]));
    }
  }
  return merged;
}

function normalizeSchema(node: unknown, root: unknown, active: Set<string>, cache: Map<string, NormSchema>): NormSchema {
  if (node === null || node === undefined) return { type: [], nullable: false };

  if (isObj(node) && typeof node.$ref === 'string') {
    const ref = node.$ref;
    if (!ref.startsWith('#/')) return { type: [], nullable: false, externalRef: ref, $ref: ref };
    if (active.has(ref)) return { type: [], nullable: false, cycleRef: ref, $ref: ref };
    const cached = cache.get(ref);
    if (cached) return cached;
    const target = derefPointer(root, ref);
    if (target === undefined) {
      const err = new Error(`无法解析的引用: ${ref}`);
      (err as Error & { badRef?: string }).badRef = ref;
      throw err;
    }
    active.add(ref);
    const resolved = normalizeSchema(target, root, active, cache);
    active.delete(ref);
    cache.set(ref, resolved);
    const result: NormSchema = { ...resolved, $ref: ref };
    return result;
  }

  if (Array.isArray(node)) return { type: ['array'], nullable: false };

  if (!isObj(node)) {
    return { type: [typeof node as string], nullable: false, enum: [node] };
  }

  if (Array.isArray(node.allOf)) {
    const rest = Object.fromEntries(Object.entries(node).filter(([k]) => k !== 'allOf'));
    return mergeSchemaList(root, [...node.allOf, rest], active, cache);
  }

  const out: NormSchema = { type: [], nullable: Boolean(node.nullable) };

  if (typeof node.type === 'string') {
    out.type = [node.type];
  } else if (Array.isArray(node.type)) {
    const types = node.type.filter((t): t is string => typeof t === 'string');
    out.type = types.filter((t) => t !== 'null');
    out.nullable = out.nullable || types.includes('null');
  }

  if (Array.isArray(node.enum)) out.enum = node.enum as Jsonish[];
  if (typeof node.description === 'string') out.description = node.description;
  if (node.items !== undefined) out.items = normalizeSchema(node.items, root, active, cache);
  if (isObj(node.properties)) {
    out.properties = {};
    for (const [name, sub] of Object.entries(node.properties)) {
      out.properties[name] = normalizeSchema(sub, root, active, cache);
    }
  }
  const required = asStringArray(node.required);
  if (required && required.length) out.required = [...required].sort();

  return out;
}

function resolveRefObject<T>(node: unknown, root: unknown, active: Set<string>): T {
  let cur = node;
  const guard = new Set<string>();
  while (isObj(cur) && typeof cur.$ref === 'string') {
    const ref = cur.$ref;
    if (!ref.startsWith('#/')) throw new Error(`不支持外部引用: ${ref}`);
    if (guard.has(ref) || active.has(ref)) throw new Error(`参数/响应处存在循环引用: ${ref}`);
    guard.add(ref);
    const target = derefPointer(root, ref);
    if (target === undefined) throw new Error(`无法解析的引用: ${ref}`);
    cur = target;
  }
  return cur as T;
}

function normalizeParameter(raw0: unknown, root: unknown): NormParameter {
  const raw = resolveRefObject<Record<string, unknown>>(raw0, root, new Set());
  if (!isObj(raw) || typeof raw.name !== 'string' || typeof raw.in !== 'string') {
    throw new Error('参数缺少 name 或 in');
  }
  return {
    name: raw.name,
    in: raw.in,
    description: typeof raw.description === 'string' ? raw.description : undefined,
    required: Boolean(raw.required),
    schema: normalizeSchema(raw.schema ?? {}, root, new Set(), new Map())
  };
}

function jsonSchemaOf(content: unknown, root: unknown): NormSchema | null {
  if (!isObj(content)) return null;
  const media = content['application/json'];
  if (!isObj(media) || media.schema === undefined) return null;
  return normalizeSchema(media.schema, root, new Set(), new Map());
}

export function normalizeDoc(parsed: ParsedDoc): NormDoc {
  const doc = parsed.doc;
  if (!isObj(doc)) throw validationError('文档顶层必须是对象', '/');
  if (typeof doc.openapi !== 'string' || !doc.openapi.startsWith('3.')) {
    throw validationError('仅支持 OpenAPI 3.x（缺少 openapi 版本字段）', '/openapi');
  }
  const info = doc.info;
  if (!isObj(info) || typeof info.title !== 'string' || !info.title.trim()) {
    throw validationError('info.title 缺失或为空', '/info/title');
  }
  if (typeof info.version !== 'string') {
    throw validationError('info.version 缺失', '/info/version');
  }
  const paths = doc.paths;
  if (!isObj(paths)) throw validationError('paths 缺失或不是对象', '/paths');

  const rootCache = new Map<string, NormSchema>();
  const operations: NormDoc['operations'] = [];

  for (const [pathKey, pathItemRaw] of Object.entries(paths)) {
    if (!pathKey.startsWith('/')) throw validationError(`非法路径 ${pathKey}`, `/paths/${pathKey}`);
    const pathItem = isObj(pathItemRaw) && typeof pathItemRaw.$ref === 'string'
      ? resolveRefObject<Record<string, unknown>>(pathItemRaw, doc, new Set())
      : pathItemRaw;
    if (!isObj(pathItem)) throw validationError(`路径项 ${pathKey} 不是对象`, `/paths/${pathKey}`);

    const pathParams = Array.isArray(pathItem.parameters) ? pathItem.parameters : [];
    for (const [method, opRaw] of Object.entries(pathItem)) {
      if (!HTTP_METHODS.has(method)) continue;
      if (!isObj(opRaw)) throw validationError(`操作 ${method.toUpperCase()} ${pathKey} 不是对象`, `/paths/${pathKey}/${method}`);

      const paramList = [...pathParams, ...(Array.isArray(opRaw.parameters) ? opRaw.parameters : [])];
      const byKey = new Map<string, unknown>();
      for (const p0 of paramList) {
        let p = p0;
        try {
          p = resolveRefObject<Record<string, unknown>>(p0, doc, new Set());
        } catch {
          p = p0;
        }
        if (isObj(p) && typeof p.name === 'string' && typeof p.in === 'string') {
          byKey.set(`${p.in}:${p.name}`, p0);
        }
      }
      const parameters = [...byKey.values()].map((p) => normalizeParameter(p, doc));

      let requestBody: NormBody | null = null;
      if (opRaw.requestBody !== undefined) {
        const body = resolveRefObject<Record<string, unknown>>(opRaw.requestBody, doc, new Set());
        if (!isObj(body)) throw validationError('requestBody 不是对象', `/paths/${pathKey}/${method}/requestBody`);
        requestBody = { required: Boolean(body.required), schema: jsonSchemaOf(body.content, doc) ?? { type: [], nullable: false } };
      }

      const responses: Record<string, NormResponse> = {};
      if (!isObj(opRaw.responses)) throw validationError('responses 缺失', `/paths/${pathKey}/${method}/responses`);
      for (const [status, respRaw] of Object.entries(opRaw.responses)) {
        const resp = resolveRefObject<Record<string, unknown>>(respRaw, doc, new Set());
        if (!isObj(resp)) throw validationError(`响应 ${status} 不是对象`, `/paths/${pathKey}/${method}/responses/${status}`);
        responses[status] = {
          description: typeof resp.description === 'string' ? resp.description : undefined,
          schema: jsonSchemaOf(resp.content, doc)
        };
      }
      if (Object.keys(responses).length === 0) {
        throw validationError('responses 至少需要一个状态码', `/paths/${pathKey}/${method}/responses`);
      }

      operations.push({ path: pathKey, method, op: { path: pathKey, method, parameters, requestBody, responses } });
    }
  }

  const summary: DocSummary = {
    openapi: doc.openapi,
    title: info.title,
    version: info.version,
    pathCount: Object.keys(paths).length,
    contentHash: parsed.contentHash,
    format: parsed.format
  };

  // 预热：让整个 components 树（含共享/循环定义）完成规范化，引用错误在此暴露
  const components = doc.components;
  if (isObj(components) && isObj(components.schemas)) {
    for (const [name] of Object.entries(components.schemas)) {
      try {
        normalizeSchema({ $ref: `#/components/schemas/${name}` }, doc, new Set(), rootCache);
      } catch (err) {
        const bad = (err as Error & { badRef?: string }).badRef;
        throw validationError((err as Error).message, bad ? `#${bad.slice(1)}` : `/components/schemas/${name}`);
      }
    }
  }

  return { summary, operations: operations.sort((a, b) => (a.path + a.method < b.path + b.method ? -1 : 1)) };
}

export function validationError(message: string, path: string): ParseError {
  return { message, path, line: 0, column: 0 };
}
