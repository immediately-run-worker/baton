// S-BTN-42 webhooks (BATON_SPEC §13a, §7.1 R-BTN-73; G-BTN-68; R3-1247): a GitHub App delivery
// is only a trigger. Must hold: a `pull_request_review` for a code repository a ticket lists
// dispatches the home repository's sync; the same delivery again and a forged one dispatch
// nothing; a burst of ten `issue_comment` deliveries over 20 seconds yields one dispatch at
// once and one trailing dispatch when its 30-second window closes; the sync's own
// `workflow_run` and the mirror's push dispatch nothing, so the syncs stop; extra payload fields
// change nothing (the unit tests record that no field beyond R-BTN-73's list is read). Runs on
// both hosts.
//
// "The ticket's station moves within the run" is the sync's (docs) and R3-1232's stations: here,
// the dispatch that starts that run.
import { describe, it, expect, inject, beforeEach } from 'vitest';
import { armedAt, captureDispatches, HOST, payload, rows, setClock, syncCall, tick, webhookCall, withCore } from '../helpers';

const board = inject('board');
// Ahead of the real clock, so an alarm armed for a window's close is still in the future on
// workerd (one armed in the past fires and clears at once).
const T0 = Math.ceil(Date.now() / 1000) * 1000 + 600_000;
const fixture = board.states.A.state.items[0] as Record<string, unknown>;
const review = { action: 'submitted', repository: { full_name: 'immediately-run/sandbox', private: true }, review: { body: 'never read' } };
const comment = { action: 'created', repository: { full_name: 'immediately-run/sandbox' }, comment: { body: 'x' } };

beforeEach(async () => {
  await setClock(T0);
  // docs' board with a ticket that lists the code repository immediately-run/sandbox.
  const items = [...(board.states.A.state.items as Record<string, unknown>[]), { ...fixture, id: 'T-1', title: 'docs: T-1', repos: ['immediately-run/sandbox'] }];
  expect((await syncCall('/v1/sync/board', payload(board.shas.A, null, { ...board.states.A, state: { items } }))).status).toBe(200);
});

describe(`S-BTN-42 webhooks (${HOST})`, () => {
  it('a review in a code repository a ticket lists dispatches its home repository’s sync; the repeat and a forged one nothing', async () => {
    const sent = await captureDispatches();
    const first = await webhookCall('pull_request_review', review, { id: 'd-1' });
    // §11: 204, with nothing of Baton's in the App's delivery log.
    expect([first.status, await first.text()]).toEqual([204, '']);
    expect(sent).toEqual(['docs:sync']);
    await setClock(T0 + 60_000);
    expect((await webhookCall('pull_request_review', review, { id: 'd-1' })).status).toBe(204);
    expect(sent).toEqual(['docs:sync']);
    const forged = await webhookCall('pull_request_review', review, { id: 'd-2', secret: 'not-the-secret' });
    expect(forged.status).toBe(401);
    expect(sent).toEqual(['docs:sync']);
    expect(await rows('SELECT delivery_id FROM webhook_deliveries')).toEqual([{ delivery_id: 'd-1' }]);
  });

  it('a burst of ten comments over 20 seconds: one dispatch at once, one trailing when the window closes', async () => {
    const sent = await captureDispatches();
    // The regular alarm, a tick away on this clock.
    await withCore((c) => (c as unknown as { ports: { scheduler: { set(at: number): Promise<void> } } }).ports.scheduler.set(T0 + 60_000));
    for (let i = 0; i < 10; i++) {
      await setClock(T0 + i * 2_000);
      expect((await webhookCall('issue_comment', comment, { id: `burst-${i}` })).status).toBe(204);
    }
    expect(sent).toEqual(['docs:sync']);
    // The alarm is armed for the window's close, not the next 60-second tick (round 1, 1-A-1).
    expect(await armedAt()).toBe(T0 + 30_000);
    await setClock(T0 + 29_999);
    await tick();
    expect(sent).toEqual(['docs:sync']);
    await setClock(T0 + 30_000);
    await tick();
    expect(sent).toEqual(['docs:sync', 'docs:sync']);
    // The trailing dispatch opened a new window; nothing more is owed.
    await setClock(T0 + 120_000);
    await tick();
    expect(sent).toEqual(['docs:sync', 'docs:sync']);
  });

  it('the sync’s own workflow_run and the mirror’s push dispatch nothing, so the syncs stop', async () => {
    const sent = await captureDispatches();
    await webhookCall('workflow_run', { action: 'completed', repository: { full_name: 'immediately-run/docs' }, workflow_run: { path: '.github/workflows/baton-sync.yml' } });
    await webhookCall('push', { repository: { full_name: 'immediately-run/docs' }, pusher: { name: 'github-actions[bot]' }, head_commit: { author: { email: 'baton-mirror@immediately.run' } } });
    expect(sent).toEqual([]);
    // Another workflow's run in docs is a trigger.
    await webhookCall('workflow_run', { repository: { full_name: 'immediately-run/docs' }, workflow_run: { path: '.github/workflows/ci.yml' } });
    expect(sent).toEqual(['docs:sync']);
  });

  it('extra payload fields change nothing; an event outside the five, or a repository no ticket names, dispatches nothing', async () => {
    const sent = await captureDispatches();
    for (const [event, body] of [['ping', { zen: 'x', repository: { full_name: 'immediately-run/sandbox' } }], ['check_suite', review], ['pull_request', { repository: { full_name: 'immediately-run/elsewhere' } }]] as const) {
      expect((await webhookCall(event, body)).status).toBe(204);
    }
    expect(sent).toEqual([]);
    // Dropped deliveries are not even remembered: only the one that reached the core is.
    expect(await rows('SELECT count(*) AS n FROM webhook_deliveries')).toEqual([{ n: 1 }]);
    expect((await webhookCall('pull_request', { ...review, sender: { login: 'x' }, pull_request: { title: 'y', body: 'z' }, installation: { id: 1 } })).status).toBe(204);
    expect(sent).toEqual(['docs:sync']);
  });
});
