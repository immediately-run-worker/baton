// api.ts — the runner's client of Baton's runner API (BATON_SPEC §11, §6.3 R-BTN-13 as amended):
// every call signed with the machine's SSH key (ssh-keygen -Y sign, the one verifier shape), or
// — through R3-1239's transition — a bearer token, and after the first heartbeat the worker
// secret. A call Baton refuses comes back as a `BatonRefusal` (never thrown past the loop); a
// call that cannot reach Baton throws.
import { signHeaders, signingKey } from '../../cli/sign.mjs';

/** §6.3: every heartbeat request — and every call a fence depends on — has a 30-second timeout. */
export const CALL_TIMEOUT_MS = 30_000;

/** A refusal Baton answered: its `code`, `rule_code` when the §11 body carries one, and message. */
export class BatonRefusal extends Error {
  constructor(readonly code: string, readonly ruleCode: string | undefined, message: string, readonly status: number) {
    super(message);
  }
}

export type Transport = (req: Request) => Promise<Response>;

/** The headers that authenticate one request: the SSHSIG signature, or the transition's bearer
 * token, and the worker secret once the first heartbeat returned it. */
export type Auth = (method: string, url: string, body: string, secret: string | null) => Record<string, string>;

export interface ApiOptions {
  url: string;
  transport: Transport;
  auth: Auth;
}

// The SSHSIG signing itself is cli/sign.mjs's (the one `baton admin` uses — the same verifier
// shape docs' batonSign.mjs implements); imported, never copied.

/** The auth a production runner uses: the machine's key (`IR_BATON_KEY_FILE`, or `IR_BATON_KEY`,
 * a cloud environment's secret this run's caller materialises through `keyWriter`), else the
 * transition's `IR_BATON_TOKEN`. A runner with none cannot talk to Baton (§6.4). */
export function envAuth(env: NodeJS.ProcessEnv, keyWriter?: (material: string) => string): Auth {
  const keyFile = env.IR_BATON_KEY_FILE || (env.IR_BATON_KEY && keyWriter ? keyWriter(env.IR_BATON_KEY) : null);
  if (keyFile) {
    return (method, url, body, secret) => {
      const signed = signHeaders({ method, url, body: body ?? '', key: signingKey(keyFile) });
      return { ...signed, ...(secret ? { 'X-Worker-Secret': secret } : {}) };
    };
  }
  if (env.IR_BATON_TOKEN) {
    return (_method, _url, _body, secret) => ({ Authorization: `Bearer ${env.IR_BATON_TOKEN}`, ...(secret ? { 'X-Worker-Secret': secret } : {}) });
  }
  throw new Error('no credential: IR_BATON_KEY_FILE, IR_BATON_KEY or IR_BATON_TOKEN (§6.4, R-BTN-13)');
}

/** The runner's calls; one instance per runner. `secret` joins every call once the first
 * heartbeat returned it (R-BTN-14: the hash registers, the secret authenticates). */
export class BatonApi {
  private secret: string | null = null;
  constructor(private readonly o: ApiOptions, private readonly log: (line: string) => void = () => {}) {}

  setSecret(s: string | null) {
    this.secret = s;
  }

  private async call(method: string, path: string, body?: unknown): Promise<Record<string, any>> {
    const url = new URL(path, this.o.url).toString();
    const text = body === undefined ? '' : JSON.stringify(body);
    const headers = new Headers(this.o.auth(method, url, text, this.secret));
    headers.set('Content-Type', 'application/json');
    let res: Response;
    try {
      res = await this.o.transport(new Request(url, { method, headers, body: text === '' && method === 'GET' ? undefined : text, signal: AbortSignal.timeout(CALL_TIMEOUT_MS) }));
    } catch (e) {
      this.log(`baton: ${method} ${path} did not reach Baton (${e instanceof Error ? e.message : String(e)})`);
      throw e;
    }
    let json: Record<string, any> | null = null;
    try {
      json = (await res.json()) as Record<string, any>;
    } catch {
      json = null;
    }
    if (!res.ok) {
      const code = typeof json?.code === 'string' ? json.code : 'unavailable';
      throw new BatonRefusal(code, typeof json?.rule_code === 'string' ? json.rule_code : undefined,
        typeof json?.message === 'string' ? json.message : `${method} ${path}: ${res.status}`, res.status);
    }
    return json ?? {};
  }

  heartbeat(body: Record<string, unknown>): Promise<Record<string, any>> {
    return this.call('POST', '/v1/runner/heartbeat', body);
  }
  /** §11: the sorted legs this worker may take — what an idle runner asks for (R-BTN-45). */
  recommendations(limit = 10): Promise<Record<string, any>> {
    return this.call('GET', `/v1/runner/recommendations?limit=${limit}`);
  }
  /** §6.9: activity rows from the spool, upserted under their own call. */
  activities(activities: unknown[]): Promise<Record<string, any>> {
    return this.call('POST', '/v1/runner/activities', { activities });
  }
  claim(body: { request_id: string; ticket_id?: string }): Promise<Record<string, any>> {
    return this.call('POST', '/v1/runner/claim', body);
  }
  advance(claimId: number, body: { reached?: string; leg: string; bars?: string[]; evidence?: string }): Promise<Record<string, any>> {
    return this.call('POST', `/v1/runner/claims/${claimId}/advance`, body);
  }
  end(claimId: number, body: Record<string, unknown>): Promise<Record<string, any>> {
    return this.call('POST', `/v1/runner/claims/${claimId}/end`, body);
  }
  ack(messageId: number): Promise<Record<string, any>> {
    return this.call('POST', `/v1/runner/messages/${messageId}/ack`, {});
  }
}
