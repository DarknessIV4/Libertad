import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCookies } from '../electron/youtube-cookies.ts';

const NOW = 1_800_000_000;

test('Cookie header value', () => {
  const c = parseCookies('SID=abc; __Secure-3PSID=def; PREF=f6=1&tz=Asia', NOW);
  assert.equal(c.length, 3);
  assert.ok(c.every(x => x.domain === 'youtube.com' && x.secure && x.expires > NOW));
  assert.equal(c.find(x => x.name === 'SID')!.httpOnly, true);
  assert.ok(c.every(x => x.sameSite === 'no_restriction'), 'sent to the embedded player (third-party)');
});
test('Cookie-Editor JSON, other sites dropped, expired dropped', () => {
  const c = parseCookies(JSON.stringify([
    { name: 'LOGIN_INFO', value: 'x', domain: '.youtube.com', path: '/', secure: true, httpOnly: true, hostOnly: false, sameSite: 'no_restriction', expirationDate: NOW + 1000 },
    { name: 'SID', value: 'y', domain: '.google.com', path: '/', secure: true, httpOnly: true, expirationDate: NOW - 5 },
    { name: 'other', value: 'z', domain: '.example.com', path: '/' },
    { name: '__Host-GAPS', value: 'g', domain: 'accounts.google.com', path: '/x', hostOnly: true }
  ]), NOW);
  assert.deepEqual(c.map(x => x.name), ['LOGIN_INFO', '__Host-GAPS']);
  assert.equal(c[0].sameSite, 'no_restriction');
  assert.equal(c[1].path, '/');
});
test('Netscape cookies.txt with #HttpOnly_', () => {
  const t = '# Netscape HTTP Cookie File\n#HttpOnly_.youtube.com\tTRUE\t/\tTRUE\t' + (NOW + 99) + '\tSID\tabc\n.youtube.com\tTRUE\t/\tTRUE\t0\tYSC\tq';
  const c = parseCookies(t, NOW);
  assert.equal(c.length, 2);
  assert.equal(c[0].httpOnly, true);
  assert.ok(c[1].expires > NOW); // session cookie made permanent
});
test('DevTools table rows', () => {
  const c = parseCookies('LOGIN_INFO\tvalue1\t.youtube.com\t/\t2027-05-01T00:00:00.000Z\t300\t✓\t✓\tNone', 1_700_000_000);
  assert.equal(c[0].httpOnly, true);
  assert.equal(c[0].sameSite, 'no_restriction');
});
test('rejects signed-out and junk', () => {
  assert.throws(() => parseCookies('PREF=1; YSC=2', NOW), /signed-out/);
  assert.throws(() => parseCookies('[nope', NOW), /not a cookie export/);
  assert.throws(() => parseCookies('   ', NOW), /Nothing/);
});
