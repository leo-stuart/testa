// Web driver: Playwright Chromium, DOM-based candidates (no vision).
import { chromium } from 'playwright';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
let axeSource;

// Fake cursor so a watching human can follow the test (Playwright never moves the real OS cursor).
// pointer-events:none keeps it out of hit-testing; aria-hidden keeps it out of a11y audits.
const CURSOR_SCRIPT = `(() => {
  if (window.__ftCursor) return;
  window.__ftCursor = true;
  const mount = () => {
    if (!document.body || document.getElementById('__ft_cursor')) return;
    const c = document.createElement('div');
    c.id = '__ft_cursor';
    c.setAttribute('aria-hidden', 'true');
    c.style.cssText = 'position:fixed;left:0;top:0;width:22px;height:22px;z-index:2147483647;pointer-events:none;transform:translate(-100px,-100px);';
    c.innerHTML = '<svg width="22" height="22" viewBox="0 0 22 22"><path d="M3 2l14 8-6 1.5L8 18z" fill="#111" stroke="#fff" stroke-width="1.5"/></svg>';
    const ring = document.createElement('div');
    ring.setAttribute('aria-hidden', 'true');
    ring.style.cssText = 'position:fixed;left:0;top:0;width:28px;height:28px;margin:-14px 0 0 -14px;border-radius:50%;border:3px solid #ff3b6b;z-index:2147483646;pointer-events:none;opacity:0;';
    document.body.append(ring, c);
    addEventListener('mousemove', (e) => { c.style.transform = 'translate(' + (e.clientX - 3) + 'px,' + (e.clientY - 2) + 'px)'; }, true);
    addEventListener('mousedown', (e) => {
      ring.style.left = e.clientX + 'px'; ring.style.top = e.clientY + 'px';
      ring.animate([{ opacity: 1, transform: 'scale(0.4)' }, { opacity: 0, transform: 'scale(1.6)' }], { duration: 450, easing: 'ease-out' });
    }, true);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount); else mount();
})()`;

const INTERACTIVE = [
  'a[href]', 'button', 'input:not([type=hidden])', 'select', 'textarea', 'summary',
  '[role=button]', '[role=link]', '[role=tab]', '[role=checkbox]', '[role=radio]', '[role=switch]',
  '[role=menuitem]', '[role=option]', '[role=combobox]', '[role=textbox]', '[contenteditable=true]',
  '[onclick]', '[tabindex]:not([tabindex="-1"])',
].join(',');

export class WebDriver {
  kind = 'web';
  browser = null;
  context = null;
  page = null;
  events = [];
  network = [];
  storageState = undefined;
  mocks = [];
  mocked = new WeakSet();

  async ensure({ headless } = {}) {
    headless ??= process.env.TESTA_HEADLESS !== '0'; // read each time so `settings` changes apply to the next page
    // Switching between visible/hidden needs a new browser.
    if (this.browser && headless !== this.headless) await this.close();
    if (this.page && !this.page.isClosed()) return this.page;
    this.headless = headless;
    this.browser ??= await chromium.launch({ headless, slowMo: headless ? 0 : Number(process.env.TESTA_SLOWMO ?? 150) });
    this.context = await this.browser.newContext({ viewport: { width: 1280, height: 800 }, storageState: this.storageState });
    this.page = await this.context.newPage();
    await this.context.route('**/*', (route) => this.routeHandler(route));
    this.showCursor = !headless || process.env.TESTA_SHOW_CURSOR === '1';
    if (this.showCursor && process.env.TESTA_SHOW_CURSOR !== '0') await this.context.addInitScript(CURSOR_SCRIPT);
    const p = this.page;
    p.on('console', (m) => {
      if (m.type() === 'error' || m.type() === 'warning') this.events.push({ kind: `console.${m.type()}`, text: m.text().slice(0, 400) });
    });
    p.on('pageerror', (e) => this.events.push({ kind: 'pageerror', text: String(e).slice(0, 400) }));
    p.on('requestfailed', (r) => this.events.push({ kind: 'requestfailed', text: `${r.method()} ${r.url()} ${r.failure()?.errorText ?? ''}` }));
    p.on('response', (r) => {
      const req = r.request();
      if (!['xhr', 'fetch', 'document'].includes(req.resourceType())) return;
      this.network.push({ method: req.method(), url: r.url(), status: r.status(), mocked: this.mocked.has(req) || undefined });
      if (this.network.length > 300) this.network.shift();
      if (r.status() >= 400 && !this.mocked.has(req)) {
        r.text().then((body) => this.events.push({ kind: 'http', text: `${r.status()} ${req.method()} ${r.url()} — ${body.slice(0, 300)}` }))
          .catch(() => this.events.push({ kind: 'http', text: `${r.status()} ${req.method()} ${r.url()}` }));
      }
    });
    return p;
  }

  async open({ url, headless }) {
    const p = await this.ensure({ headless });
    if (url) await p.goto(url, { waitUntil: 'domcontentloaded' });
    await this.settle();
  }

  /** Load (or drop) a saved login session; takes effect on a fresh browser context. */
  async useSession(storageState) {
    if (storageState === this.storageState) return;
    this.storageState = storageState;
    await this.context?.close().catch(() => {});
    this.context = this.page = null;
  }

  async saveSession(path) {
    await this.context.storageState({ path });
  }

  async routeHandler(route) {
    const req = route.request();
    const url = req.url();
    const rule = this.mocks.find((m) => (!m.method || m.method === req.method())
      && (m.regex ? new RegExp(m.url).test(url) : url.includes(m.url)) && (m.times == null || m.hits < m.times));
    if (!rule) return route.fallback();
    rule.hits++;
    this.mocked.add(req);
    if (rule.delayMs) await new Promise((r) => setTimeout(r, rule.delayMs));
    if (rule.fail) return route.abort('failed');
    return route.fulfill({
      status: rule.status ?? 200,
      headers: { 'content-type': 'application/json', ...rule.headers },
      body: typeof rule.body === 'string' ? rule.body : JSON.stringify(rule.body ?? {}),
    });
  }

  async setMocks(rules) { this.mocks = rules.map((r) => ({ ...r, method: r.method?.toUpperCase(), hits: 0 })); }
  async clearMocks() { this.mocks = []; }

  async navigate(url) {
    const p = await this.ensure();
    await p.goto(new URL(url, p.url() === 'about:blank' ? undefined : p.url()).href, { waitUntil: 'domcontentloaded' });
    await this.settle();
  }

  /** Full WCAG audit of the current page with axe-core. */
  async a11yAudit() {
    const p = await this.ensure();
    axeSource ??= readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
    await p.evaluate(axeSource);
    const res = await p.evaluate(() => globalThis.axe.run(document, { resultTypes: ['violations'] }));
    return res.violations.map((v) => ({
      rule: v.id, impact: v.impact, help: v.help,
      nodes: v.nodes.slice(0, 5).map((n) => n.target.join(' ')), count: v.nodes.length,
    }));
  }

  markEvents() { this.events = []; this.network = []; }
  async takeEvents() {
    await this.page?.waitForTimeout(100).catch(() => {}); // let pending response bodies land
    return { events: this.events.splice(0), network: this.network.splice(0), source: 'playwright' };
  }

  /** Wait until the DOM stops mutating for 250ms (max 2s); SPAs rarely reach networkidle. */
  async settle() {
    const p = this.page;
    await p.waitForLoadState('domcontentloaded').catch(() => {});
    await p.evaluate(() => new Promise((resolve) => {
      let timer;
      const done = () => { obs.disconnect(); resolve(); };
      const obs = new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(done, 250); });
      obs.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
      timer = setTimeout(done, 250);
      setTimeout(done, 2000);
    })).catch(() => {});
  }

  async observe() {
    const p = await this.ensure();
    const snap = await p.evaluate((sel) => {
      const out = [];
      const a11y = [];
      let n = 0;
      let hidden = 0;
      const vw = innerWidth, vh = innerHeight;
      const nameOf = (el) => {
        const lbl = el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        return (el.getAttribute('aria-label') || (lbl && lbl.innerText) || el.innerText || el.value ||
          el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('alt') ||
          el.getAttribute('name') || el.getAttribute('data-testid') || '').replace(/\s+/g, ' ').trim().slice(0, 80);
      };
      for (const el of document.querySelectorAll(sel)) {
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        if (r.width < 2 || r.height < 2 || cs.visibility === 'hidden' || cs.display === 'none') continue;
        if (el.closest('[aria-hidden=true]') || el.disabled) continue;
        // Covered by a modal/overlay? The topmost element at its center must be it or inside it.
        if (!(r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw)) {
          const top = document.elementFromPoint(Math.min(vw - 1, Math.max(0, r.x + r.width / 2)), Math.min(vh - 1, Math.max(0, r.y + r.height / 2)));
          if (top && top !== el && !el.contains(top) && !top.contains(el)) { hidden++; continue; }
        }
        const id = `e${n++}`;
        const box = el.closest('dialog,[role=dialog],[aria-modal=true],form,nav,header,footer,aside,section,[role=tabpanel],[role=region]');
        let ctx;
        if (box) {
          const tag = box.getAttribute('role') || box.tagName.toLowerCase();
          const title = box.getAttribute('aria-label') || box.querySelector('h1,h2,h3,h4,legend,[role=heading]')?.innerText;
          ctx = `${tag}${title ? ` "${title.replace(/\s+/g, ' ').trim().slice(0, 40)}"` : ''}`;
        }
        el.setAttribute('data-ft-id', id);
        const tag = el.tagName.toLowerCase();
        const accessibleName = el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)) || el.closest('label')
          || (['input', 'textarea', 'select'].includes(tag) ? el.getAttribute('title') : (el.innerText || el.getAttribute('title') || el.querySelector('img[alt]')?.getAttribute('alt')));
        if (!accessibleName || (typeof accessibleName === 'string' && !accessibleName.trim())) {
          a11y.push({ rule: ['input', 'textarea', 'select'].includes(tag) ? 'input-without-label' : 'missing-label', name: nameOf(el) || `${tag} @${Math.round(r.x)},${Math.round(r.y)}`, hint: ['input', 'textarea', 'select'].includes(tag) ? 'Placeholder is not a label: add <label for> or aria-label' : 'Control without accessible name: add text or aria-label' });
        }
        const role = el.getAttribute('role') || (tag === 'input' ? `input:${el.type || 'text'}` : tag);
        out.push({
          id, kind: role, name: nameOf(el),
          value: ['input', 'textarea', 'select'].includes(tag) && el.type !== 'password' ? String(el.value ?? '').slice(0, 60) : undefined,
          testId: el.getAttribute('data-testid') || undefined,
          ctx,
          x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
          offscreen: r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw,
        });
      }
      const text = (document.body?.innerText || '').replace(/\n{2,}/g, '\n').slice(0, 3000);
      const missingTestIds = out.filter((e) => !e.testId).length;
      return { title: document.title, elements: out, text, vh, hidden, a11y, missingTestIds };
    }, INTERACTIVE);
    const u = new URL(p.url());
    return { ...snap, where: p.url(), route: { name: u.pathname, params: Object.fromEntries(u.searchParams) } };
  }

  /** Glide the (visible) cursor to the element so a human can follow along. */
  async moveTo(loc) {
    if (!this.showCursor || process.env.TESTA_SHOW_CURSOR === '0') return;
    await loc.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
    const b = await loc.boundingBox().catch(() => null);
    if (b) await this.page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 12 });
  }

  async act({ action, el, value }) {
    const p = this.page;
    const loc = el ? p.locator(`[data-ft-id="${el.id}"]`).first() : null;
    if (loc) await this.moveTo(loc);
    switch (action) {
      case 'tap':
        await loc.click({ timeout: 4000 });
        break;
      case 'type':
        if (el.kind === 'select') await loc.selectOption({ label: value }).catch(() => loc.selectOption(value));
        else await loc.fill(String(value), { timeout: 4000 });
        break;
      case 'submit':
        if (loc) await loc.press('Enter');
        else await p.keyboard.press('Enter');
        break;
      case 'scroll_down': await p.mouse.wheel(0, 600); break;
      case 'scroll_up': await p.mouse.wheel(0, -600); break;
      case 'back': await p.goBack().catch(() => {}); break;
      case 'wait': await p.waitForTimeout(800); break;
      default: throw new Error(`web: unknown action ${action}`);
    }
    await this.settle();
  }

  async screenshot(path) {
    await this.page.screenshot({ path, fullPage: false });
    return path;
  }

  async close() {
    await this.browser?.close().catch(() => {});
    this.browser = this.context = this.page = null;
  }
}
