type DecisionState = 'accepted' | 'rejected' | 'exempted';

interface DocSummary {
  openapi: string;
  title: string;
  version: string;
  pathCount: number;
  contentHash: string;
  format: string;
}

interface Decision {
  id: string;
  diffId: string;
  eventNo: number;
  baseVersion: number;
  state: DecisionState;
  actor: string;
  rationale: string;
  expiresAt: string | null;
  decidedAt: string;
  beforeSummary: DocSummary;
  afterSummary: DocSummary;
  effectiveState: DecisionState;
  expired: boolean;
}

interface DiffItem {
  id: string;
  key: string;
  category: string;
  scope: string;
  subject: string;
  beforeJson: unknown;
  afterJson: unknown;
  impact: string;
  decision: Decision | null;
  version: number;
}

interface Revision {
  id: string;
  caseId: string;
  revisionNo: number;
  createdAt: string;
  readOnly: boolean;
  beforeSummary: DocSummary;
  afterSummary: DocSummary;
  diffs: DiffItem[];
  title?: string;
  revisions?: Array<{ id: string; revisionNo: number; active: boolean; createdAt: string }>;
}

interface ParseError {
  message: string;
  path: string;
  line: number;
  column: number;
}

const CATEGORY_LABELS: Record<string, string> = {
  'property-added': '新增属性',
  'property-removed': '删除属性',
  'required-added': '变为必填',
  'required-removed': '取消必填',
  'enum-narrowed': '枚举收窄',
  'enum-widened': '枚举放宽',
  'enum-replaced': '枚举替换',
  'nullable-added': '允许 null',
  'nullable-removed': '不再允许 null',
  'type-changed': '类型变更',
  'parameter-renamed': '参数改名',
  'parameter-required-changed': '参数必填变化',
  'parameter-added': '新增参数',
  'parameter-removed': '删除参数',
  'response-status-removed': '响应状态消失',
  'response-status-added': '新增响应状态',
  'endpoint-added': '新增接口',
  'endpoint-removed': '接口删除',
  'description-changed': '描述变化',
  'ref-target-changed': '引用目标变更'
};

const state = {
  view: null as Revision | null,
  categoryFilter: 'all',
  events: [] as Array<Record<string, unknown>>,
  busy: false
};

const app = document.querySelector('#app') as HTMLElement;

async function api(path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...init
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error?.message ?? `请求失败 (${res.status})`), { status: res.status, body });
  return body;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function formatError(side: string, err: ParseError): string {
  const loc = err.line > 0 ? `，第 ${err.line} 行第 ${err.column} 列附近` : '';
  return `${side === 'before' ? 'before' : 'after'} 文档导入失败\n路径：${err.path}${loc}\n原因：${err.message}\n\n该文档未入库（半份文档不会写入）。`;
}

function renderHome(): void {
  app.textContent = '';

  const create = el('section', 'panel');
  create.appendChild(el('h2', undefined, '新建审议单'));

  const titleWrap = el('div', 'grow');
  titleWrap.appendChild(el('label', 'field', '审议单标题'));
  const titleInput = el('input');
  titleInput.type = 'text';
  titleInput.placeholder = '例如：用户服务 v2 升级评审';
  titleWrap.appendChild(titleInput);

  const docs = el('div');
  docs.style.display = 'grid';
  docs.style.gridTemplateColumns = '1fr 1fr';
  docs.style.gap = '12px';
  docs.style.marginTop = '12px';

  const beforeWrap = el('div');
  beforeWrap.appendChild(el('label', 'field', 'before（JSON 或 YAML，可直接粘贴）'));
  const beforeArea = el('textarea');
  beforeArea.placeholder = '粘贴旧版 OpenAPI 文档';
  beforeWrap.appendChild(beforeArea);
  const afterWrap = el('div');
  afterWrap.appendChild(el('label', 'field', 'after（JSON 或 YAML，可直接粘贴）'));
  const afterArea = el('textarea');
  afterArea.placeholder = '粘贴新版 OpenAPI 文档';
  afterWrap.appendChild(afterArea);
  docs.append(beforeWrap, afterWrap);

  const errBox = el('div');
  const notice = el('div', 'notice');
  notice.textContent = '也可以直接加载仓库内置的 breaking-change 示例：';
  const demoBtn = el('button', 'secondary', '加载 breaking-change 示例');
  demoBtn.type = 'button';

  const submit = el('button', undefined, '生成规范化差异');
  submit.type = 'button';
  const actions = el('div', 'row');
  actions.style.marginTop = '12px';
  actions.append(submit, notice, demoBtn);

  create.append(titleWrap, docs, errBox, actions);
  app.appendChild(create);

  const listPanel = el('section', 'panel');
  listPanel.appendChild(el('h2', undefined, '已有审议单'));
  const list = el('ul', 'case-list');
  listPanel.appendChild(list);
  app.appendChild(listPanel);

  api('/api/cases').then((body) => {
    list.textContent = '';
    if (!body.cases.length) {
      list.appendChild(el('li', 'muted', '还没有审议单。'));
      return;
    }
    for (const c of body.cases) {
      const li = el('li');
      const left = el('div');
      const name = el('div', undefined, c.title);
      const meta = el('div', 'muted', `${c.id.slice(0, 8)} · 修订 ${c.revisionCount} · 当前 R${c.activeRevisionNo ?? '-'}`);
      left.append(name, meta);
      const openBtn = el('button', 'ghost', '打开');
      openBtn.type = 'button';
      openBtn.onclick = () => openCase(c.id);
      li.append(left, openBtn);
      list.appendChild(li);
    }
  });

  async function doCreate(before: string, after: string): Promise<void> {
    errBox.textContent = '';
    submit.disabled = true;
    try {
      const body = await api('/api/cases', {
        method: 'POST',
        body: JSON.stringify({ title: titleInput.value, before, after })
      });
      await openCase(body.caseId, body.revisionId);
    } catch (err) {
      const e = err as { status?: number; body?: { error?: ParseError; side?: string } };
      if (e.status === 400 && e.body?.error) {
        errBox.appendChild(el('div', 'error', formatError(e.body.side ?? 'after', e.body.error)));
      } else {
        errBox.appendChild(el('div', 'error', (err as Error).message));
      }
    } finally {
      submit.disabled = false;
    }
  }

  submit.onclick = () => void doCreate(beforeArea.value, afterArea.value);

  demoBtn.onclick = async () => {
    errBox.textContent = '';
    demoBtn.disabled = true;
    try {
      const [b, a] = await Promise.all([
        fetch('/fixtures/breaking-change/before.yaml').then((r) => r.text()),
        fetch('/fixtures/breaking-change/after.yaml').then((r) => r.text())
      ]);
      titleInput.value = 'breaking-change 示例评审';
      await doCreate(b, a);
    } catch (err) {
      errBox.appendChild(el('div', 'error', `示例加载失败：${(err as Error).message}`));
    } finally {
      demoBtn.disabled = false;
    }
  };
}

async function openCase(caseId: string, revisionId?: string): Promise<void> {
  const path = revisionId ? `/api/revisions/${revisionId}` : `/api/cases/${caseId}`;
  const body = await api(path);
  state.view = body.revision as Revision;
  const ev = await api(`/api/cases/${caseId}/events`);
  state.events = ev.events;
  renderCase();
}

function renderCase(): void {
  const v = state.view;
  if (!v) return;
  app.textContent = '';

  const head = el('section', 'panel');
  const titleRow = el('div', 'row');
  const h = el('h2', undefined, `审议单 ${v.caseId.slice(0, 8)} · 修订 R${v.revisionNo}${v.readOnly ? '（只读历史修订）' : ''}`);
  h.style.margin = '0';
  const back = el('button', 'ghost', '← 返回列表');
  back.type = 'button';
  back.onclick = renderHome;
  titleRow.append(h, back);
  head.appendChild(titleRow);

  const sum = el('div', 'muted');
  sum.style.marginTop = '8px';
  sum.textContent = `before: ${v.beforeSummary.title} v${v.beforeSummary.version}（${v.beforeSummary.pathCount} 个路径，hash ${v.beforeSummary.contentHash.slice(0, 10)}） → after: ${v.afterSummary.title} v${v.afterSummary.version}（${v.afterSummary.pathCount} 个路径，hash ${v.afterSummary.contentHash.slice(0, 10)}）`;
  head.appendChild(sum);

  if (v.revisions && v.revisions.length > 1) {
    const revRow = el('div', 'row');
    revRow.style.marginTop = '10px';
    for (const r of v.revisions) {
      const b = el('button', r.id === v.id ? '' : 'secondary', `R${r.revisionNo}${r.active ? '（当前）' : '（只读）'}`);
      b.type = 'button';
      b.onclick = () => void openCase(v.caseId, r.id);
      revRow.appendChild(b);
    }
    head.appendChild(revRow);
  }

  if (!v.readOnly) {
    const upload = el('div', 'row');
    upload.style.marginTop = '12px';
    const beforeInput = document.createElement('input');
    beforeInput.type = 'file';
    beforeInput.accept = '.json,.yaml,.yml';
    const afterInput = document.createElement('input');
    afterInput.type = 'file';
    const upErr = el('div');
    const upBtn = el('button', 'secondary', '上传新修订（before / after）');
    upBtn.type = 'button';
    const bLbl = el('label', 'field', 'before 文件');
    const aLbl = el('label', 'field', 'after 文件');
    const bw = el('div'); bw.append(bLbl, beforeInput);
    const aw = el('div'); aw.append(aLbl, afterInput);
    upload.append(bw, aw, upBtn);
    head.append(upload, upErr);
    upBtn.onclick = async () => {
      if (!beforeInput.files?.[0] || !afterInput.files?.[0]) {
        upErr.textContent = '';
        upErr.appendChild(el('div', 'error', '请同时选择 before 与 after 文件。'));
        return;
      }
      try {
        const body = await api(`/api/cases/${v.caseId}/revisions`, {
          method: 'POST',
          body: JSON.stringify({
            before: await beforeInput.files[0].text(),
            after: await afterInput.files[0].text()
          })
        });
        if (body.reused) {
          alert(`内容未变化：复用修订 R${body.revisionNo}，已有决议保持不变。`);
        }
        await openCase(v.caseId, body.revisionId);
      } catch (err) {
        const e = err as { status?: number; body?: { error?: ParseError; side?: string } };
        upErr.textContent = '';
        if (e.status === 400 && e.body?.error) {
          upErr.appendChild(el('div', 'error', formatError(e.body.side ?? 'after', e.body.error)));
        } else {
          upErr.appendChild(el('div', 'error', (err as Error).message));
        }
      }
    };
  }

  app.appendChild(head);

  const categories = Array.from(new Set(v.diffs.map((d) => d.category))).sort();
  const filterPanel = el('section', 'panel');
  const tabs = el('div', 'tabs');
  const mkTab = (key: string, label: string, count: number): void => {
    const b = el('button', state.categoryFilter === key ? 'active' : '', `${label} (${count})`);
    b.type = 'button';
    b.onclick = () => {
      state.categoryFilter = key;
      renderCase();
    };
    tabs.appendChild(b);
  };
  mkTab('all', '全部', v.diffs.length);
  for (const c of categories) mkTab(c, CATEGORY_LABELS[c] ?? c, v.diffs.filter((d) => d.category === c).length);
  filterPanel.appendChild(tabs);
  const stats = el('div', 'muted');
  const pending = v.diffs.filter((d) => !d.decision).length;
  stats.textContent = `共 ${v.diffs.length} 条规范化差异，待处理 ${pending} 条。属性顺序变化不会产生差异。`;
  filterPanel.appendChild(stats);
  app.appendChild(filterPanel);

  const diffPanel = el('section');
  const shown = state.categoryFilter === 'all' ? v.diffs : v.diffs.filter((d) => d.category === state.categoryFilter);
  if (shown.length === 0) {
    diffPanel.appendChild(el('div', 'panel muted', '该分类下没有差异 —— 这两份文档在这个维度上完全一致。'));
  }
  for (const d of shown) diffPanel.appendChild(renderDiff(v, d));
  app.appendChild(diffPanel);

  const eventsPanel = el('section', 'panel');
  eventsPanel.appendChild(el('h2', undefined, '事件流（顺序递增事件号，只追加不改写）'));
  const table = el('table', 'events');
  table.innerHTML = '<tr><th>#</th><th>事件</th><th>状态</th><th>操作者</th><th>理由/说明</th><th>豁免到期</th><th>时间</th></tr>';
  for (const e of state.events) {
    const tr = el('tr');
    tr.append(
      el('td', undefined, String(e.eventNo)),
      el('td', undefined, String(e.kind)),
      el('td', undefined, e.state ? String(e.state) : ''),
      el('td', undefined, e.actor ? String(e.actor) : ''),
      el('td', undefined, e.rationale ? String(e.rationale) : ''),
      el('td', undefined, e.expiresAt ? String(e.expiresAt) : ''),
      el('td', undefined, String(e.createdAt ?? ''))
    );
    table.appendChild(tr);
  }
  eventsPanel.appendChild(table);
  app.appendChild(eventsPanel);
}

function renderDiff(v: Revision, d: DiffItem): HTMLElement {
  const card = el('article', 'diff');
  const head = el('header');
  head.appendChild(el('span', 'badge cat', CATEGORY_LABELS[d.category] ?? d.category));
  head.appendChild(el('span', 'scope', d.scope + (d.subject ? ` · ${d.subject}` : '')));
  head.appendChild(el('span', 'muted', `v${d.version}`));
  if (d.decision) {
    const label = d.decision.expired ? '豁免已到期' : CATEGORY_LABELS[d.decision.effectiveState] ?? d.decision.effectiveState;
    const cls = d.decision.expired ? 'expired' : d.decision.effectiveState;
    const badge = el('span', `badge ${cls}`, `${label} · @${d.decision.actor}`);
    head.appendChild(badge);
  } else {
    head.appendChild(el('span', 'badge expired', '待处理'));
  }
  card.appendChild(head);

  const body = el('div', 'body');
  const impactRow = el('div', 'row');
  const impact = el('div', 'impact');
  impact.style.flex = '1';
  impact.textContent = d.impact;
  const copyBtn = el('button', 'ghost', '复制调用方影响说明');
  copyBtn.type = 'button';
  copyBtn.onclick = async () => {
    await navigator.clipboard.writeText(d.impact);
    copyBtn.textContent = '已复制';
    setTimeout(() => (copyBtn.textContent = '复制调用方影响说明'), 1200);
  };
  impactRow.append(impact, copyBtn);
  body.appendChild(impactRow);

  const vals = el('div', 'vals');
  const preB = el('pre');
  preB.textContent = JSON.stringify(d.beforeJson, null, 2);
  const preA = el('pre');
  preA.textContent = JSON.stringify(d.afterJson, null, 2);
  vals.append(preB, preA);
  body.appendChild(vals);
  card.appendChild(body);

  if (d.decision) {
    const box = el('div', 'decision');
    const p = el('div');
    p.textContent = `最近决议（事件 #${d.decision.eventNo || '继承'}，${d.decision.decidedAt}）：${d.decision.state}`;
    box.appendChild(p);
    const r = el('div', 'muted');
    r.style.marginTop = '4px';
    r.textContent = `理由：${d.decision.rationale}${d.decision.expiresAt ? `；豁免期限：${d.decision.expiresAt}${d.decision.expired ? '（已到期，当前按拒绝处理）' : ''}` : ''}`;
    box.appendChild(r);
    card.appendChild(box);
  }

  if (!v.readOnly) card.appendChild(renderDecisionForm(v, d));
  return card;
}

function renderDecisionForm(v: Revision, d: DiffItem): HTMLElement {
  const box = el('div', 'decision');
  const grid = el('div');
  grid.style.display = 'grid';
  grid.style.gridTemplateColumns = '180px 1fr';
  grid.style.gap = '10px';

  const actorLabel = el('label', 'field', '操作者');
  const actorInput = el('input');
  actorInput.type = 'text';
  actorInput.placeholder = '工号或姓名';
  const stateLabel = el('label', 'field', '决议');
  const stateSelect = el('select') as HTMLSelectElement;
  for (const [value, label] of [
    ['accepted', '接受（变更允许上线）'],
    ['rejected', '拒绝（要求修改方回退/调整）'],
    ['exempted', '带期限豁免（临时放行）']
  ]) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = label;
    stateSelect.appendChild(opt);
  }
  const expLabel = el('label', 'field', '豁免到期时间（UTC）');
  const expInput = el('input');
  expInput.type = 'text';
  expInput.placeholder = '例如 2026-12-31T16:00:00Z';
  expInput.style.display = 'none';
  expLabel.style.display = 'none';
  stateSelect.onchange = () => {
    const show = stateSelect.value === 'exempted';
    expInput.style.display = show ? 'block' : 'none';
    expLabel.style.display = show ? 'block' : 'none';
  };
  const ratLabel = el('label', 'field', '理由（纯文本记录，不会被当作模板/代码执行）');
  const ratInput = el('textarea');
  ratInput.style.minHeight = '60px';

  grid.append(actorLabel, actorInput, stateLabel, stateSelect, expLabel, expInput, ratLabel, ratInput);
  box.appendChild(grid);

  const errBox = el('div');
  const saveBtn = el('button', undefined, '提交决议');
  saveBtn.type = 'button';
  const row = el('div', 'row');
  row.style.marginTop = '10px';
  row.appendChild(saveBtn);
  box.append(errBox, row);

  saveBtn.onclick = async () => {
    errBox.textContent = '';
    try {
      const payload: Record<string, unknown> = {
        caseId: v.caseId,
        baseVersion: d.version,
        state: stateSelect.value,
        actor: actorInput.value,
        rationale: ratInput.value
      };
      if (stateSelect.value === 'exempted') payload.expiresAt = expInput.value || new Date(Date.now() + 7 * 86400000).toISOString();
      await api(`/api/diffs/${d.id}/decision`, { method: 'PUT', body: JSON.stringify(payload) });
      await openCase(v.caseId, v.id);
    } catch (err) {
      const e = err as { status?: number; body?: any };
      if (e.status === 409 && e.body?.conflict) {
        errBox.appendChild(renderConflict(v, d, e.body, {
          actor: actorInput.value,
          state: stateSelect.value as DecisionState,
          rationale: ratInput.value,
          expiresAt: expInput.value
        }));
      } else {
        errBox.appendChild(el('div', 'error', e.body?.error?.message ?? (err as Error).message));
      }
    }
  };

  return box;
}

function renderConflict(v: Revision, d: DiffItem, conflict: any, submitted: Record<string, string>): HTMLElement {
  const box = el('div', 'conflict-box');
  box.appendChild(el('div', undefined, `并发冲突：你基于版本 ${conflict.baseVersion}，该差异当前已是版本 ${conflict.currentVersion}。后保存不会覆盖先保存。`));
  const cur = el('pre');
  cur.textContent = conflict.current
    ? `对方内容：${conflict.current.state} @${conflict.current.actor}\n理由：${conflict.current.rationale}\n豁免到期：${conflict.current.expiresAt ?? '-'}`
    : '对方已清空决议（无当前内容）。';
  cur.style.background = '#fff';
  cur.style.border = '1px solid #fecaca';
  cur.style.padding = '8px';
  cur.style.borderRadius = '6px';
  box.appendChild(cur);
  const mine = el('pre');
  mine.textContent = `你的内容：${submitted.state} @${submitted.actor}\n理由：${submitted.rationale}\n豁免到期：${submitted.expiresAt || '-'}`;
  mine.style.background = '#fff';
  mine.style.border = '1px solid #bfdbfe';
  mine.style.padding = '8px';
  mine.style.borderRadius = '6px';
  box.appendChild(mine);
  const retry = el('button', undefined, '基于最新版本重试（仍提交我的内容）');
  retry.type = 'button';
  retry.style.marginTop = '8px';
  retry.onclick = async () => {
    const payload: Record<string, unknown> = {
      caseId: v.caseId,
      baseVersion: conflict.currentVersion,
      state: submitted.state,
      actor: submitted.actor,
      rationale: submitted.rationale
    };
    if (submitted.state === 'exempted') payload.expiresAt = submitted.expiresAt;
    try {
      await api(`/api/diffs/${d.id}/decision`, { method: 'PUT', body: JSON.stringify(payload) });
      await openCase(v.caseId, v.id);
    } catch (err2) {
      box.appendChild(el('div', 'error', (err2 as Error).message));
    }
  };
  box.appendChild(retry);
  return box;
}

renderHome();
