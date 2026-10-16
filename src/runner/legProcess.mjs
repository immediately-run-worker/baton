#!/usr/bin/env node
// legProcess.mjs — one leg script's process (BATON_SPEC §6.13 R-BTN-72). The runner spawns this
// wrapper detached, in its own process group, for every leg it runs, so a lost lease can kill the
// leg and everything it started at once (the runner never kills its own group). The wrapper:
//
//   node legProcess.mjs <script.mjs> <ctx.json> <result.json>
//
// reads the serialisable half of `ctx`, imports the leg script fresh (a new process, so a course
// change between claims needs no restart — the runner extracts the snapshot's file per claim),
// calls its `run(ctx)` with an AbortSignal the parent fires over stdin
// (`{"abort":"release"|"regressed"}` — `lease-lost` is a SIGKILL, not a message), and writes
// `{ok: true, result} | {ok: false, error, aborted}` to the result file. `handoff` and `close`
// run in the runner's process — they are quick git writes — so nothing here reads them.
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const [, , script, ctxPath, resultPath] = process.argv;
const write = (out) => writeFileSync(resultPath, JSON.stringify(out));
const ctx = JSON.parse(readFileSync(ctxPath, 'utf8'));

const stop = new AbortController();
// The parent's abort reasons arrive a line at a time; a partial line waits for its rest.
let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let at;
  while ((at = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, at);
    buffer = buffer.slice(at + 1);
    if (!line.trim()) continue;
    try {
      const { abort } = JSON.parse(line);
      if (abort) stop.abort(abort);
    } catch {
      // A malformed line is dropped loudly on stderr, never fatal: the leg keeps its lease
      // semantics from the parent's real signals.
      process.stderr.write(`legProcess: ignoring a malformed abort line: ${line}\n`);
    }
  }
});
process.stdin.on('error', () => {}); // the parent may close stdin when it kills us

try {
  const mod = await import(pathToFileURL(script).href);
  // §6.13: a script default-exports run(ctx) — a named export serves the fixtures the same.
  const run = mod.run ?? (mod.default != null && typeof mod.default === 'object' ? mod.default.run : undefined) ?? (typeof mod.default === 'function' ? mod.default : undefined);
  if (typeof run !== 'function') throw new Error('the leg script exports no run(ctx)');
  const result = await run({ ...ctx, signal: stop.signal });
  write({ ok: true, result: result === undefined ? null : result });
  process.exit(0);
} catch (e) {
  write({ ok: false, error: e instanceof Error ? e.message : String(e), aborted: stop.signal.reason === undefined ? null : String(stop.signal.reason) });
  process.exit(stop.signal.reason === undefined ? 4 : 5);
}
