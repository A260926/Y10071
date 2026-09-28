import { ChangeCategory, RawDiff } from './types.js';

const LABELS: Record<ChangeCategory, string> = {
  'property-added': '新增属性',
  'property-removed': '删除属性',
  'required-added': '变为必填',
  'required-removed': '取消必填',
  'enum-narrowed': '枚举收窄',
  'enum-widened': '枚举放宽',
  'enum-replaced': '枚举取值替换',
  'nullable-added': '允许为 null',
  'nullable-removed': '不再允许为 null',
  'type-changed': '类型变更',
  'parameter-renamed': '路径/参数改名',
  'parameter-required-changed': '参数必填性变更',
  'parameter-added': '新增参数',
  'parameter-removed': '删除参数',
  'response-status-removed': '响应状态码消失',
  'response-status-added': '新增响应状态码',
  'endpoint-added': '新增接口',
  'endpoint-removed': '接口被删除',
  'description-changed': '描述变化',
  'ref-target-changed': '引用目标变更'
};

function readableScope(scope: string): string {
  return scope
    .split('/')
    .filter(Boolean)
    .map((seg) => seg.replace(/~1/g, '/').replace(/~0/g, '~'))
    .join(' › ');
}

function fmt(v: unknown): string {
  if (v === null || v === undefined) return '∅';
  if (typeof v === 'string') return v;
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(fmt).join(', ');
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** 只依据结构化差异字段生成调用方影响说明；用户理由绝不参与、也绝不作为代码执行。 */
export function buildImpact(diff: Pick<RawDiff, 'category' | 'scope' | 'subject' | 'beforeValue' | 'afterValue'>): string {
  const where = readableScope(diff.scope);
  const subject = diff.subject && diff.subject !== 'enum' && diff.subject !== 'description' ? `「${diff.subject}」` : '';
  const label = LABELS[diff.category];
  switch (diff.category) {
    case 'enum-narrowed':
      return `【${label}】${where} 的允许取值收窄：${fmt(diff.beforeValue)} → ${fmt(diff.afterValue)}，调用方若发送被移除的取值将被拒绝。`;
    case 'enum-widened':
      return `【${label}】${where} 的允许取值放宽：${fmt(diff.beforeValue)} → ${fmt(diff.afterValue)}，调用方需准备识别新增取值。`;
    case 'enum-replaced':
      return `【${label}】${where} 的枚举集合发生替换：${fmt(diff.beforeValue)} → ${fmt(diff.afterValue)}。`;
    case 'parameter-renamed':
      return `【${label}】${where} 参数由 "${fmt(diff.beforeValue)}" 改名为 "${fmt(diff.afterValue)}"，旧调用路径将无法匹配。`;
    case 'required-added':
      return `【${label}】${where} 中的 ${subject || '字段'} 变为必填，未提供该值的旧请求会失败。`;
    case 'required-removed':
      return `【${label}】${where} 中的 ${subject || '字段'} 不再必填。`;
    case 'parameter-required-changed':
      return `【${label}】${where} 必填性 ${fmt(diff.beforeValue)} → ${fmt(diff.afterValue)}。`;
    case 'response-status-removed':
      return `【${label}】${where}：状态码 ${fmt(diff.beforeValue && typeof diff.beforeValue === 'object' ? diff.subject : diff.subject)} 不再返回，依赖该分支处理逻辑的调用方需要调整。`;
    case 'nullable-added':
      return `【${label}】${where} 的 ${subject || '值'} 现在可能为 null，调用方必须处理空值。`;
    case 'nullable-removed':
      return `【${label}】${where} 的 ${subject || '值'} 不再为 null。`;
    case 'property-removed':
      return `【${label}】${where}：属性 ${subject} 被移除，读取该字段的调用方将取不到值。`;
    case 'property-added':
      return `【${label}】${where}：新增属性 ${subject}，老调用方一般不受影响。`;
    case 'type-changed':
      return `【${label}】${where} ${subject}：${fmt(diff.beforeValue)} → ${fmt(diff.afterValue)}。`;
    case 'parameter-added':
      return `【${label}】${where}：新增参数 ${fmt(diff.afterValue && (diff.afterValue as { name?: string }).name)}。`;
    case 'parameter-removed':
      return `【${label}】${where}：参数 ${fmt((diff.beforeValue as { name?: string })?.name)} 被删除。`;
    case 'endpoint-removed':
      return `【${label}】${fmt(diff.beforeValue)} 不再可用，调用该接口的调用方必须迁移。`;
    case 'endpoint-added':
      return `【${label}】新增接口 ${fmt(diff.afterValue)}。`;
    case 'description-changed':
      return `【${label}】${where} 的描述发生变化，不影响数据契约。`;
    case 'ref-target-changed':
      return `【${label}】${where} 引用目标 ${fmt(diff.beforeValue)} → ${fmt(diff.afterValue)}。`;
    default:
      return `【${label}】${where} ${subject}（${fmt(diff.beforeValue)} → ${fmt(diff.afterValue)}）`;
  }
}
