// registry.ts — the registered repositories (BATON_SPEC §2a R-BTN-47, R-BTN-15, R-BTN-66).
// Only the instance administrator registers or retires one (R-BTN-57; `POST /v1/admin/
// repositories`, R3-1240). Until that route lands, the deployment seeds them from
// BATON_REPOSITORIES through the same validated `register`, insert-only: a seed never changes a
// repository Baton already knows. The sync principal is bound to one repository here.
import { BatonError } from './http';
import type { Config, Store } from './ports';
import { GIT_REPO, REPOSITORY_ID } from './validate';

export { REPOSITORY_ID, TICKET_ID, qualify, repositoryOf, localOf } from './validate';

const GITHUB = GIT_REPO;
const BRANCH = /^(?!.*\.\.)[A-Za-z0-9._/-]{1,100}$/;
const WORKFLOW = /^\.github\/workflows\/[A-Za-z0-9._-]{1,100}\.ya?ml$/;
const TIER = /^[a-z][a-z0-9-]{0,39}$/;
const DEFAULT_TIERS = ['routine', 'judgement', 'critical'];

export interface Repository {
  id: string;
  github: string;
  default_branch: string;
  sync_workflow: string;
  mirror_workflow: string | null;
  weight: number;
  transcript_repos: string[];
  tiers: string[];
  cutover_at: number | null;
  retired_at: number | null;
}

/** A registration as `POST /v1/admin/repositories` takes it (§11), less the owner keys
 *  (R3-1240), checked before anything is written (§10.4). */
export interface Registration {
  id: string;
  github: string;
  default_branch: string;
  sync_workflow: string;
  mirror_workflow: string | null;
  weight: number;
  tiers: string[];
  transcript_repos: string[];
  cut_over: boolean;
}

const bad = (field: string, why: string): never => {
  throw new BatonError('invalid-params', `${field}: ${why}`);
};

export function checkRegistration(v: unknown, at = 'repository'): Registration {
  if (!v || typeof v !== 'object' || Array.isArray(v)) bad(at, 'must be an object');
  const r = v as Record<string, unknown>;
  const known = new Set(['id', 'github', 'default_branch', 'sync_workflow', 'mirror_workflow', 'weight', 'tiers', 'transcript_repos', 'cut_over']);
  for (const k of Object.keys(r)) if (!known.has(k)) bad(`${at}.${k}`, 'unknown field');
  const str = (k: string, re: RegExp) => (typeof r[k] === 'string' && re.test(r[k] as string) ? (r[k] as string) : bad(`${at}.${k}`, `must match ${re}`));
  const tiers = r.tiers === undefined ? DEFAULT_TIERS
    : Array.isArray(r.tiers) && r.tiers.length >= 1 && r.tiers.length <= 16 && r.tiers.every((t) => typeof t === 'string' && TIER.test(t)) && new Set(r.tiers).size === r.tiers.length
      ? (r.tiers as string[]) : bad(`${at}.tiers`, 'must be 1–16 distinct tier names, lowest first');
  const transcript = r.transcript_repos === undefined ? []
    : Array.isArray(r.transcript_repos) && r.transcript_repos.length <= 20 && r.transcript_repos.every((x) => typeof x === 'string' && GITHUB.test(x))
      ? (r.transcript_repos as string[]) : bad(`${at}.transcript_repos`, 'must be at most 20 owner/name repositories');
  const weight = r.weight === undefined ? 100
    : Number.isInteger(r.weight) && (r.weight as number) >= 0 && (r.weight as number) <= 10_000 ? (r.weight as number) : bad(`${at}.weight`, 'must be an integer from 0 to 10000');
  if (r.cut_over !== undefined && typeof r.cut_over !== 'boolean') bad(`${at}.cut_over`, 'must be true or false');
  return {
    id: str('id', REPOSITORY_ID),
    github: str('github', GITHUB),
    default_branch: str('default_branch', BRANCH),
    sync_workflow: str('sync_workflow', WORKFLOW),
    mirror_workflow: r.mirror_workflow == null ? null : str('mirror_workflow', WORKFLOW),
    weight,
    tiers,
    transcript_repos: transcript,
    cut_over: r.cut_over === true,
  };
}

/** §6.8: the transcript repositories, for a repository that has named none yet. */
export const DEFAULT_TRANSCRIPT_REPOS = ['immediately-run/claude-sessions', 'immediately-run-worker/session-transcripts'];

/** §6.8: one repository's transcript repositories, or the defaults while it names none. */
export function transcriptReposOf(store: Store, repo: string): string[] {
  const raw = store.exec<{ transcript_repos: string }>('SELECT transcript_repos FROM repositories WHERE id = ?', repo).toArray()[0]?.transcript_repos;
  const list = raw ? (JSON.parse(raw) as string[]) : [];
  return list.length ? list : DEFAULT_TRANSCRIPT_REPOS;
}

/** A worker's ceiling in one repository's ladder (§7.2 rule 5, R-BTN-66): the one it declared
 *  for that repository; else its single `tier_ceiling` where the ladder has that name; else the
 *  ladder's top if that ceiling is the unrestricted default (`critical`, docs' top), and the
 *  ladder's bottom otherwise — a restricted worker is never widened by a ladder it did not name.
 *  An interim until grants' `max_tier` (R3-1240) caps it. */
export function ceilingIn(repo: string, ladder: string[], ceilings: Record<string, string>, legacy: string): string {
  const named = ceilings[repo];
  if (named && ladder.includes(named)) return named;
  if (ladder.includes(legacy)) return legacy;
  return legacy === 'critical' ? ladder[ladder.length - 1] : ladder[0];
}

/** A ticket tier's position in its repository's ladder: null untiered (fits only the top); a name
 *  the ladder lacks is the ladder's length, which fits nothing. */
export const tierPosition = (ladder: string[], tier: string | null) =>
  tier == null ? null : ladder.includes(tier) ? ladder.indexOf(tier) : ladder.length;

/** The claims of a verified GitHub Actions OIDC token that bind it (R-BTN-15). */
export interface SyncClaims {
  repository: string;
  ref: string;
  job_workflow_ref: string;
}

type RepoRow = Omit<Repository, 'transcript_repos' | 'tiers'> & { transcript_repos: string; tiers: string };
const parse = (r: RepoRow): Repository => ({ ...r, transcript_repos: JSON.parse(r.transcript_repos), tiers: JSON.parse(r.tiers) });

export class Registry {
  constructor(private readonly c: { store: Store; now: () => number }) {}

  private rows<T>(q: string, ...p: unknown[]): T[] {
    return this.c.store.exec<T>(q, ...p).toArray();
  }

  /** Register a repository, insert-only: an id or GitHub repository already known is refused
   *  `invalid-params` (retiring and changing one are the administrator's, R3-1240). */
  register(input: unknown): Repository {
    const r = checkRegistration(input);
    if (this.rows('SELECT 1 FROM repositories WHERE id = ? OR github = ? COLLATE NOCASE', r.id, r.github).length) {
      bad('repository', `${r.id} (${r.github}) is already registered`);
    }
    this.c.store.exec(
      `INSERT INTO repositories (id, github, default_branch, sync_workflow, mirror_workflow, weight, transcript_repos, tiers, cutover_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      r.id, r.github, r.default_branch, r.sync_workflow, r.mirror_workflow, r.weight, JSON.stringify(r.transcript_repos), JSON.stringify(r.tiers),
      r.cut_over ? this.c.now() : null);
    this.c.store.exec('INSERT INTO board_head (repository_id, sha) VALUES (?, NULL) ON CONFLICT (repository_id) DO NOTHING', r.id);
    return this.get(r.id)!;
  }

  /** BATON_REPOSITORIES at start: each entry not yet known is registered; a known one is left
   *  as it is. A malformed value throws, so a broken deploy is seen at once. */
  seed(config: Config): string[] {
    const raw = config.BATON_REPOSITORIES;
    if (!raw) return [];
    let list: unknown;
    try {
      list = JSON.parse(raw);
    } catch {
      throw new Error('BATON_REPOSITORIES is not JSON');
    }
    if (!Array.isArray(list)) throw new Error('BATON_REPOSITORIES must be a JSON array');
    const added: string[] = [];
    for (const [i, entry] of list.entries()) {
      const r = checkRegistration(entry, `BATON_REPOSITORIES[${i}]`);
      if (this.rows('SELECT 1 FROM repositories WHERE id = ?', r.id).length) continue;
      this.register(entry);
      added.push(r.id);
    }
    return added;
  }

  get(id: string): Repository | null {
    const r = this.rows<RepoRow>('SELECT id, github, default_branch, sync_workflow, mirror_workflow, weight, transcript_repos, tiers, cutover_at, retired_at FROM repositories WHERE id = ?', id)[0];
    return r ? parse(r) : null;
  }

  /** The repository whose sync still posts the instance's fleet data — providers, prices, the
   *  reviewer matrix and catalog — until the course data of §7.1's board post replaces them (§2a drops the reference repository; R3-1231). An interim, so it is
   *  the one a deployment registered first (docs, the board these tables came from), and no
   *  other repository's sync can rewrite what every repository's claims read. */
  fleetRepository(): string | null {
    return this.rows<{ id: string }>('SELECT id FROM repositories WHERE retired_at IS NULL ORDER BY rowid LIMIT 1')[0]?.id ?? null;
  }

  /** §6.8: the repositories a transcript pointer under one of `repo`'s claims may name — its
   *  own `transcript_repos` (R-BTN-66), or the defaults while it names none. */
  transcriptReposOf(repo: string): string[] {
    return transcriptReposOf(this.c.store, repo);
  }

  /** Every repository not retired, by id. */
  all(): Repository[] {
    return this.rows<RepoRow>('SELECT id, github, default_branch, sync_workflow, mirror_workflow, weight, transcript_repos, tiers, cutover_at, retired_at FROM repositories WHERE retired_at IS NULL ORDER BY id').map(parse);
  }

  /** The one repository a verified sync token may act for (R-BTN-15): its `repository` names a
   *  registered, unretired repository, `ref` is that repository's default branch, and
   *  `job_workflow_ref` is its sync workflow (role `sync`) or its mirror workflow (`mirror`)
   *  on that branch. Anything else is `forbidden`. */
  forSync(claims: SyncClaims, role: 'sync' | 'mirror'): Repository {
    const row = this.rows<RepoRow>(
      `SELECT id, github, default_branch, sync_workflow, mirror_workflow, weight, transcript_repos, tiers, cutover_at, retired_at
       FROM repositories WHERE github = ? COLLATE NOCASE AND retired_at IS NULL`, claims.repository)[0];
    if (!row) throw new BatonError('forbidden', 'the OIDC token is from a repository this Baton does not serve');
    const branch = `refs/heads/${row.default_branch}`;
    const workflow = role === 'sync' ? row.sync_workflow : row.mirror_workflow;
    // GitHub spells the repository its own way; it matched case-insensitively above.
    if (!workflow || claims.ref !== branch || claims.job_workflow_ref !== `${claims.repository}/${workflow}@${branch}`) {
      throw new BatonError('forbidden', `the OIDC token is not from this route’s workflow on ${row.github} ${row.default_branch}`);
    }
    return parse(row);
  }
}

