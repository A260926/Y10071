import type { DiffEntry } from './diff.js';

function fmt(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

export function buildImpact(diff: DiffEntry): string {
  const { category, location, subject, detail } = diff;
  switch (category) {
    case 'path-param-renamed':
      return `${location}：路径模板由 ${fmt(detail.before)} 变为 ${fmt(detail.after)}，路径参数被改名，调用方需同步更新 URL 模板与参数名。`;
    case 'required-changed':
      if (detail.change === 'added') {
        return `${location}（${subject}）：字段 ${fmt(detail.property ?? detail.name)} 变为必填，调用方必须补传该字段，否则请求会被拒绝。`;
      }
      return `${location}（${subject}）：字段 ${fmt(detail.property ?? detail.name)} 不再必填，调用方可选择省略该字段。`;
    case 'enum-narrowed':
      return `${location}（${subject}）：枚举取值由 ${fmt(detail.before)} 收窄为 ${fmt(detail.after)}，被移除的取值 ${fmt(detail.removed)} 不再可用，调用方需检查存量数据与请求。`;
    case 'enum-widened':
      return `${location}（${subject}）：枚举取值由 ${fmt(detail.before)} 放宽为 ${fmt(detail.after)}，调用方需准备处理新增取值 ${fmt(detail.added)}。`;
    case 'response-removed':
      return `${location}：响应状态码 ${fmt(detail.status)} 已被移除，调用方对该状态的分支处理将失效，需调整错误处理逻辑。`;
    case 'response-added':
      return `${location}：新增响应状态码 ${fmt(detail.status)}，调用方应确认是否需要处理该分支。`;
    case 'nullable-changed':
      return detail.after === true
        ? `${location}（${subject}）：该字段现在允许为 null，调用方需增加空值处理。`
        : `${location}（${subject}）：该字段不再允许为 null，调用方不得再发送或依赖空值。`;
    case 'type-changed':
      return `${location}（${subject}）：类型由 ${fmt(detail.before)} 变为 ${fmt(detail.after)}，调用方的序列化与解析逻辑需要同步修改。`;
    case 'property-removed':
      return `${location}（${subject}）：属性 ${fmt(detail.property)} 已被移除，调用方不得再读取该字段。`;
    case 'property-added':
      return `${location}（${subject}）：新增属性 ${fmt(detail.property)}，调用方可按需接入。`;
    case 'operation-removed':
      return `${location}：接口 ${fmt(detail.method)} ${fmt(detail.path)} 已被整体移除，调用方必须迁移。`;
    case 'operation-added':
      return `${location}：新增接口 ${fmt(detail.method)} ${fmt(detail.path)}。`;
    case 'parameter-removed':
      return `${location}：参数 ${fmt(detail.name)}（${fmt(detail.in)}）已被移除，调用方不得再传递。`;
    case 'parameter-added':
      return `${location}：新增参数 ${fmt(detail.name)}（${fmt(detail.in)}）${detail.required ? '，且为必填，调用方必须补传' : ''}。`;
    default:
      return `${location}（${subject}）：发生 ${category} 变化。`;
  }
}
