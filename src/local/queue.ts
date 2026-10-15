// queue.ts — the local host's only concurrency control (BATON_SPEC §3, §3a R-BTN-55). Every
// request, alarm tick and dispatch flush runs through it, one at a time, as the Durable
// Object's input gate runs them; the holder lets another in only through `outside`, at the
// two awaits §3 names (a signature check, a hook call), so requests interleave at the same
// points on both hosts.

export class RequestQueue {
  private tail: Promise<void> = Promise.resolve();
  /** The current holder's release; null while nobody holds the queue. */
  private release: (() => void) | null = null;

  /** Wait for the queue, then hold it until `fn` settles. */
  async run<T>(fn: () => Promise<T> | T): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.let();
    }
  }

  /** Called by the holder: await `work` with the queue released, then queue again for it. */
  async outside<T>(work: () => Promise<T>): Promise<T> {
    this.let();
    try {
      return await work();
    } finally {
      await this.acquire();
    }
  }

  private acquire(): Promise<void> {
    let release!: () => void;
    const mine = new Promise<void>((r) => (release = r));
    const before = this.tail;
    this.tail = before.then(() => mine);
    return before.then(() => {
      this.release = release;
    });
  }

  private let() {
    const r = this.release;
    this.release = null;
    r?.();
  }
}
