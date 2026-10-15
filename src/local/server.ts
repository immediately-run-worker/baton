// server.ts — the local host's HTTP (BATON_SPEC §3a R-BTN-55): `node:http` serving the same
// routes as the Worker. A request's body is read whole before it queues, so a holder never
// waits on another client's upload.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { LocalHost } from './host';

const MAX_BODY = 8 * 1024 * 1024;

async function toRequest(req: IncomingMessage, origin: string): Promise<Request> {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v == null) continue;
    for (const one of Array.isArray(v) ? v : [v]) headers.append(k, one);
  }
  const method = req.method ?? 'GET';
  let body: ArrayBuffer | undefined;
  if (method !== 'GET' && method !== 'HEAD') {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > MAX_BODY) throw new Error('body too large');
      chunks.push(c as Buffer);
    }
    const all = Buffer.concat(chunks);
    body = all.buffer.slice(all.byteOffset, all.byteOffset + all.byteLength) as ArrayBuffer;
  }
  return new Request(new URL(req.url ?? '/', origin), { method, headers, body });
}

async function send(res: ServerResponse, out: Response) {
  const headers: Record<string, string[]> = {};
  out.headers.forEach((v, k) => {
    (headers[k] ??= []).push(v);
  });
  res.writeHead(out.status, headers);
  res.end(Buffer.from(await out.arrayBuffer()));
}

/** Serve `host` at `origin` (the instance's own, R-BTN-56). */
export function serve(host: LocalHost, origin: string): Server {
  return createServer((req, res) => {
    toRequest(req, origin)
      .then((r) => host.handle(r))
      .then((out) => send(res, out))
      .catch(() => {
        if (!res.headersSent) res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, code: 'invalid-params', message: 'the request could not be read' }));
      });
  });
}
