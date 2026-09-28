'use strict';

const $ = (id) => document.getElementById(id);

const state = {
  ticketId: null,
  view: null,
  categoryFilter: null,
  fixtures: [],
};

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: options.body ? { 'content-type': 'application/json' } : undefined,
    ...options,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.message || `HTTP ${res.status}`), { status: res.status, body });
  return body;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function setStatus(text, isError) {
  const node = $('revision-status');
  node.textContent = text;
  node.style.color = isError ? 'var(--danger)' : 'var(--ok)';
}

async function refreshTickets(selectId) {
  const { tickets } = await api('/api/tickets');
  const select = $(selectId);
  select.replaceChildren();
  const placeholder = el('option', '', '-- 选择已有审议单 --');
  placeholder.value = '';
  select.appendChild(placeholder);
  for (const ticket of tickets) {
    const option = el('option', '', `${ticket.title}（修订 ${ticket.revisions}）`);
    option.value = ticket.id;
    select.appendChild(option);
  }
  return tickets;
}

async function refreshView() {
  if (!state.ticketId) return;
  state.view = await api(`/api/tickets/${state.ticketId}`);
  renderView();
}

function renderRevisionMeta() {
  const meta = $('revision-meta');
  meta.replaceChildren();
  const current = state.view.revisions[0];
  if (!current) {
    meta.append(el('span', '', '尚无修订，请先上传 before/after 文档。'));
    return;
  }
  const before = JSON.parse(current.beforeSummary);
  const after = JSON.parse(current.afterSummary);
  meta.append(
    el('span', '', `当前修订 #${current.seq}　before: ${before.title || '未命名'}@${before.version || '?'}（${before.sha256.slice(0, 10)}）`),
    el('br'),
    el('span', '', `　　　　　　after: ${after.title || '未命名'}@${after.version || '?'}（${after.sha256.slice(0, 10)}），共 ${state.view.diffs.length} 条差异。旧修订只读。`),
  );
}

function renderCategoryFilters() {
  const filters = $('category-filters');
  filters.replaceChildren();
  const categories = [...new Set(state.view.diffs.map((d) => d.category))].sort();
  const all = el('button', state.categoryFilter === null ? 'active' : '', `全部 ${state.view.diffs.length}`);
  all.onclick = () => {
    state.categoryFilter = null;
    renderDiffs();
    renderCategoryFilters();
  };
  filters.appendChild(all);
  for (const category of categories) {
    const count = state.view.diffs.filter((d) => d.category === category).length;
    const button = el('button', state.categoryFilter === category ? 'active' : '', `${category} ${count}`);
    button.onclick = () => {
      state.categoryFilter = category;
      renderDiffs();
      renderCategoryFilters();
    };
    filters.appendChild(button);
  }
}

function renderDiffs() {
  const list = $('diff-list');
  list.replaceChildren();
  const diffs = state.categoryFilter
    ? state.view.diffs.filter((d) => d.category === state.categoryFilter)
    : state.view.diffs;
  if (diffs.length === 0) {
    list.appendChild(el('p', 'muted', '该类别下没有差异。'));
    return;
  }
  for (const diff of diffs) list.appendChild(renderDiffCard(diff));
}

function statusLabel(status) {
  return { accepted: '已接受', rejected: '已拒绝', exempt: '豁免中', expired: '豁免已过期', pending: '待审议' }[status] ?? status;
}

function renderDiffCard(diff) {
  const card = el('div', 'diff-card');
  const head = el('div', 'diff-head');
  head.appendChild(el('span', `badge ${diff.category}`, diff.category));
  head.appendChild(el('span', 'location', diff.location));
  head.appendChild(el('span', 'subject', diff.subject));
  if (diff.decision) {
    head.appendChild(el('span', `status-pill ${diff.decision.effectiveStatus}`, statusLabel(diff.decision.effectiveStatus)));
  }
  card.appendChild(head);

  const impactRow = el('div', 'row');
  impactRow.style.margin = '8px 0';
  const impact = el('div', 'impact', diff.impact);
  impact.style.flex = '1';
  impactRow.appendChild(impact);
  const copyButton = el('button', '', '复制调用方影响说明');
  copyButton.onclick = async () => {
    await navigator.clipboard.writeText(diff.impact);
    copyButton.textContent = '已复制';
    setTimeout(() => {
      copyButton.textContent = '复制调用方影响说明';
    }, 1200);
  };
  impactRow.appendChild(copyButton);
  card.appendChild(impactRow);

  const form = el('div', 'decision-form');
  const status = el('select');
  for (const [value, label] of [
    ['accepted', '接受'],
    ['rejected', '拒绝'],
    ['exempt', '带期限豁免'],
  ]) {
    status.appendChild(el('option', '', label)).value = value;
  }
  const operator = el('input');
  operator.type = 'text';
  operator.placeholder = '操作者';
  operator.value = diff.decision?.operator ?? '';
  const reason = el('input');
  reason.type = 'text';
  reason.placeholder = '决议理由（仅作为文本保存，不会被执行）';
  reason.value = diff.decision?.reason ?? '';
  const deadline = el('input');
  deadline.type = 'datetime-local';
  if (diff.decision?.deadline) deadline.value = toLocalInput(diff.decision.deadline);
  const saveButton = el('button', 'primary', '提交决议');
  form.append(status, operator, reason, deadline, saveButton);
  if (diff.decision) {
    status.value = diff.decision.status;
    form.appendChild(el('span', 'muted', `v${diff.decision.version}，基于 #${diff.decision.updatedAt}`));
  }
  card.appendChild(form);

  const conflictBox = el('div', 'conflict');
  conflictBox.hidden = true;
  card.appendChild(conflictBox);

  saveButton.onclick = async () => {
    saveButton.disabled = true;
    conflictBox.hidden = true;
    try {
      await api(`/api/tickets/${state.ticketId}/diffs/${diff.identity}/decision`, {
        method: 'PUT',
        body: JSON.stringify({
          status: status.value,
          operator: operator.value,
          reason: reason.value,
          deadline: status.value === 'exempt' ? new Date(deadline.value).toISOString() : null,
          expectedVersion: diff.decision?.version ?? 0,
        }),
      });
      await refreshView();
    } catch (err) {
      saveButton.disabled = false;
      if (err.status === 409) renderConflict(conflictBox, err.body, () => refreshView());
      else conflictBox.replaceChildren(el('div', '', err.message));
      conflictBox.hidden = false;
    }
  };
  return card;
}

function renderConflict(box, body, onRetry) {
  box.replaceChildren();
  box.appendChild(el('div', '', body.message));
  box.appendChild(el('div', 'muted', '服务器当前版本：'));
  box.appendChild(el('pre', '', JSON.stringify(body.current, null, 2)));
  box.appendChild(el('div', 'muted', '你本次提交的内容：'));
  box.appendChild(el('pre', '', JSON.stringify(body.attempted, null, 2)));
  const retry = el('button', 'primary', '拉取最新版本并重试');
  retry.onclick = onRetry;
  box.appendChild(retry);
}

function toLocalInput(iso) {
  const date = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function renderEvents() {
  const list = $('event-list');
  list.replaceChildren();
  api(`/api/tickets/${state.ticketId}/events`).then(({ events }) => {
    for (const event of events) {
      const item = el('li', '');
      item.append(
        el('strong', '', `#${event.eventNo} ${statusLabel(event.status)}　${event.category ?? ''}`),
        document.createTextNode(` 差异 ${event.identity.slice(0, 8)}　操作者：${event.operator}　理由：`),
        el('span', '', event.reason),
      );
      if (event.deadline) item.appendChild(el('span', '', `　期限：${event.deadline}`));
      item.appendChild(el('div', 'event-hash', `依据文档摘要 before=${event.beforeHash.slice(0, 10)} after=${event.afterHash.slice(0, 10)}　${event.createdAt}`));
      list.appendChild(item);
    }
  });
}

function renderView() {
  $('diffs-section').hidden = false;
  $('events-section').hidden = false;
  renderRevisionMeta();
  renderCategoryFilters();
  renderDiffs();
  renderEvents();
}

function bindFileInput(inputId, textareaId) {
  $(inputId).addEventListener('change', async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    $(textareaId).value = await file.text();
  });
}

async function init() {
  state.fixtures = (await api('/api/fixtures')).fixtures;
  const select = $('fixture-select');
  for (const name of state.fixtures) select.appendChild(el('option', '', name)).value = name;
  select.lastChild.value = state.fixtures[state.fixtures.length - 1];
  if (state.fixtures.includes('breaking-change')) select.value = 'breaking-change';

  await refreshTickets('ticket-select');

  $('create-ticket').onclick = async () => {
    const ticket = await api('/api/tickets', {
      method: 'POST',
      body: JSON.stringify({ title: $('ticket-title').value }),
    });
    state.ticketId = ticket.id;
    $('upload-section').hidden = false;
    await refreshTickets('ticket-select');
    $('ticket-select').value = ticket.id;
  };

  $('ticket-select').onchange = async (event) => {
    state.ticketId = event.target.value || null;
    $('upload-section').hidden = !state.ticketId;
    $('diffs-section').hidden = true;
    $('events-section').hidden = true;
    if (state.ticketId) await refreshView();
  };

  $('load-fixture').onclick = async () => {
    const name = $('fixture-select').value;
    const fixture = await api(`/api/fixtures/${name}`);
    $('before-text').value = fixture.before;
    $('after-text').value = fixture.after;
    $('upload-error').hidden = true;
  };

  bindFileInput('before-file', 'before-text');
  bindFileInput('after-file', 'after-text');

  $('submit-revision').onclick = async () => {
    $('upload-error').hidden = true;
    try {
      const result = await api(`/api/tickets/${state.ticketId}/revisions`, {
        method: 'POST',
        body: JSON.stringify({ before: $('before-text').value, after: $('after-text').value }),
      });
      setStatus(
        result.reused
          ? `文档内容与现有修订 #${result.revision.seq} 一致（仅排版不同），已复用差异，保留 ${result.inherited} 条已有决议。`
          : `已创建修订 #${result.revision.seq}，${result.inherited} 条同名差异自动继承了既有决议。`,
        false,
      );
      await refreshView();
    } catch (err) {
      const body = err.body ?? {};
      if (body.error === 'invalid-document') {
        const where = body.line !== null ? `第 ${body.line} 行第 ${body.col} 列附近` : '';
        $('upload-error').textContent = `${body.document} 文档解析失败 ${where}\n${body.message}${body.snippet ? `\n> ${body.snippet}` : ''}`;
      } else {
        $('upload-error').textContent = err.message;
      }
      $('upload-error').hidden = false;
    }
  };
}

init();
