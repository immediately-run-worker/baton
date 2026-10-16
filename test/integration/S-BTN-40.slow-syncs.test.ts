// S-BTN-40 slow and stale syncs, end to end (BATON_SPEC §13a, §2e, R-BTN-10, R-BTN-62; R3-1232): W1
// runs filed → merged through two review loops and archives; every sync is slow, one arrives
// during a held force-push, and the archive's sync takes its number before W1's /end. Must hold:
// every advance is accepted as an edge; no sync ends the claim stale; the held post's stations are
// accepted; the done end is confirmed from the recorded closure; the ticket is never offered to
// another worker in between. (A stale checkout posting nothing, and the schedule covering a lost
// delivery, are the CLI's and the workflow's: S-BTN-13 and R-BTN-73.) Runs on both hosts.
import { describe, it, expect, beforeEach } from 'vitest';
import { advance, claimItem, claimRow, cutover, endClaim, Git, observe, placed, recommended, register, rows, setClock, syncCall } from '../helpers';

const T0 = Date.parse('2026-10-16T12:00:00Z');
let git: Git;

beforeEach(async () => {
  await setClock(T0);
  git = new Git().add('T-1');
  await git.post();
  await cutover();
});

describe('S-BTN-40 slow and stale syncs, end to end', () => {
  it('two review loops under one claim, the syncs always behind; done confirmed from the closure', async () => {
    const w1 = await register('vm-a', { lease_timeout_s: 86_400 });
    const w2 = await register('vm-b', { lease_timeout_s: 86_400 });
    const { json: c } = await claimItem('vm-a', w1.secret);
    const never = async () => expect(await recommended(w2.id)).toEqual([]);

    // [advance, the path a slow sync then posts — always one leg or more behind the holder]
    const run: [Record<string, unknown>, [string, string][] | null][] = [
      [{ leg: 'implement' }, null],
      [{ reached: 'pr-open', leg: 'review' }, []],
      [{ reached: 'reviewed', leg: 'fix' }, [['implement', 'pr-open']]],
      [{ reached: 'fixed', leg: 'review' }, [['implement', 'pr-open'], ['review', 'reviewed']]],
      [{ reached: 'reviewed', leg: 'fix' }, [['implement', 'pr-open'], ['review', 'reviewed'], ['fix', 'fixed']]],
      [{ reached: 'fixed', leg: 'review' }, [['implement', 'pr-open'], ['review', 'reviewed'], ['fix', 'fixed'], ['review', 'reviewed']]],
      [{ reached: 'reviewed', leg: 'merge' }, [['implement', 'pr-open'], ['review', 'reviewed'], ['fix', 'fixed'], ['review', 'reviewed'], ['fix', 'fixed']]],
    ];
    let t = T0;
    for (const [body, lagging] of run) {
      t += 10 * 60_000;
      await setClock(t);
      expect([body.leg, (await advance('vm-a', w1.secret, c.claim_id, body)).status]).toEqual([body.leg, 200]);
      if (!lagging) continue;
      const station = lagging.length ? lagging[lagging.length - 1][1] : 'filed';
      git.place('T-1', placed(station, lagging, []));
      expect(await git.refresh()).toMatchObject({ status: 200, stale_released: 0 });
      await never();
    }
    // A force-push rewrites main meanwhile: the post is held, but its stations — which no commit
    // orders — are a refresh against the head.
    git.place('T-1', placed('reviewed', run[6][1]!.concat([['review', 'reviewed']]), [['merge', 'ready']]));
    const held = await syncCall('/v1/sync/board', git.body('d'.repeat(40), 'e'.repeat(40), { force: true }));
    expect(held.status).toBe(409);
    expect(await rows(`SELECT station, path_len FROM ticket_stations WHERE ticket_id = 'docs:T-1'`)).toEqual([{ station: 'reviewed', path_len: 6 }]);
    expect(await claimRow(c.claim_id)).toMatchObject({ status: 'active' });
    expect(await rows('SELECT regressed_since FROM claims WHERE id = ?', c.claim_id)).toEqual([{ regressed_since: null }]);
    await never();

    // The merge leg archives the ticket; the archive's sync takes its number and posts it before
    // W1's /end arrives (git first, R-BTN-8).
    git.close('T-1', 'done');
    expect(await git.post()).toMatchObject({ status: 200, stale_released: 0 });
    await never();
    // W1's end is confirmed at once by that closure: its observation is newer than the claim's.
    expect((await endClaim('vm-a', w1.secret, c.claim_id, { end_reason: 'done', reached: 'merged' })).status).toBe(200);
    expect(await claimRow(c.claim_id)).toMatchObject({ status: 'completed', end_reason: 'done', confirmed_at: t });
    expect(await rows(`SELECT actor, json_extract(detail_json, '$.by') AS by FROM events WHERE kind = 'confirmed' AND claim_id = ?`, c.claim_id)).toEqual([{ actor: 'sync', by: 'closure' }]);
    expect(await rows(`SELECT kind FROM events WHERE claim_id = ? AND kind = 'advanced'`, c.claim_id)).toHaveLength(7);
  });

  it('a closure reported before the claim’s latest advance does not confirm a later done: only a newer one does', async () => {
    const w1 = await register('vm-a');
    const { json: c } = await claimItem('vm-a', w1.secret);
    await advance('vm-a', w1.secret, c.claim_id, { leg: 'implement' });
    // A snapshot reports T-1 closed (someone archived it); W1 then advances anyway and ends done.
    git.close('T-1', 'done');
    await git.post();
    await rows(`UPDATE claims SET claim_observation = (SELECT last_handed_out FROM board_head WHERE repository_id = 'docs') WHERE id = ?`, c.claim_id);
    await endClaim('vm-a', w1.secret, c.claim_id, { end_reason: 'done', reached: 'pr-open' });
    expect((await claimRow(c.claim_id)).confirmed_at).toBeNull();
    // The next snapshot, observed after the end, has the ticket absent: that confirms it.
    expect(await git.refresh()).toMatchObject({ confirmed: 1 });
  });
  it('a merge the sync read after the advance and posted before the done confirms it at once (R3-1244: found by the model-based tests)', async () => {
    const loop: [string, string][] = [['implement', 'pr-open'], ['review', 'reviewed']];
    git.place('T-1', placed('reviewed', loop, [['merge', 'ready']]));
    await git.refresh();
    const w1 = await register('vm-a');
    const { json: c } = await claimItem('vm-a', w1.secret);
    expect((await advance('vm-a', w1.secret, c.claim_id, { leg: 'merge' })).status).toBe(200);
    // the holder pushes the merge, the sync reads and posts it, and only then /end arrives
    git.place('T-1', placed('merged', [...loop, ['merge', 'merged']], []));
    expect(await git.refresh()).toMatchObject({ status: 200 });
    expect((await endClaim('vm-a', w1.secret, c.claim_id, { end_reason: 'done', reached: 'merged' })).status).toBe(200);
    expect(await claimRow(c.claim_id)).toMatchObject({ status: 'completed', end_reason: 'done', confirmed_at: T0 });
    expect(await rows(`SELECT json_extract(detail_json, '$.by') AS by FROM events WHERE kind = 'confirmed' AND claim_id = ?`, c.claim_id)).toEqual([{ by: 'end-station' }]);
  });

  it('a merged station read before the advance confirms nothing at the end', async () => {
    const loop: [string, string][] = [['implement', 'pr-open'], ['review', 'reviewed']];
    git.place('T-1', placed('reviewed', loop, [['merge', 'ready']]));
    await git.refresh();
    const w1 = await register('vm-a');
    const { json: c } = await claimItem('vm-a', w1.secret);
    const n = (await observe()).json.observation; // the sync starts reading…
    expect((await advance('vm-a', w1.secret, c.claim_id, { leg: 'merge' })).status).toBe(200); // …the holder advances
    git.place('T-1', placed('merged', [...loop, ['merge', 'merged']], []));
    expect(await git.post({ observation: n })).toMatchObject({ status: 200 });
    expect((await endClaim('vm-a', w1.secret, c.claim_id, { end_reason: 'done', reached: 'merged' })).status).toBe(200);
    expect((await claimRow(c.claim_id)).confirmed_at).toBeNull();
    // a reading after the end that shows it merged does (G-BTN-44)
    expect(await git.refresh()).toMatchObject({ confirmed: 1 });
  });
});
