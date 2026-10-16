// links.ts — R-BTN-92's one link rule (BATON_SPEC §2k, §10.4; R3-1262): every link Baton accepts or
// draws for a repository is built from, and checked against, the repository's `web_base` — never a
// pinned `https://github.com/`. A `git` repository has no `web_base`, and no link.

/** The forges a repository may be on (R-BTN-92); fixed for the repository's life. */
export const FORGES = ['github', 'gitlab', 'gitea', 'git'] as const;
export type Forge = (typeof FORGES)[number];

const SEGMENT = /^[A-Za-z0-9_.-]{1,100}$/;

/** R-BTN-92's forge path: segments of `[A-Za-z0-9_.-]{1,100}`, none `.` or `..` and none ending in
 *  `.git`, two of them on GitHub, Gitea and `git`, two to four on GitLab. */
export function isForgePath(forge: Forge, path: string): boolean {
  const segs = path.split('/');
  const [min, max] = forge === 'gitlab' ? [2, 4] : [2, 2];
  if (segs.length < min || segs.length > max) return false;
  return segs.every((s) => SEGMENT.test(s) && s !== '.' && s !== '..' && !s.toLowerCase().endsWith('.git'));
}

/** A parsed `https` URL with no userinfo, query or fragment, whose path segments are clean; or null. */
function cleanUrl(text: string, allowQuery: boolean): URL | null {
  if (text.length > 1000 || /[\\\s]/.test(text)) return null;
  // As written: `https://` itself (the parser also takes `https:host` and `https:/host`), no
  // fragment marker, and no query marker where none is allowed — not even an empty one (round 2, 2-A-1).
  if (!text.startsWith('https://') || text.includes('#') || (!allowQuery && text.includes('?'))) return null;
  let u: URL;
  try {
    u = new URL(text);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.hash) return null;
  if (!allowQuery && u.search) return null;
  // Percent-decoded, every segment is a name: no `.`, `..`, empty segment or encoded `/` or `\`.
  // Judged on the text as written — the URL parser has already resolved dot segments away, and the
  // text, not the parse, is what is stored and drawn (round 1, 1-A-4, 1-B-1).
  const written = /^https:\/\/[^/?#]*(\/[^?#]*)?/i.exec(text)?.[1] ?? '';
  const raw = written.split('/').slice(1);
  for (const seg of raw) {
    let dec: string;
    try {
      dec = decodeURIComponent(seg);
    } catch {
      return null;
    }
    if (dec === '' || dec === '.' || dec === '..' || /[/\\]/.test(dec)) return null;
  }
  return u;
}

/** A `web_base` as registration takes it (R-BTN-92): `https://<host>[:<port>]/<forge path>`, with
 *  no userinfo, query or fragment, whose path is `path`. */
export function isWebBase(forge: Forge, webBase: string, path: string): boolean {
  if (forge === 'git') return false;
  const u = cleanUrl(webBase, false);
  return u !== null && !webBase.endsWith('/') && u.pathname.slice(1).toLowerCase() === path.toLowerCase() && isForgePath(forge, u.pathname.slice(1));
}

/** R-BTN-92's rule: `url` is under `webBase` — `https`, no userinfo, the same host (case-insensitive)
 *  and port, and a path that begins with the `web_base`'s segments as whole segments, every segment
 *  clean after percent-decoding. */
export function underWebBase(url: string, webBase: string): boolean {
  const u = cleanUrl(url, true);
  const b = cleanUrl(webBase, false);
  if (!u || !b) return false;
  if (u.hostname.toLowerCase() !== b.hostname.toLowerCase() || u.port !== b.port) return false;
  const us = u.pathname.split('/').slice(1).map((s) => s.toLowerCase());
  const bs = b.pathname.split('/').slice(1).map((s) => s.toLowerCase());
  return bs.length <= us.length && bs.every((s, i) => us[i] === s);
}

/** A pull request's URL on a forge (§10.4): `/pull/<n>` on GitHub, `/pulls/<n>` on Gitea,
 *  `/-/merge_requests/<n>` on GitLab, after the repository's `web_base`. */
export function isPullRequestUrl(forge: Forge, url: string, webBase: string): boolean {
  if (!underWebBase(url, webBase)) return false;
  const rest = new URL(url).pathname.slice(new URL(webBase).pathname.length);
  const re = forge === 'github' ? /^\/pull\/\d{1,9}$/ : forge === 'gitea' ? /^\/pulls\/\d{1,9}$/ : forge === 'gitlab' ? /^\/-\/merge_requests\/\d{1,9}$/ : null;
  return re !== null && re.test(rest) && !new URL(url).search;
}

/** A `transcript_repos` entry (§6.8): a GitHub `owner/name`, or `<forge>:<web_base>`. */
export function parseTranscriptRepo(entry: string): { forge: Forge; webBase: string } | null {
  const m = /^(github|gitlab|gitea):(https:\/\/.+)$/.exec(entry);
  if (m) {
    const forge = m[1] as Forge;
    const u = cleanUrl(m[2], false);
    if (!u || m[2].endsWith('/') || !isForgePath(forge, u.pathname.slice(1))) return null;
    return { forge, webBase: m[2] };
  }
  return isForgePath('github', entry) ? { forge: 'github', webBase: `https://github.com/${entry}` } : null;
}

/** §6.8: the dashboard's link to a transcript file — its repository's base and its forge's file
 *  path — or null when the entry or path does not pass. */
export function transcriptUrl(entry: string, path: string): string | null {
  const r = parseTranscriptRepo(entry);
  if (!r || !/^[A-Za-z0-9._/-]{1,256}$/.test(path) || path.split('/').some((s) => s === '' || s === '.' || s === '..')) return null;
  const file = r.forge === 'github' ? '/blob/HEAD/' : r.forge === 'gitlab' ? '/-/blob/HEAD/' : '/src/branch/HEAD/';
  const url = `${r.webBase}${file}${path}`;
  return underWebBase(url, r.webBase) ? url : null;
}

/** A file's page in a repository at a branch (the dashboard's ticket links, §14): the `web_base`
 *  and its forge's file path, or null for a `git` repository, which has no pages. */
export function fileUrl(forge: Forge, webBase: string | null, branch: string, path: string): string | null {
  if (forge === 'git' || !webBase) return null;
  const file = forge === 'github' ? '/blob/' : forge === 'gitlab' ? '/-/blob/' : '/src/branch/';
  const url = `${webBase}${file}${branch}/${path}`;
  return underWebBase(url, webBase) ? url : null;
}
