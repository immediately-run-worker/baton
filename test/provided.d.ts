// What test/global-setup.ts provides to the Workers-side tests (vitest `inject`).
import 'vitest';

declare module 'vitest' {
  export interface ProvidedContext {
    board: {
      shas: Record<'A' | 'B' | 'C' | 'D', string>;
      states: Record<'A' | 'B' | 'C' | 'D', { state: { items: unknown[] }; ready: string[]; [k: string]: unknown }>;
      ancestry: Record<string, boolean>;
    };
    shared: { manifest: Record<string, string>; vendored: Record<string, string>; upstream: Record<string, string> | null };
    wranglerToml: string;
    liveBoard: Record<string, unknown> | null;
  }
}
