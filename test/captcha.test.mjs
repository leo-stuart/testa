import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { WebDriver } from '../src/drivers/web.mjs';

// A page with a reCAPTCHA-like widget (iframe + response field). `?solveIn=ms` fills the
// response after a delay, standing in for a person solving it.
const server = createServer((req, res) => {
  if (req.url.startsWith('/recaptcha/frame')) return res.end('<!doctype html><body style="margin:0;background:#f9f9f9">captcha</body>');
  const solveIn = new URL(req.url, 'http://x').searchParams.get('solveIn');
  res.end(`<!doctype html><html><body><h1>Checkout</h1>
<form><div class="g-recaptcha"><iframe src="/recaptcha/frame" width="304" height="78" title="reCAPTCHA"></iframe>
<textarea name="g-recaptcha-response" style="display:none"></textarea></div><button>Pagar</button></form>
${solveIn ? `<script>setTimeout(() => { document.querySelector('[name=g-recaptcha-response]').value = 'tok' }, ${Number(solveIn)})</script>` : ''}
</body></html>`);
}).listen(0);
const base = () => `http://localhost:${server.address().port}`;
const d = new WebDriver();
after(async () => { await d.close(); server.close(); });

test('captcha is detected and headless runs report it instead of waiting', async () => {
  const p = await d.ensure({ headless: true });
  await p.goto(`${base()}/`);
  const c = await d.captcha();
  assert.equal(c.kind, 'reCAPTCHA');
  assert.ok(c.rect.width > 300);
  assert.deepEqual(await d.humanGate(), { status: 'headless', kind: 'reCAPTCHA', ms: 0 });
});

test('visible runs wait for the person, then continue', async () => {
  const p = await d.ensure({ headless: true });
  d.headless = false; // exercise the waiting path without opening a window
  await p.goto(`${base()}/?solveIn=1500`);
  const g = await d.humanGate({ timeoutMs: 8000 });
  assert.equal(g.status, 'solved');
  assert.ok(g.ms >= 1000 && g.ms < 8000, `waited ${g.ms}ms`);
  assert.equal(await d.captcha(), null);
});

test('visible runs time out when nobody solves it', async () => {
  const p = d.page;
  await p.goto(`${base()}/`);
  const g = await d.humanGate({ timeoutMs: 1500 });
  assert.equal(g.status, 'timeout');
  d.headless = true;
});

test('answered or invisible captchas need nobody', async () => {
  const p = d.page;
  await p.setContent('<div class="grecaptcha-badge"><iframe src="https://www.google.com/recaptcha/api2/anchor" width="256" height="60"></iframe></div>');
  assert.equal(await d.captcha(), null);
});
