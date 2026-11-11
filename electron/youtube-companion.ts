// The "sign in with your own browser" route. Google refuses sign-ins inside apps like this one, so the
// person signs in in the browser they already use. A small extension (written to a folder of the app's
// data, loaded once as an unpacked extension) can read that browser's cookies and hands the YouTube ones
// to this app over a one-time link on 127.0.0.1:
//
//   the app starts a server on a random local port, with a random token in every address
//   -> opens http://127.0.0.1:PORT/pair/TOKEN in the default browser
//   -> that page links to the Google sign-in and has a "send" button the extension answers
//   -> the extension POSTs the cookies to /cookies/TOKEN, the app puts them in its session.
//
// The token is used once, the server only answers requests for 127.0.0.1 (no DNS rebinding), sends no
// CORS headers (a web page cannot read it) and stops after 10 minutes or at the first success.
import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const COMPANION_VERSION = '1.0.0';

const MANIFEST = {
  manifest_version: 3,
  name: 'mumh5 companion',
  version: COMPANION_VERSION,
  description: 'Hands your YouTube sign-in to the mumh5 app on this computer. Only talks to 127.0.0.1 and only when you press the button.',
  permissions: ['cookies'],
  host_permissions: ['https://*.youtube.com/*', 'https://*.google.com/*', 'http://127.0.0.1/*'],
  // Chrome and Edge use the service worker, Firefox the scripts
  background: { service_worker: 'background.js', scripts: ['background.js'] },
  content_scripts: [{ matches: ['http://127.0.0.1/pair/*'], js: ['content.js'], run_at: 'document_idle' }],
  browser_specific_settings: { gecko: { id: 'companion@mumh5.app', strict_min_version: '121.0' } }
};

const BACKGROUND_JS = String.raw`// mumh5 companion: reads the YouTube and Google cookies of this browser and gives them to the mumh5 app.
const api = globalThis.browser || globalThis.chrome;
const LOGIN = ['SID', '__Secure-1PSID', '__Secure-3PSID', 'LOGIN_INFO'];

async function send(senderUrl) {
  const u = new URL(senderUrl);
  // Only ever the page mumh5 itself opened, on this computer
  if (u.protocol !== 'http:' || u.hostname !== '127.0.0.1' || !/^\/pair\/[A-Za-z0-9_-]+$/.test(u.pathname)) throw new Error('Not the mumh5 page.');
  const token = u.pathname.split('/')[2];
  const all = [];
  for (const domain of ['youtube.com', 'google.com']) all.push.apply(all, await api.cookies.getAll({ domain: domain }));
  if (!all.some(function (c) { return LOGIN.indexOf(c.name) >= 0; })) throw new Error('This browser is not signed in to YouTube yet. Sign in first, then press the button again.');
  const cookies = all.map(function (c) {
    return { name: c.name, value: c.value, domain: c.domain, hostOnly: c.hostOnly, path: c.path, secure: c.secure, httpOnly: c.httpOnly, sameSite: c.sameSite, expirationDate: c.expirationDate };
  });
  const res = await fetch(u.origin + '/cookies/' + token, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Mumh5': '1' }, body: JSON.stringify({ cookies: cookies })
  });
  const body = await res.json().catch(function () { return {}; });
  if (!res.ok || !body.ok) throw new Error(body.error || 'The app refused the cookies.');
  return { ok: true };
}

api.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || msg.type !== 'mumh5-send') return;
  send((sender && sender.url) || (sender && sender.tab && sender.tab.url) || '')
    .then(sendResponse, function (e) { sendResponse({ ok: false, error: String((e && e.message) || e) }); });
  return true;
});
`;

const CONTENT_JS = String.raw`// mumh5 companion: lets the mumh5 page on 127.0.0.1 know the extension is here, and passes its button press on.
const api = globalThis.browser || globalThis.chrome;
const root = document.documentElement;
root.dataset.mumh5Companion = '1';
document.addEventListener('mumh5-send', function () {
  root.dataset.mumh5Status = 'sending';
  root.dataset.mumh5Msg = '';
  Promise.resolve(api.runtime.sendMessage({ type: 'mumh5-send' })).then(function (r) {
    root.dataset.mumh5Status = r && r.ok ? 'ok' : 'error';
    root.dataset.mumh5Msg = (r && r.error) || '';
  }, function (e) {
    root.dataset.mumh5Status = 'error';
    root.dataset.mumh5Msg = String((e && e.message) || e);
  });
});
`;

// Writes the extension where the person can load it from; returns the folder
export function writeCompanion(dir: string): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(MANIFEST, null, 2));
  writeFileSync(path.join(dir, 'background.js'), BACKGROUND_JS);
  writeFileSync(path.join(dir, 'content.js'), CONTENT_JS);
  return dir;
}

const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

function page(nonce: string, folder: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>mumh5: sign in to YouTube</title>
<style>
body{margin:0;background:#141518;color:#e6e7ea;font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;display:flex;justify-content:center;padding:40px 16px}
main{max-width:560px;width:100%}h1{font-size:20px;margin:0 0 4px}p{color:#a0a3ab;margin:6px 0}
.step{border:1px solid #2a2c32;background:#1a1b1f;padding:16px 18px;margin:14px 0}.step h2{font-size:15px;margin:0 0 6px}
a.btn,button{display:inline-block;margin-top:8px;padding:9px 16px;border:1px solid #7c6cff;background:#7c6cff;color:#fff;font:inherit;font-weight:600;cursor:pointer;text-decoration:none}
button:disabled{opacity:.45;cursor:default}code{background:#222429;padding:1px 5px;word-break:break-all}
#msg{margin-top:10px;font-weight:600}.ok{color:#3bd16f}.err{color:#f0504a}.warn{color:#e8b23c}ol{margin:6px 0;padding-left:20px;color:#a0a3ab}
</style></head><body><main>
<h1>Sign in to YouTube for mumh5</h1>
<p>This page was opened by the mumh5 app on this computer. Nothing here is sent anywhere else.</p>
<div class="step"><h2>1. Sign in</h2><p>Sign in to YouTube in this browser, as you normally would.</p>
<a class="btn" target="_blank" rel="noopener" href="https://accounts.google.com/ServiceLogin?service=youtube&amp;continue=https%3A%2F%2Fwww.youtube.com%2F">Open the YouTube sign-in</a></div>
<div class="step"><h2>2. Send the sign-in to mumh5</h2>
<p id="ext" class="warn">Looking for the mumh5 companion extension...</p>
<button id="send" disabled>Send my YouTube sign-in to mumh5</button><div id="msg"></div>
<div id="help" hidden><p>The extension is not installed in this browser. Install it once:</p>
<ol><li>Chrome, Edge, Brave, Opera: open <code>chrome://extensions</code> (or <code>edge://extensions</code>), turn on Developer mode, press <b>Load unpacked</b>.<br>Firefox: open <code>about:debugging#/runtime/this-firefox</code>, press <b>Load Temporary Add-on</b> and pick <code>manifest.json</code>.</li>
<li>Choose this folder: <code>${esc(folder)}</code></li><li>Reload this page.</li></ol>
<p>Or go back to mumh5 and use <b>Paste cookies</b> instead.</p></div></div>
</main><script nonce="${nonce}">
var root=document.documentElement,send=document.getElementById('send'),msg=document.getElementById('msg'),ext=document.getElementById('ext');
var token=location.pathname.split('/')[2],t0=Date.now(),done=false;
function say(c,t){msg.className=c;msg.textContent=t}
setInterval(function(){
  if(root.dataset.mumh5Companion){ext.className='ok';ext.textContent='The mumh5 companion extension is installed.';if(!done)send.disabled=false;document.getElementById('help').hidden=true}
  else if(Date.now()-t0>2500){ext.className='err';ext.textContent='The mumh5 companion extension was not found.';document.getElementById('help').hidden=false}
  var s=root.dataset.mumh5Status;
  if(s==='error')say('err',root.dataset.mumh5Msg||'Something went wrong.');
},400);
send.onclick=function(){send.disabled=true;say('warn','Sending...');document.dispatchEvent(new CustomEvent('mumh5-send'))};
setInterval(function(){fetch('/status/'+token,{cache:'no-store'}).then(function(r){return r.json()}).then(function(j){
  if(j.state==='done'){done=true;send.disabled=true;say('ok','Done. You are signed in in mumh5, you can close this tab.')}
  else if(root.dataset.mumh5Status==='error'&&!done){send.disabled=false}
}).catch(function(){})},1000);
</script></body></html>`;
}

const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export type Pairing = { url: string; result: Promise<{ ok: boolean; error?: string }>; close: () => void };

// `accept` gets the cookies as JSON text and throws a readable error when it cannot use them
export function startPairing(folder: string, accept: (json: string) => Promise<void>): Promise<Pairing> {
  const token = randomBytes(24).toString('base64url');
  let state: 'waiting' | 'done' = 'waiting';
  let finish!: (r: { ok: boolean; error?: string }) => void;
  const result = new Promise<{ ok: boolean; error?: string }>(r => { finish = r; });
  let timer: ReturnType<typeof setTimeout>;
  let port = 0;

  const server = http.createServer((req, res) => {
    const json = (code: number, body: unknown) => {
      res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(JSON.stringify(body));
    };
    // Rebinding: a hostile page can point its own name at 127.0.0.1, but then the Host header is not ours
    if (req.headers.host !== `127.0.0.1:${port}`) return json(403, { ok: false, error: 'forbidden' });
    const [, kind, given] = (req.url ?? '').split('?')[0].split('/');
    if (!given || !same(given, token)) return json(404, { ok: false, error: 'not found' });
    if (req.method === 'GET' && kind === 'pair') {
      const nonce = randomBytes(12).toString('base64');
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'`
      });
      return void res.end(page(nonce, folder));
    }
    if (req.method === 'GET' && kind === 'status') return json(200, { state });
    if (req.method === 'POST' && kind === 'cookies') {
      if (req.headers['x-mumh5'] !== '1' || !String(req.headers['content-type']).startsWith('application/json')) return json(400, { ok: false, error: 'bad request' });
      if (state === 'done') return json(409, { ok: false, error: 'This link was already used.' });
      const chunks: Buffer[] = [];
      let size = 0;
      req.on('data', (c: Buffer) => {
        size += c.length;
        if (size > 2_000_000) { req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', async () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          await accept(JSON.stringify(body.cookies));
          state = 'done';
          json(200, { ok: true });
          finish({ ok: true });
          setTimeout(close, 3000);
        } catch (e) { json(422, { ok: false, error: (e as Error).message }); }
      });
      return;
    }
    json(404, { ok: false, error: 'not found' });
  });

  function close() {
    clearTimeout(timer);
    server.close();
    server.closeAllConnections?.();
    finish({ ok: false, error: 'cancelled' }); // no-op when it already finished
  }

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      port = (server.address() as import('node:net').AddressInfo).port;
      timer = setTimeout(() => { finish({ ok: false, error: 'Timed out after 10 minutes.' }); close(); }, 10 * 60_000);
      resolve({ url: `http://127.0.0.1:${port}/pair/${token}`, result, close });
    });
  });
}
