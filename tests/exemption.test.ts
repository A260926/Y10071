import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store, ValidationError } from '../src/store.js';
import { clock, resetClock, setClock } from '../src/clock.js';
import { loadDoc } from './helpers.js';
import { diffSpecs } from '../src/diff.js';

describe('豁免边界（读取时刻推导）', () => {
  let store: Store;
  let ticketId: string;
  const t0 = new Date('2026-10-01T00:00:00Z').getTime();

  beforeEach(() => {
    store = new Store(':memory:');
    ticketId = store.createTicket('T').id;
    const before = loadDoc('breaking-change', 'before');
    const after = loadDoc('breaking-change', 'after');
    store.addRevision(ticketId, before, after, diffSpecs(before.spec, after.spec));
    setClock(() => new Date(t0));
  });

  afterEach(() => {
    resetClock();
    store.close();
  });

  function nullableDiff(): string {
    const view = store.getTicketView(ticketId) as Record<string, unknown>;
    return (view.diffs as Array<{ category: string; identity: string }>).find(
      (d) => d.category === 'nullable-changed',
    )!.identity;
  }

  it('豁免必须提供晚于当前时间的期限', () => {
    const identity = nullableDiff();
    expect(() =>
      store.saveDecision(ticketId, identity, {
        status: 'exempt',
        reason: '临时放行',
        operator: 'alice',
        expectedVersion: 0,
      }),
    ).toThrow(ValidationError);
    expect(() =>
      store.saveDecision(ticketId, identity, {
        status: 'exempt',
        reason: '临时放行',
        operator: 'alice',
        deadline: new Date(t0 - 1000).toISOString(),
        expectedVersion: 0,
      }),
    ).toThrow(ValidationError);
  });

  it('到期前后读取到不同状态，且历史事件行不被改写', () => {
    const identity = nullableDiff();
    const deadline = new Date(t0 + 3600_000).toISOString();
    store.saveDecision(ticketId, identity, {
      status: 'exempt',
      reason: '等待调用方升级',
      operator: 'alice',
      deadline,
      expectedVersion: 0,
    });

    setClock(() => new Date(t0 + 3599_999));
    let view = store.getTicketView(ticketId) as Record<string, unknown>;
    let decision: { effectiveStatus: string; status: string } = (view.diffs as Array<{ identity: string; decision: { effectiveStatus: string; status: string } }>).find(
      (d) => d.identity === identity,
    )!.decision;
    expect(decision.effectiveStatus).toBe('exempt');

    setClock(() => new Date(t0 + 3600_000));
    view = store.getTicketView(ticketId) as Record<string, unknown>;
    decision = (view.diffs as Array<{ identity: string; decision: { effectiveStatus: string; status: string } }>).find(
      (d) => d.identity === identity,
    )!.decision;
    expect(decision.effectiveStatus).toBe('expired');
    expect(decision.status).toBe('exempt');

    setClock(() => new Date(t0 + 7200_000));
    view = store.getTicketView(ticketId) as Record<string, unknown>;
    decision = (view.diffs as Array<{ identity: string; decision: { effectiveStatus: string; status: string } }>).find(
      (d) => d.identity === identity,
    )!.decision;
    expect(decision.effectiveStatus).toBe('expired');

    const events = store.listEvents(ticketId) as Array<{ status: string; deadline: string }>;
    expect(events).toHaveLength(1);
    expect(events[0].status).toBe('exempt');
    expect(events[0].deadline).toBe(deadline);
    expect(clock.now()).toEqual(new Date(t0 + 7200_000));
  });
});
