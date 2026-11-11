// Turns whatever the person pasted (or the browser companion sent) into cookies for the app's session.
// Accepted: the JSON export of Cookie-Editor and similar extensions, a Netscape cookies.txt file, rows
// copied from the browser's cookie table (DevTools > Application/Storage), and the plain value of a
// request's "Cookie:" header (DevTools > Network), which is the easiest way to get the HttpOnly ones.
// No electron import here, so the tests can run it.

export type ParsedCookie = {
  name: string; value: string; domain: string; hostOnly: boolean; path: string;
  secure: boolean; httpOnly: boolean; sameSite: 'unspecified' | 'no_restriction' | 'lax' | 'strict';
  expires: number; // seconds since the epoch, always in the future
};

// Only these sites' cookies are taken, whatever else was in the paste
const SITES = ['youtube.com', 'google.com'];
// Cookies that exist only while someone is signed in
export const LOGIN_COOKIES = new Set(['SID', '__Secure-1PSID', '__Secure-3PSID', 'LOGIN_INFO']);
// A signed-in session that is meant to last: cookies without an end date get this long
const KEEP_SECONDS = 365 * 86400;
const MAX_SECONDS = 400 * 86400;

const siteOf = (host: string) => SITES.find(s => host === s || host.endsWith('.' + s));

function sameSiteOf(v: unknown): ParsedCookie['sameSite'] {
  const s = String(v ?? '').toLowerCase();
  if (s === 'no_restriction' || s === 'none') return 'no_restriction';
  if (s === 'lax' || s === 'strict') return s;
  return 'unspecified';
}

type Loose = { name: string; value: string; domain?: string; hostOnly?: boolean; path?: string; secure?: boolean; httpOnly?: boolean; sameSite?: unknown; expires?: number };

function finish(c: Loose, now: number): ParsedCookie | null {
  const name = String(c.name ?? '').trim();
  if (!name || /[\s;=,]/.test(name)) return null;
  let value = String(c.value ?? '').trim();
  if (value.length > 1 && value.startsWith('"') && value.endsWith('"') && !value.includes('\\')) value = value.slice(1, -1);
  const raw = String(c.domain ?? '.youtube.com').trim().toLowerCase();
  const host = raw.replace(/^\./, '');
  if (!siteOf(host)) return null;
  const sameSite = sameSiteOf(c.sameSite);
  const prefixed = name.startsWith('__Secure-') || name.startsWith('__Host-');
  const hostOnly = c.hostOnly ?? !raw.startsWith('.');
  let expires = c.expires && c.expires > 0 ? c.expires : 0;
  if (expires && expires <= now) return null; // already expired
  // Session cookies would be gone at the next start; the sign-in is meant to be permanent
  if (!expires) expires = now + KEEP_SECONDS;
  expires = Math.min(expires, now + MAX_SECONDS);
  return {
    name, value, domain: host, hostOnly: name.startsWith('__Host-') ? true : hostOnly,
    path: name.startsWith('__Host-') ? '/' : (c.path || '/'),
    secure: c.secure !== false || prefixed || sameSite === 'no_restriction',
    httpOnly: !!c.httpOnly, sameSite, expires
  };
}

function fromJson(text: string): Loose[] {
  const data = JSON.parse(text);
  const list: unknown[] = Array.isArray(data) ? data : Array.isArray(data?.cookies) ? data.cookies : [];
  return list.filter((c): c is Record<string, any> => !!c && typeof c === 'object').map(c => ({
    name: c.name, value: c.value, domain: c.domain, hostOnly: typeof c.hostOnly === 'boolean' ? c.hostOnly : undefined,
    path: c.path, secure: c.secure, httpOnly: c.httpOnly ?? c.httponly,
    sameSite: c.sameSite ?? c.same_site,
    expires: Number(c.expirationDate ?? c.expires ?? c.expiry ?? 0) || 0
  }));
}

const isTrue = (s: string | undefined) => /^(true|✓|✔|yes|1)$/i.test((s ?? '').trim());

function fromRows(text: string): Loose[] {
  const out: Loose[] = [];
  for (let line of text.split(/\r?\n/)) {
    let httpOnly = false;
    if (line.startsWith('#HttpOnly_')) { httpOnly = true; line = line.slice(10); }
    else if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const f = line.split('\t');
    if (f.length >= 7 && /^(TRUE|FALSE)$/i.test(f[1]) && /^(TRUE|FALSE)$/i.test(f[3])) {
      // Netscape: domain, include subdomains, path, secure, expires, name, value
      out.push({ domain: f[0], hostOnly: !isTrue(f[1]), path: f[2], secure: isTrue(f[3]), expires: Number(f[4]) || 0, name: f[5], value: f.slice(6).join('\t'), httpOnly });
    } else if (f.length >= 5 && f[3].startsWith('/')) {
      // DevTools table: name, value, domain, path, expires, size, HttpOnly, Secure, SameSite, ...
      const exp = Date.parse(f[4]);
      out.push({ name: f[0], value: f[1], domain: f[2], path: f[3], expires: Number.isNaN(exp) ? 0 : exp / 1000, httpOnly: isTrue(f[6]), secure: f.length > 7 ? isTrue(f[7]) : true, sameSite: f[8] });
    }
  }
  return out;
}

function fromHeader(text: string): Loose[] {
  const body = text.replace(/^\s*(-H\s*)?['"]?cookie\s*:\s*/i, '').replace(/['"]\s*$/, '').replace(/\r?\n/g, ' ');
  const out: Loose[] = [];
  for (const part of body.split(/;\s*/)) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    // A header carries no flags; these cookies are all HTTPS-only. The ones the login needs are HttpOnly.
    // The player is a frame inside the app's page, so YouTube sees these cookies as third-party ones: with no SameSite
    // given they would count as Lax and not be sent to it at all. "None" sends them, which is what Google's own do.
    out.push({ name: part.slice(0, i), value: part.slice(i + 1), domain: '.youtube.com', path: '/', secure: true, sameSite: 'no_restriction', httpOnly: LOGIN_COOKIES.has(part.slice(0, i)) });
  }
  return out;
}

// Returns the YouTube and Google cookies found in the text; throws a readable error when there is no cookie in it
export function parseCookies(text: string, now = Date.now() / 1000): ParsedCookie[] {
  const t = text.trim();
  if (!t) throw new Error('Nothing was pasted.');
  let loose: Loose[];
  try {
    if (t.startsWith('[') || t.startsWith('{')) loose = fromJson(t);
    else loose = t.includes('\t') ? fromRows(t) : fromHeader(t);
  } catch { throw new Error('That is not a cookie export this app understands.'); }
  const seen = new Map<string, ParsedCookie>();
  for (const l of loose) {
    const c = finish(l, now);
    if (c) seen.set(`${c.name}|${c.domain}|${c.hostOnly}|${c.path}`, c);
  }
  const cookies = [...seen.values()];
  if (!cookies.length) throw new Error('No youtube.com or google.com cookies were found in that text.');
  if (!cookies.some(c => LOGIN_COOKIES.has(c.name))) {
    throw new Error('These cookies are from a signed-out session: none of SID, __Secure-3PSID or LOGIN_INFO is there. Sign in to YouTube in your browser first, then copy again.');
  }
  return cookies;
}
