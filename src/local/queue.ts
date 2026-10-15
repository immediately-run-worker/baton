// queue.ts — the local host's only concurrency control (BATON_SPEC §3, §3a R-BTN-55). Every
// request, alarm tick and start-up runs through it, one at a time, as the Durable Object's
// input gate runs them. The holder lets another in only through `outside` — the Gate port,
// for the two awaits §3 names: a request's signature check (R3-1239 moves it inside the core)
// and a hook call (R3-1236). Today the front verifies its JWTs before a request queues, and
// nothing calls `outside` yet.
import { AsyncLocalStorage } from 'node:async_hooks';

/** One `run`'s hold on the queue. */
interface Turn {
  release: (() => void) | null;
  /** `outside` calls now awaiting, and the re-acquire the first one back started. */
  away: number;
  back: Promise<void> | null;
  /** The `run` has settled: an `outside` that returns after it takes no slot. */
  done: boolean;
}

export class RequestQueue {
  private tail: Promise<void> = Promise.resolve();
  private readonly holder = new AsyncLocalStorage<Turn>();

  /** Wait for the queue, then hold it until `fn` settles. */
  async run<T>(fn: () => Promise<T> | T): Promise<T> {
    const turn: Turn = { release: null, away: 0, back: null, done: false };
    await this.acquire(turn);
    try {
      return await this.holder.run(turn, fn);
    } finally {
      // An `outside` still awaiting when `fn` settled takes no slot when it returns; a
      // re-acquire already started is released as soon as it lands.
      turn.done = true;
      if (turn.back) await turn.back;
      turn.release?.();
      turn.release = null;
    }
  }

  /**
   * Await `work` with the queue released, then wait for it again. Only the holder may call
   * it: from anywhere else it throws, so it can never let a second request run beside the
   * holder. Overlapping calls by one holder (two hook calls under `Promise.all`) release
   * once and re-acquire once.
   */
  async outside<T>(work: () => Promise<T>): Promise<T> {
    const turn = this.holder.getStore();
    if (!turn || turn.done || (!turn.release && turn.away === 0)) throw new Error('outside(): the caller does not hold the queue');
    if (turn.away++ === 0 && turn.release) {
      turn.release();
      turn.release = null;
      turn.back = null;
    }
    try {
      return await work();
    } finally {
      if (!turn.done) {
        turn.back ??= this.acquire(turn);
        await turn.back;
      }
      if (--turn.away === 0) turn.back = null;
    }
  }

  private acquire(turn: Turn): Promise<void> {
    let release!: () => void;
    const mine = new Promise<void>((r) => (release = r));
    const before = this.tail;
    this.tail = before.then(() => mine);
    return before.then(() => {
      turn.release = release;
    });
  }
}
