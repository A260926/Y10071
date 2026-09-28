import { beforeEach, describe, expect, it } from 'vitest';
import { Store, ConflictError } from '../src/store.js';
import { loadDoc } from './helpers.js';
import { diffSpecs } from '../src/diff.js';

describe('并发决议（乐观版本号）', () => {
  let store: Store;
  let identity: string;
  let ticketId: string;

  beforeEach(() => {
    store = new Store(':memory:');
    ticketId = store.createTicket('T').id;
    const before = loadDoc('breaking-change', 'before');
    const after = loadDoc('breaking-change', 'after');
    store.addRevision(ticketId, before, after, diffSpecs(before.spec, after.spec));
    const view = store.getTicketView(ticketId) as Record<string, unknown>;
    identity = (view.diffs as Array<{ identity: string }>)[0].identity;
  });

  const payload = (operator: string, reason: string, expectedVersion: number) => ({
    status: 'accepted' as const,
    reason,
    operator,
    expectedVersion,
  });

  it('两个并发保存只有一个成功，冲突携带双方内容', () => {
    const first = store.saveDecision(ticketId, identity, payload('alice', '我先接受', 0));
    expect(first.decision.version).toBe(1);

    const conflict = expect(() =>
      store.saveDecision(ticketId, identity, payload('bob', '我也要接受，基于旧版本', 0)),
    ).toThrow(ConflictError);
    expect(conflict).toBeTruthy();

    let caught: ConflictError | null = null;
    try {
      store.saveDecision(ticketId, identity, payload('bob', '我也要接受，基于旧版本', 0));
    } catch (err) {
      caught = err as ConflictError;
    }
    expect(caught).toBeInstanceOf(ConflictError);
    expect(caught!.current?.version).toBe(1);
    expect(caught!.current?.operator).toBe('alice');
    expect(caught!.attempted).toMatchObject({ operator: 'bob', expectedVersion: 0 });

    const retried = store.saveDecision(
      ticketId,
      identity,
      payload('bob', '看到 alice 的版本后重新接受', 1),
    );
    expect(retried.decision.version).toBe(2);
    expect(retried.decision.operator).toBe('bob');
  });

  it('事件号在同一审议单内顺序递增', () => {
    const view = store.getTicketView(ticketId) as Record<string, unknown>;
    const diffs = view.diffs as Array<{ identity: string }>;
    store.saveDecision(ticketId, diffs[0].identity, payload('alice', '理由一', 0));
    store.saveDecision(ticketId, diffs[1].identity, payload('alice', '理由二', 0));
    store.saveDecision(ticketId, diffs[0].identity, payload('alice', '理由三', 1));
    const events = store.listEvents(ticketId) as Array<{ eventNo: number }>;
    expect(events.map((e) => e.eventNo)).toEqual([1, 2, 3]);
  });
});
