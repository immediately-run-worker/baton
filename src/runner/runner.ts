// runner.ts — `baton run`'s generic worker loop (BATON_SPEC §6.13 R-BTN-72): it heartbeats (it
// hosts the sidecar of §6.3–6.4), claims, loads the claim's course file and leg scripts from the
// home checkout at the claim's `snapshot_sha` (R-BTN-34), and runs each leg as a child process
// that gets `IR_BATON_PARENT` and `IR_BATON_STATE` and an AbortSignal. It knows no course: the
// graph and the scripts decide, every result is validated against the snapshot's file, the
// finished leg's `close` writes the closing marker before anything is reported (R-BTN-83), and
// its `handoff` runs before any suspension or release (R-BTN-44). A lost lease aborts the leg at
// once and kills its process group with no hand-off (the resume record covers it, R-BTN-24); a
// release message, a releasing owner bar, a regressed path or a course change stop the leg at its
// next safe point first.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { batonNow } from '../shared/baton.mjs';
import { BatonApi, BatonRefusal } from './api';
import { claimScratch, courseOf, dropCourse, ensureSha, freshSecret, loadCourse, type CourseLoad } from './home';
import { decide, refusalKind, runNumber, shortWaitSpent, waitState } from './protocol';
import { StateFile, leaseLostFrom } from './state';

const LEG_PROCESS = fileURLToPath(new URL('./legProcess.mjs', import.meta.url));
/** §6.3: the sidecar's cadence — every beat 2 minutes. */
export const BEAT_MS = 2 * 60_000;
/** What one leg's snapshot shows of the legs leaving the claim's station (R-BTN-70). */
type NextLegs = { leg: string; state: string; waiting_on?: string }[];

export interface RunnerOptions {
  api: BatonApi;
  /** The home repository's checkout, whose git the course and the scripts come from. */
  home: string;
  /** The Baton repository id that checkout is (the heartbeat's courses are declared for it). */
  repository: string;
  /** The worker's hostname — the credential's registered name (§6.4). */
  hostname: string;
  harness: 'opencode' | 'claude-code';
  session: string;
  /** What the runner declares beside the required: capabilities and the tier ceiling. */
  capabilities?: string[];
  tierCeiling?: string;
  courses: { course: string; version: number }[];
  stateFile: string;
  beatEvery?: number;
  now?: () => number;
  log?: (line: string) => void;
  /** One bounded `git fetch` when the snapshot sha is missing (R-BTN-34). */
  fetch?: (home: string) => void;
}

interface LegChild {
  process: ReturnType<typeof spawn>;
  resultPath: string;
  ctxPath: string;
}

/** How a leg ended for the runner's own accounting; the claim's end is `end_reason`. */
export interface ClaimOutcome {
  ticket: string;
  end_reason: string;
  reached: string | null;
  handoff: string | null;
}

/** Why the sidecar asked the running leg to stop (§6.13's three signal reasons). `reason` is the
 * claim-level end it becomes; a regression names its station only when the leg settles, so it
 * carries none and the runner builds `suspended:<the leg's from>` then. */
interface PendingAbort {
  signal: 'release' | 'regressed' | 'course-changed';
  reason?: string;
}

export class Runner {
  private readonly o: RunnerOptions & { beatEvery: number };
  private readonly state: StateFile;
  private readonly log: (line: string) => void;
  private readonly now: () => number;
  private beat: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private inflight: {
    claimId: number;
    ticket: string;
    course: CourseLoad;
    child: LegChild | null;
    /** Resolved by the next tick's view of the snapshot's next legs (the short-wait re-read). */
    waiters: ((next: NextLegs) => void)[];
  } | null = null;
  private pendingAbort: PendingAbort | null = null;
  private lostLease = false;
  private closedDone = false;
  private toAck: number[] = [];
  /** R-BTN-19: a claim the runner knows it lost, whose fence the next heartbeat clears. */
  private fenceToReport: number | null = null;
  /** R-BTN-77: set when a heartbeat carried an `unblocked` message, so the idle wait ends early. */
  private unblocked = false;
  /** Bumps with every claim: an answer a beat started before the claim cannot fence it. */
  private epoch = 0;
  /** One beat at a time — the sidecar's answers stay ordered against the loop. */
  private ticking = false;
  /** R-BTN-14: a reaped worker re-keys on its next beat; the fresh secret until it lands. */
  private rekeySecret: string | null = null;
  /** An end Baton never answered (the network went with the lease): retried on every beat. */
  private pendingEnd: { claimId: number; body: Record<string, unknown> } | null = null;

  constructor(options: RunnerOptions) {
    this.o = { beatEvery: BEAT_MS, ...options };
    this.log = options.log ?? (() => {});
    this.now = options.now ?? batonNow;
    this.state = new StateFile(options.stateFile);
    if (!this.state.get().secret) this.state.set({ secret: freshSecret() });
    this.o.api.setSecret(this.state.get().secret);
  }

  // ── the sidecar (§6.3–6.4) ───────────────────────────────────────────────────────────────

  start(): void {
    if (this.beat) return;
    this.beat = setInterval(() => void this.tick().catch((e) => this.log(`baton: heartbeat failed (${msg(e)})`)), this.o.beatEvery);
    this.beat.unref?.();
    void this.tick().catch((e) => this.log(`baton: heartbeat failed (${msg(e)})`));
  }

  stop(): void {
    this.stopped = true;
    if (this.beat) clearInterval(this.beat);
    this.beat = null;
  }

  /** One heartbeat, by the timer or a test: the §11 answer drives everything local — the lease,
   * the claim git shows, the messages and the snapshot's next legs. Never concurrent with
   * another beat, so an answer always post-dates the claim state it is judged against. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.beatOnce();
    } finally {
      this.ticking = false;
    }
  }

  private async beatOnce(): Promise<void> {
    const epoch = this.epoch;
    const s = this.state.get();
    const spool = this.takeSpool();
    const body: Record<string, unknown> = {
      hostname: this.o.hostname, session_name: this.o.session, harness: this.o.harness, kind: 'vm',
      billing: {}, capabilities: this.o.capabilities ?? ['agent-venue'], tier_ceiling: this.o.tierCeiling ?? 'critical',
      lease_timeout_s: s.lease_timeout_s ?? 900,
      courses: this.o.courses.map((c) => ({ repository: this.o.repository, course: c.course, version: c.version })),
      ...((s.worker_id == null || this.rekeySecret) ? { secret_hash: await sha256Hex(this.rekeySecret ?? s.secret), ...(this.rekeySecret ? { rekey: true } : {}) } : {}),
      ...(this.fenceToReport != null ? { fenced: { claim_id: this.fenceToReport, terminated: true } } : {}),
      transcripts: spool.transcripts,
    };
    // §6.9: the spool's activity rows go up as their own call, before the beat; anything the
    // calls do not land comes back to the spool, so a leg session's record is never lost.
    const carry = [...spool.overflowTranscripts, ...spool.overflowActivities];
    if (carry.length) appendFileSync(this.state.spool, `${carry.map((t) => JSON.stringify(t)).join('\n')}\n`);
    let leftover: unknown[] = [...spool.overflowActivities];
    try {
      if (spool.activities.length) leftover = [...leftover, ...await this.postActivities(spool.activities)];
      if (this.pendingEnd) await this.retryEnd();
    } catch (e) {
      appendFileSync(this.state.spool, `${[...spool.transcripts, ...leftover].map((t) => JSON.stringify(t)).join('\n')}\n`);
      rmSync(spool.taken, { force: true }); // back in the spool; the taken copy is spent
      throw e;
    }
    let answer: Record<string, any>;
    try {
      answer = await this.o.api.heartbeat(body);
    } catch (e) {
      // The transcripts never landed: back to the spool for the next beat.
      appendFileSync(this.state.spool, `${[...spool.transcripts, ...leftover].map((t) => JSON.stringify(t)).join('\n')}\n`);
      void carry;
      rmSync(spool.taken, { force: true }); // back in the spool; the taken copy is spent
      if (e instanceof BatonRefusal && ['session-taken', 'worker-reaped', 'forbidden'].includes(e.code)) {
        // §6.3: a refused heartbeat marks the lease lost exactly as a missed timeout does; a
        // reaped worker re-keys on the beat after (R-BTN-14).
        if (e.code === 'worker-reaped') this.rekeySecret = freshSecret();
        this.loseLease(e.code);
        return;
      }
      throw e;
    }
    rmSync(spool.taken, { force: true });
    if (this.rekeySecret) {
      // The re-key landed: the new secret serves from here (R-BTN-14), and the new incarnation
      // starts on a fresh lease — the old flag fenced a claim the reap already took.
      this.state.set({ secret: this.rekeySecret, lease_lost: false, lease_lost_because: null });
      this.o.api.setSecret(this.rekeySecret);
      this.rekeySecret = null;
      this.lostLease = false;
    }
    if (epoch === this.epoch) {
      this.state.set({
        worker_id: answer.worker_id, incarnation: answer.incarnation, last_ok: this.now(),
        lease_timeout_s: answer.lease_timeout_s ?? s.lease_timeout_s,
        claim: answer.claim ? { id: answer.claim.id, ticket_id: answer.claim.ticket_id, nonce: answer.claim.nonce } : null,
      });
    } else {
      // A claim began while this beat was out: its claim view is stale — only the lease facts.
      this.state.set({
        worker_id: answer.worker_id, incarnation: answer.incarnation, last_ok: this.now(),
        lease_timeout_s: answer.lease_timeout_s ?? s.lease_timeout_s,
      });
    }
    // R-BTN-19: the fence of a claim this runner lost cleared with this beat.
    this.fenceToReport = null;
    const view = answer.claim && typeof answer.claim === 'object' ? answer.claim.git : null;
    // R-BTN-6 and §6.13: the wall clock's own verdict, or an answer that no longer lists the
    // claim, fence the runner at once — stop the leg, no hand-off.
    if (epoch !== this.epoch) {
      // A claim began while this beat was out: its answer speaks for the lease it was asked
      // about, never the one now held.
    } else if (!this.lostLease && (leaseLostFrom(this.state.get(), this.now()) || (this.inflight && answer.claim == null))) {
      this.loseLease('lease-timeout');
    }
    if (this.inflight) {
      if (view === 'unknown') this.signalLeg('course-changed', 'released:course-changed');
      else if (view && typeof view === 'object') {
        if (view.closed === 'done') this.closedDone = true;
        else if (view.regressed) this.signalLeg('regressed');
        const next = (view.next ?? null) as NextLegs | null;
        for (const w of this.inflight.waiters.splice(0)) w(next ?? []);
      }
    }
    for (const m of (answer.messages ?? []) as { id: number; kind: string; payload?: { reason?: string } }[]) {
      if (m.kind === 'release') {
        this.toAck.push(m.id);
        // A release message's payload reason is one of §6.5's own ('requested', 'owner-cancel',
        // 'provider-suspended') — it names the end directly. (A releasing owner bar arrives
        // the same way, as a release message — §11's heartbeat bars carry no release flag.)
        this.signalLeg('release', `released:${m.payload?.reason ?? 'requested'}`);
      } else if (m.kind === 'unblocked') {
        this.unblocked = true; // R-BTN-77: the idle wait ends with the next claim attempt
      }
    }
    if (!this.inflight) for (const id of this.toAck.splice(0)) await this.o.api.ack(id).catch(() => {});
  }

  /** An end whose failure is never fatal: claimed-ended is the answer we wanted anyway, and a
   * network failure parks the end for the beats to retry. */
  private async endQuietly(claimId: number, body: Record<string, unknown>): Promise<void> {
    // An end already parked for this claim keeps its own body — a re-end here must never
    // overwrite a done or suspended end the wire ate.
    if (this.pendingEnd?.claimId === claimId) return;
    try {
      await this.o.api.end(claimId, body);
    } catch (e) {
      if (e instanceof BatonRefusal && e.code === 'claim-ended') return;
      if (e instanceof BatonRefusal && (e.code === 'unavailable' || e.status >= 500)) {
        this.pendingEnd = { claimId, body };
        return;
      }
      if (e instanceof BatonRefusal) {
        this.log(`baton: the orphaned claim ${claimId} was refused (${e.message})`);
        return;
      }
      this.pendingEnd = { claimId, body };
    }
  }

  private loseLease(because: string): void {
    this.lostLease = true;
    this.state.set({ lease_lost: true, lease_lost_because: because });
    // R-BTN-19: the claim was taken away from this worker; the next heartbeat reports the fence
    // it cleared, so the ticket is re-issued instead of waiting for the worker to go silent.
    this.fenceToReport = this.inflight?.claimId ?? this.state.get().claim?.id ?? null;
    const child = this.inflight?.child;
    if (child) this.killGroup(child);
  }

  /** The pending signal as the loop reads it — through a call, so a field-narrowed null at one
   * check point never hides the signal a later tick recorded. */
  private abortSignal(): PendingAbort | null {
    return this.pendingAbort;
  }

  /** Ask the claim to stop at its next safe point (§6.13's `release`/`regressed` signals): the
   * signal is recorded whether or not a leg process is running — a release that lands in a
   * short wait or between legs is honoured just the same, never dropped. The claim-level end it
   * turns into is remembered for when the runner next settles. */
  private signalLeg(signal: PendingAbort['signal'], reason?: string): void {
    if (!this.inflight) return;
    // A release is the strongest signal: it overrides a regression or a course change that
    // landed first, so its message is never acknowledged away (§6.13, §9).
    if (this.pendingAbort && !(signal === 'release' && this.pendingAbort.signal !== 'release')) return;
    this.pendingAbort = { signal, reason };
    // The wire carries §6.13's closed reason set: a course change stops the leg the way a
    // release does — at its next safe point — so that is the signal it gets.
    const child = this.inflight.child;
    const wire = signal === 'course-changed' ? 'release' : signal;
    if (child?.process.stdin && !child.process.stdin.destroyed) child.process.stdin.write(`${JSON.stringify({ abort: wire })}\n`);
  }

  private killGroup(child: LegChild): void {
    try {
      if (child.process.pid) process.kill(-child.process.pid, 'SIGKILL');
    } catch {
      // The group is already gone — the leg ended before the lease did.
    }
  }

  /** Take the spool (§6.8, §6.9): RENAME it aside, so lines a leg session appends while this
   * beat is out wait in the fresh file rather than being truncated away, then split what was
   * there into transcript pointers and activity rows. Overflow beyond a call's bound carries to
   * the next beat; only what is neither shape is dropped, loudly. The renamed file lives until
   * the beat landed (the caller removes it), so nothing is lost to a dropped request. */
  private takeSpool(): { transcripts: unknown[]; overflowTranscripts: unknown[]; activities: unknown[]; overflowActivities: unknown[]; taken: string } {
    const taken = `${this.state.spool}.taken`;
    let text: string;
    try {
      renameSync(this.state.spool, taken);
      text = readFileSync(taken, 'utf8');
    } catch {
      return { transcripts: [], overflowTranscripts: [], activities: [], overflowActivities: [], taken };
    }
    const transcripts: unknown[] = [];
    const activities: unknown[] = [];
    for (const line of text.split('\n')) {
      if (!line) continue;
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        if ('repo' in parsed && 'path' in parsed) transcripts.push(parsed);
        else if ('id' in parsed && 'kind' in parsed) activities.push(parsed);
        else this.log(`baton: a spool line that is neither a transcript pointer nor an activity was dropped (${line.slice(0, 80)})`);
      } catch {
        this.log(`baton: a malformed spool line was dropped (${line.slice(0, 80)})`);
      }
    }
    // Both calls' bounds carry their overflow back to the spool — nothing is dropped silently.
    return { transcripts: transcripts.slice(-50), overflowTranscripts: transcripts.slice(0, -50), activities: activities.slice(0, 200), overflowActivities: activities.slice(200), taken };
  }

  /** §6.9: activity rows go up under their own call. Returns what must carry to the next beat —
   * a transport failure's whole batch; a refused row is the server's word and is only logged. */
  private async postActivities(activities: unknown[]): Promise<unknown[]> {
    try {
      const res = await this.o.api.activities(activities);
      for (const refused of (res.refused ?? []) as { id?: string; message?: string }[]) {
        this.log(`baton: an activity was refused (${refused.id ?? '?'}: ${refused.message ?? '?'})`);
      }
      return [];
    } catch (e) {
      this.log(`baton: the activities call failed (${msg(e)}) — kept for the next beat`);
      return activities;
    }
  }

  /** The end a dropped request never landed: retried on every beat until Baton answers (§6.5's
   * own resumable state — the claim is `in-review`'s sibling, ended in spirit, pending on the
   * wire). */
  private async retryEnd(): Promise<void> {
    const pending = this.pendingEnd;
    if (!pending) return;
    try {
      await this.o.api.end(pending.claimId, pending.body);
      this.pendingEnd = null;
    } catch (e) {
      if (e instanceof BatonRefusal && e.code === 'claim-ended') this.pendingEnd = null;
      else this.log(`baton: retrying the end Baton never answered (${msg(e)})`);
    }
  }

  // ── the loop ─────────────────────────────────────────────────────────────────────────────

  /** Claim and run tickets until `stop()`; a failure between claims is logged, never fatal.
   * Idle, the runner asks for recommendations when a heartbeat carried an `unblocked` message
   * (R-BTN-77) and otherwise at its own interval — each idle attempt asks first, then claims. */
  async work(): Promise<void> {
    this.start();
    while (!this.stopped) {
      try {
        const outcome = await this.runOnce();
        if (!outcome) await this.idleWait();
      } catch (e) {
        this.log(`baton: the loop failed (${msg(e)}) — retrying after a beat`);
        await this.idleWait();
      }
    }
  }

  /** The idle wait: a beat long, unless an `unblocked` message ends it early. */
  private async idleWait(): Promise<void> {
    const until = this.now() + this.o.beatEvery;
    while (!this.stopped && !this.unblocked && this.now() < until) await sleep(Math.min(50, this.o.beatEvery));
    this.unblocked = false;
  }

  /** One claim's whole run — or one idle attempt, returning null when nothing was claimable. */
  async runOnce(): Promise<ClaimOutcome | null> {
    // The worker must exist before it can claim (§5): one heartbeat registers it.
    if (this.state.get().worker_id == null) await this.tick();
    // A claim the state file still names with nothing in flight is an orphan — a restart, or an
    // end the network ate. It is ended (its resume record already says why) rather than held:
    // Baton would refuse every claim of this worker otherwise (rule 3, one claim per worker).
    const orphan = this.state.get().claim;
    if (orphan && !this.inflight) {
      this.log(`baton: ending the orphaned claim ${orphan.id} on ${orphan.ticket_id} before claiming`);
      this.state.set({ claim: null });
      await this.endQuietly(orphan.id, { end_reason: 'released:lease-lost', next: null });
    }
    // R-BTN-72: it recommends, then claims — the first recommendation is what a claim without
    // an id would take anyway, asked for here so the runner knows what it is going for.
    let wanted: string | undefined;
    try {
      const recs = await this.o.api.recommendations();
      wanted = (recs.recommendations ?? [])[0]?.ticket_id;
    } catch (e) {
      if (!(e instanceof BatonRefusal)) throw e;
      // A worker the gates refuse entirely still claims below: Baton's refusal is the answer.
      this.log(`baton: no recommendation (${e.message})`);
    }
    let claim: Record<string, any>;
    try {
      claim = await this.o.api.claim({ request_id: `run-${randomBytes(8).toString('hex')}`, ...(wanted ? { ticket_id: wanted } : {}) });
    } catch (e) {
      if (e instanceof BatonRefusal && e.code === 'no-eligible-ticket') return null;
      if (e instanceof BatonRefusal && e.code === 'not-eligible' && /already held|worker-holds/.test(e.message)) {
        // The worker still holds a claim Baton knows and this runner does not (its state was
        // lost with the container): the heartbeat's claim view named it, so end it loudly
        // rather than idling on the refusal forever.
        const held = this.state.get().claim;
        this.log(`baton: the claim was refused — this worker still holds ${held ? `claim ${held.id}` : 'a claim'} (${e.message})`);
        if (held) {
          this.state.set({ claim: null });
          await this.endQuietly(held.id, { end_reason: 'released:lease-lost', next: null });
        }
        return null;
      }
      if (e instanceof BatonRefusal && e.code === 'not-eligible') return null;
      throw e;
    }
    this.epoch++;
    const ticket = claim.ticket_id as string;
    const claimId = claim.claim_id as number;
    this.state.set({ claim: { id: claimId, ticket_id: ticket, nonce: claim.nonce } });
    this.log(`baton: claimed ${ticket} at ${claim.station}, queued leg ${claim.legs?.[0]}`);
    return this.runClaim(claim);
  }

  private async runClaim(claim: Record<string, any>): Promise<ClaimOutcome> {
    const claimId = claim.claim_id as number;
    const ticket = claim.ticket_id as string;
    let course: CourseLoad | null = null;
    try {
      // R-BTN-34: the snapshot must be in the home checkout — one fetch, else stale-board.
      if (!ensureSha(this.o.home, claim.snapshot_sha, () => this.o.fetch?.(this.o.home))) {
        return await this.finish(claimId, { end_reason: 'released:stale-board', reached: claim.station, ...(claim.legs?.[0] ? { next: claim.legs[0] } : {}) }, null);
      }
      course = loadCourse(this.o.home, claim.snapshot_sha, courseOf(this.o.home, claim.snapshot_sha));
    } catch (e) {
      this.log(`baton: the claim's course would not load (${msg(e)})`);
      return await this.finish(claimId, { end_reason: 'released:stale-board', reached: claim.station, ...(claim.legs?.[0] ? { next: claim.legs[0] } : {}) }, null);
    }
    const scratch = claimScratch();
    this.inflight = { claimId, ticket, course, child: null, waiters: [] };
    this.closedDone = false;
    // §2e/R-BTN-63: the legs git evidences are every earlier attempt's, flattened; the claim's
    // own legs are counted beside them when a leg's run number is taken.
    let gitPath = (claim.previous_attempts ?? []).flatMap((a: { legs?: { leg: string; reached: string | null }[] }) =>
      (a.legs ?? []).map((l) => ({ leg: l.leg, reached: l.reached ?? '' })));
    let handoffUrl = (claim.handoff_url ?? null) as string | null;
    let resume = (claim.previous_attempts?.[0]?.resume ?? null) as Record<string, any> | null;
    let advice = (claim.advice ?? null) as unknown;
    let session: string | null = null;
    const own: string[] = [];
    let ranScript: string | null = null;
    let ranCtx: Record<string, unknown> | null = null;
    // The first leg is the claim response's queued leg (R-BTN-83); the first advance starts it.
    let legName = (claim.legs?.[0] ?? null) as string | null;
    let at = claim.station as string;
    let nextLegs = (claim.next ?? []) as NextLegs;
    try {
      if (legName == null) return await this.finish(claimId, { end_reason: 'done', reached: at }, null);
      const firstAnswer = await this.advance(claimId, { leg: legName }, at);
      if ('settle' in firstAnswer) return await this.finish(claimId, firstAnswer.settle, null);
      at = firstAnswer.station ?? at;
      nextLegs = (firstAnswer.next ?? nextLegs) as NextLegs;
      advice = firstAnswer.advice ?? advice;
      for (;;) {
        // A signal that landed while no leg was running (a short wait, or the steps between
        // legs) ends the claim just the same — a release is never dropped (§6.13).
        const whileWaiting = this.abortSignal();
        if (whileWaiting) {
          const reason = whileWaiting.reason ?? `suspended:${at}`;
          return await this.finish(claimId, { end_reason: reason, reached: at, next: legName }, await this.callHandoff(ranScript, ranCtx ?? {}) ?? handoffUrl);
        }
        // §6.13: a leg the latest snapshot shows waiting suspends — unless its wait is one of the
        // course's short_waits, when the claim is kept and the station is re-read each beat for
        // up to 30 minutes (R-BTN-40). A signal that landed in the wait ends the claim as the
        // signal says, never as the suspension it interrupted.
        const wait = waitState(nextLegs, legName, course.graph.shortWaits);
        let held: 'cleared' | 'suspend' = wait === 'run' ? 'cleared' : 'suspend';
        if (wait === 'short') {
          const out = await this.waitOut(legName, course);
          if (out === 'abort') {
            const signal = this.abortSignal()!;
            const reason = signal.reason ?? `suspended:${at}`;
            return await this.finish(claimId, { end_reason: reason, reached: at, next: legName }, await this.callHandoff(ranScript, ranCtx ?? {}) ?? handoffUrl);
          }
          if (out === 'lost') {
            // The lease went while the wait held it: stop at once, no hand-off (R-BTN-24).
            return await this.finish(claimId, { end_reason: 'released:lease-lost', reached: at, next: legName }, null);
          }
          held = out === 'cleared' ? 'cleared' : 'suspend';
        }
        if (held === 'suspend') {
          // §6.13: the hand-off of the leg that ran comes before the suspension (R-BTN-44).
          const url = await this.callHandoff(ranScript, ranCtx ?? {}) ?? handoffUrl;
          return await this.finish(claimId, { end_reason: `suspended:${at}`, reached: at, next: legName }, url);
        }
        if (this.closedDone) return await this.finish(claimId, { end_reason: 'done', reached: at }, handoffUrl);
        const run = runNumber(course.graph, gitPath, legName, own);
        own.push(legName);
        const ctx = {
          ticket: { id: ticket, path: claim.path ?? null, home: this.o.repository },
          claim: { id: claimId, nonce: claim.nonce, station: at },
          leg: legName, run,
          snapshot: { sha: claim.snapshot_sha, path: gitPath, next: nextLegs },
          handoff: handoffUrl, resume, advice,
          checkout: this.o.home, session,
          state: this.o.stateFile, worker: this.state.get().worker_id,
        };
        const outcome = await this.runLeg(course, legName, ctx, scratch);
        const script = course.scripts.get(legName) ?? null;
        if (outcome.kind !== 'lease-lost' && outcome.kind !== 'missing') {
          ranScript = script;
          ranCtx = ctx;
        }
        if (outcome.kind === 'lease-lost') {
          // The group is dead; no close, no hand-off (R-BTN-24's resume record covers the leg).
          return await this.finish(claimId, { end_reason: 'released:lease-lost', reached: at, next: legName }, null);
        }
        if (outcome.kind === 'missing') {
          this.log(`baton: the snapshot has no legs/${legName}.mjs — a script bug the test kit owns (§2d)`);
          return await this.finish(claimId, { end_reason: 'released:cannot-finish:transient', reached: at, next: legName }, null);
        }
        // A sidecar signal that landed mid-leg decides the end, whatever the script then says —
        // the leg stops at its next safe point (§6.13). A release may name the outcome the
        // finished leg reached, validated and closed like any result (R-BTN-83: a position not
        // in git is not reported); a regression rests at the leg's `from` whatever it said.
        const abort = this.abortSignal();
        if (abort) {
          let reached = at;
          let next: string | null = legName; // a give-up queues the leg itself (R-BTN-83)
          let closed: string | null | undefined = null;
          if (abort.signal === 'release' && outcome.kind === 'ok') {
            const verdict = decide(outcome.result, course.graph, legName, at);
            if (!('bug' in verdict)) closed = await this.callClose(script, ctx, outcome.result);
            if (closed != null && !('bug' in verdict)) {
              reached = verdict.reached;
              // A leg that finished queues a leg leaving where it rests — the script's own word
              // when it named one, nothing at an end station (R-BTN-83).
              next = verdict.kind === 'advance' ? verdict.leg : verdict.kind === 'done' ? null : verdict.next;
            }
          }
          const reason = abort.reason ?? `suspended:${at}`;
          // A released end points at no evidence (§6.5); the marker close wrote is in git.
          return await this.finish(claimId, { end_reason: reason, reached, ...(next != null ? { next } : {}) }, await this.callHandoff(script, ctx));
        }
        if (outcome.kind === 'crashed') {
          this.log(`baton: ${ticket}'s ${legName} failed (${outcome.error})`);
          return await this.finish(claimId, { end_reason: 'released:cannot-finish:transient', reached: at, next: legName }, await this.callHandoff(script, ctx));
        }
        const result = outcome.result;
        session = typeof (result as { session?: unknown } | null)?.session === 'string'
          ? (result as { session: string }).session : session;
        const verdict = decide(result, course.graph, legName, at);
        if ('bug' in verdict) {
          this.log(`baton: ${ticket}'s ${legName} script bug: ${verdict.why}`);
          return await this.finish(claimId, { end_reason: `suspended:${verdict.reached}`, reached: verdict.reached, next: verdict.next }, await this.callHandoff(script, ctx, verdict.why));
        }
        // R-BTN-83: `close` writes the closing marker from the validated result before anything
        // is reported; a suspension or release follows with `handoff`, so it can cite the position.
        const closed = await this.callClose(script, ctx, result);
        if (closed === undefined) {
          return await this.finish(claimId, { end_reason: 'released:cannot-finish:transient', reached: at, next: legName }, await this.callHandoff(script, ctx));
        }
        if (verdict.kind === 'done') {
          // A done end carries no hand-off (R-BTN-44 writes one for suspensions and releases);
          // the closing marker and the resume record are its record.
          return await this.finish(claimId, { end_reason: 'done', reached: verdict.reached, ...(verdict.detail ? { detail: verdict.detail } : {}), ...(closed ? { ended_at_sha: closed } : {}) }, null);
        }
        if (verdict.kind === 'suspend' || verdict.kind === 'release') {
          const reason = verdict.kind === 'suspend' ? `suspended:${verdict.reached}` : `released:${verdict.reason}`;
          // §6.5: only a completed end points at its evidence — a released end carries none.
          return await this.finish(claimId, { end_reason: reason, reached: verdict.reached, next: verdict.next, ...(verdict.kind === 'suspend' && closed ? { ended_at_sha: closed } : {}) }, await this.callHandoff(script, ctx));
        }
        // The go-on decision: the advance carries the result's bars on the edge (R-BTN-63) and
        // the evidence `close` wrote; it finishes this leg and starts the next. The finished leg
        // joins the evidenced path only now — the next leg's run number counts what ran.
        const answer = await this.advance(claimId, { reached: verdict.reached, leg: verdict.leg, bars: verdict.bars, ...(closed ? { evidence: closed } : {}) }, verdict.reached);
        if ('settle' in answer) return await this.finish(claimId, answer.settle, await this.callHandoff(script, ctx) ?? handoffUrl);
        gitPath = [...gitPath, { leg: legName, reached: verdict.reached }];
        at = answer.station ?? verdict.reached;
        nextLegs = (answer.next ?? nextLegs) as NextLegs;
        advice = answer.advice ?? advice;
        legName = verdict.leg;
        handoffUrl = null;
        resume = null;
      }
    } finally {
      for (const w of this.inflight?.waiters.splice(0) ?? []) w([]);
      this.inflight = null;
      this.pendingAbort = null;
      dropCourse(course!.scratch);
      rmSync(scratch, { recursive: true, force: true });
    }
  }

  /** One `advance`, its refusal settled by §6.13: off-graph ends `released:course-changed`;
   * every other refusal suspends at the station the claim reached, never releasing. */
  private async advance(claimId: number, body: { leg: string; reached?: string; bars?: string[]; evidence?: string }, fallbackStation: string): Promise<{ station?: string; next?: NextLegs; advice?: unknown } | { settle: Record<string, unknown> }> {
    try {
      return await this.o.api.advance(claimId, body) as { station?: string; next?: NextLegs; advice?: unknown };
    } catch (e) {
      if (!(e instanceof BatonRefusal)) throw e;
      if (refusalKind(e.ruleCode) === 'course-changed') {
        return { settle: { end_reason: 'released:course-changed', reached: body.reached ?? fallbackStation, ...(body.leg ? { next: body.leg } : {}) } };
      }
      return { settle: { end_reason: `suspended:${body.reached ?? fallbackStation}`, reached: body.reached ?? fallbackStation, next: body.leg } };
    }
  }

  /** Hold a short wait (R-BTN-40): each beat re-reads the snapshot's legs; 30 minutes spends it.
   * A beat that brought no reading (the fallback timeout) settles nothing — only the clock — and
   * a signal that landed while no leg ran aborts the wait, honoured by the caller. */
  private async waitOut(leg: string, course: CourseLoad): Promise<'cleared' | 'spent' | 'abort' | 'lost'> {
    const waitedSince = this.now();
    for (;;) {
      if (this.lostLease || leaseLostFrom(this.state.get(), this.now())) return 'lost';
      if (this.pendingAbort) return 'abort';
      const shown = await new Promise<NextLegs | null>((resolve) => {
        if (!this.inflight) return resolve(null);
        this.inflight.waiters.push((n) => resolve(n));
        setTimeout(() => resolve(null), this.o.beatEvery).unref?.();
      });
      if (shown == null) {
        if (shortWaitSpent(waitedSince, this.now())) return 'spent';
        continue;
      }
      const state = waitState(shown, leg, course.graph.shortWaits);
      if (state === 'run') return 'cleared';
      if (state === 'suspend' || shortWaitSpent(waitedSince, this.now())) return 'spent';
    }
  }

  private async runLeg(course: CourseLoad, leg: string, ctx: Record<string, unknown>, scratch: string): Promise<{ kind: 'ok'; result: unknown } | { kind: 'crashed'; error: string } | { kind: 'missing' } | { kind: 'lease-lost' }> {
    const script = course.scripts.get(leg);
    if (script == null) return { kind: 'missing' };
    const tag = randomBytes(4).toString('hex');
    const ctxPath = join(scratch, `ctx-${leg}-${tag}.json`);
    const resultPath = join(scratch, `result-${leg}-${tag}.json`);
    writeFileSync(ctxPath, JSON.stringify(ctx));
    // Detached: its own process group, so a lost lease kills the leg and everything it started
    // (§6.13) without touching the runner. The env names the parent every leg session checks
    // (IR_BATON_PARENT — such a session never claims; IR_BATON_STATE — the fence and the spool).
    const child = spawn(process.execPath, [LEG_PROCESS, script, ctxPath, resultPath], {
      detached: true, stdio: ['pipe', 'ignore', 'ignore'],
      env: { ...process.env, IR_BATON_PARENT: String(this.state.get().worker_id ?? ''), IR_BATON_STATE: this.o.stateFile },
    });
    const inflight = this.inflight!;
    inflight.child = { process: child, resultPath, ctxPath };
    let done = false;
    const exited = new Promise<void>((resolve) => child.on('exit', () => {
      done = true;
      resolve();
    }));
    const lost = new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        // R-BTN-26: the fence computes the lease itself from the state file — the wall clock
        // against `last_ok` — never trusting only the sidecar's flag.
        if (leaseLostFrom(this.state.get(), this.now()) || this.lostLease || this.stopped) {
          clearInterval(timer);
          resolve();
        }
      }, Math.min(200, this.o.beatEvery));
      timer.unref?.();
      void exited.then(() => clearInterval(timer));
    });
    await Promise.race([exited, lost]);
    if (!done || this.lostLease) {
      // The lease went (or the runner stops): kill the leg's whole group at once, no hand-off —
      // the resume record covers it (R-BTN-24).
      this.killGroup(inflight.child);
      return { kind: 'lease-lost' };
    }
    inflight.child = null;
    try {
      const out = JSON.parse(readFileSync(resultPath, 'utf8')) as { ok: boolean; result?: unknown; error?: string };
      return out.ok ? { kind: 'ok', result: out.result } : { kind: 'crashed', error: out.error ?? 'the leg script failed' };
    } catch {
      return { kind: 'crashed', error: 'the leg wrote no result' };
    }
  }

  /** `close(ctx, result)`: the closing marker from the validated result (R-BTN-83), retried
   * twice; when it cannot write, nothing is reported for the leg (§6.13) — `undefined`.
   * §6.13's default-export shape and the named-export shape both serve. */
  private async callClose(script: string | null, ctx: Record<string, unknown>, result: unknown): Promise<string | null | undefined> {
    if (script == null) return null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const mod = (await import(`${pathToFileURL(script).href}?close=${randomBytes(4).toString('hex')}`)) as { close?: (ctx: unknown, result: unknown) => unknown; default?: { close?: (ctx: unknown, result: unknown) => unknown } };
        const close = mod.close ?? mod.default?.close;
        if (typeof close !== 'function') throw new Error('the script exports no close(ctx, result)');
        const ref = await close(ctx, result);
        return typeof ref === 'string' ? ref : null;
      } catch (e) {
        this.log(`baton: the leg's close failed (${msg(e)}), attempt ${attempt + 1} of 3`);
      }
    }
    return undefined;
  }

  /** `handoff(ctx)` (R-BTN-44): before any suspension or release; its failure is logged and the
   * resume record covers the rest. */
  private async callHandoff(script: string | null, ctx: Record<string, unknown>, why?: string): Promise<string | null> {
    if (script == null) return null;
    try {
      const mod = (await import(`${pathToFileURL(script).href}?handoff=${randomBytes(4).toString('hex')}`)) as { handoff?: (ctx: unknown) => unknown; default?: { handoff?: (ctx: unknown) => unknown } };
      const handoff = mod.handoff ?? mod.default?.handoff;
      if (typeof handoff !== 'function') throw new Error('the script exports no handoff(ctx)');
      const url = await handoff(why != null ? { ...ctx, bug: why } : ctx);
      return typeof url === 'string' ? url : null;
    } catch (e) {
      this.log(`baton: the leg's handoff failed (${msg(e)}) — the resume record covers it (R-BTN-24)`);
      return null;
    }
  }

  /** End the claim, clear the local claim state, and ack what the sidecar delivered. The local
   * flags clear whatever the wire said — a lost lease belongs to the claim that lost it — and an
   * end the network ate is parked and retried on every beat until Baton answers. */
  private async finish(claimId: number, body: Record<string, unknown>, handoff: string | null): Promise<ClaimOutcome> {
    const ticket = this.state.get().claim?.ticket_id ?? this.inflight?.ticket ?? '';
    try {
      await this.o.api.end(claimId, body);
    } catch (e) {
      if (e instanceof BatonRefusal && e.code === 'claim-ended') {
        // Baton already ended it (a stale-board release under a sync, §6.5) — its end stands.
        this.log(`baton: ${ticket} was already ended (${e.message})`);
      } else if (e instanceof BatonRefusal && (e.code === 'unavailable' || e.status >= 500)) {
        // A 5xx is a Baton that could not answer, not one that refused: park it like a
        // transport failure, or the orphan path would re-end the claim with another reason.
        this.log(`baton: the end of ${ticket} did not reach Baton (${e.message}) — retried on every beat`);
        this.pendingEnd = { claimId, body };
      } else if (e instanceof BatonRefusal) {
        throw e;
      } else {
        this.log(`baton: the end of ${ticket} did not reach Baton (${msg(e)}) — retried on every beat`);
        this.pendingEnd = { claimId, body };
      }
    }
    for (const id of this.toAck.splice(0)) await this.o.api.ack(id).catch(() => {});
    this.state.set({ claim: null });
    // The lost lease belonged to that claim (R-BTN-6): a fresh claim starts on a fresh lease,
    // so the flag never outlives the claim it fenced — cleared here, not only on success.
    this.lostLease = false;
    this.state.set({ lease_lost: false, lease_lost_because: null });
    this.closedDone = false;
    this.log(`baton: ${ticket} ${body.end_reason} at ${body.reached ?? '?'}`);
    return { ticket, end_reason: body.end_reason as string, reached: (body.reached as string) ?? null, handoff };
  }
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function sha256Hex(text: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
