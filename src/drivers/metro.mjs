// React Native dev-build bridge through Metro's CDP inspector proxy. Works for any RN/Expo app:
//  - console/exceptions from Runtime events
//  - network via an injected XHR/fetch hook (RN's CDP has no Network domain)
//  - API mocks (fetch + XHR) for error/edge-state tests
//  - current route + navigation through the app's React Navigation container ref
//  - LogBox toasts hidden during runs (they cover tab bars and steal taps)

const HOOKS = `(() => {
  const g = globalThis;
  if (g.__ftHooked) return 'already';
  g.__ftHooked = true;
  g.__ftNet = [];
  g.__ftMocks = g.__ftMocks || [];
  const log = (e) => { g.__ftNet.push(e); if (g.__ftNet.length > 300) g.__ftNet.shift(); };
  const match = (method, url) => g.__ftMocks.find((r) => (!r.method || r.method === method)
    && (r.regex ? new RegExp(r.url).test(url) : url.indexOf(r.url) !== -1) && (r.times == null || r.hits < r.times));
  const bodyOf = (r) => typeof r.body === 'string' ? r.body : JSON.stringify(r.body === undefined ? {} : r.body);

  if (typeof g.fetch === 'function') {
    const orig = g.fetch;
    g.fetch = function (input, init) {
      const url = typeof input === 'string' ? input : (input && input.url) || String(input);
      const method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
      const r = match(method, url);
      if (!r) return orig.apply(this, arguments);
      r.hits++;
      const t0 = Date.now();
      return new Promise((resolve, reject) => setTimeout(() => {
        log({ method, url, status: r.fail ? 0 : (r.status || 200), ms: Date.now() - t0, at: Date.now(), mocked: true, body: '' });
        if (r.fail) return reject(new TypeError('Network request failed'));
        resolve(new Response(bodyOf(r), { status: r.status || 200, headers: Object.assign({ 'content-type': 'application/json' }, r.headers || {}) }));
      }, r.delayMs || 0));
    };
  }

  if (typeof XMLHttpRequest !== 'undefined') {
    const P = XMLHttpRequest.prototype, open = P.open, send = P.send;
    P.open = function (m, u) { this.__ft = { method: String(m).toUpperCase(), url: String(u) }; return open.apply(this, arguments); };
    P.send = function () {
      const req = this.__ft, t0 = Date.now(), xhr = this;
      const r = req && match(req.method, req.url);
      if (r) {
        r.hits++;
        setTimeout(() => {
          const body = bodyOf(r);
          const def = (k, v) => Object.defineProperty(xhr, k, { value: v, configurable: true, writable: true });
          def('readyState', 4); def('status', r.fail ? 0 : (r.status || 200)); def('statusText', ''); def('responseURL', req.url);
          def('responseText', body);
          let resp = body;
          if (xhr.responseType === 'json') { try { resp = JSON.parse(body); } catch (e) { resp = null; } }
          else if (xhr.responseType === 'blob' && typeof Blob !== 'undefined') resp = new Blob([body], { type: 'application/json' });
          def('response', resp);
          xhr.getAllResponseHeaders = () => 'content-type: application/json\\r\\n';
          xhr.getResponseHeader = (h) => (String(h).toLowerCase() === 'content-type' ? 'application/json' : null);
          log({ method: req.method, url: req.url, status: r.fail ? 0 : (r.status || 200), ms: Date.now() - t0, at: Date.now(), mocked: true, body: '' });
          const types = r.fail ? ['readystatechange', 'error', 'loadend'] : ['readystatechange', 'load', 'loadend'];
          for (const type of types) {
            try {
              if (typeof xhr.dispatchEvent === 'function') xhr.dispatchEvent({ type, target: xhr });
              else if (typeof xhr['on' + type] === 'function') xhr['on' + type]({ type, target: xhr });
            } catch (e) {}
          }
        }, r.delayMs || 0);
        return;
      }
      if (req) this.addEventListener('loadend', () => {
        let body = '';
        if (this.status >= 400) { try { body = String(this.responseText || '').slice(0, 300); } catch (e) {} }
        log({ method: req.method, url: req.url, status: this.status, ms: Date.now() - t0, at: Date.now(), body });
      });
      return send.apply(this, arguments);
    };
  }
  return 'ok';
})()`;

// Finds a React Navigation container ref (navigate/getCurrentRoute/isReady) among already-initialized
// modules, also one level deep (expo-router keeps it on a store object). Only data properties are
// read: modules like react-native export lazy getters that load (and can crash) other modules.
const NAV_REF = `(() => {
  const g = globalThis;
  let ref = g.__ftNavRef;
  const val = (o, k) => { const d = Object.getOwnPropertyDescriptor(o, k); return d && 'value' in d ? d.value : undefined; };
  const isRef = (v) => v && typeof v === 'object' && typeof val(v, 'navigate') === 'function'
    && typeof val(v, 'getCurrentRoute') === 'function' && typeof val(v, 'isReady') === 'function';
  if (!isRef(ref)) {
    ref = null;
    const r = g.__r;
    if (!r || !r.getModules) return null;
    const mods = r.getModules();
    outer: for (const [, mod] of (mods instanceof Map ? mods : Object.entries(mods))) {
      if (!mod || !mod.isInitialized) continue;
      const ex = mod.publicModule && mod.publicModule.exports;
      if (!ex || typeof ex !== 'object') continue;
      for (const k of Object.keys(ex)) {
        const v = val(ex, k);
        if (isRef(v)) { ref = v; break outer; }
        if (v && typeof v === 'object' && !Array.isArray(v)) {
          for (const j of Object.keys(v).slice(0, 50)) { const w = val(v, j); if (isRef(w)) { ref = w; break outer; } }
        }
      }
    }
    g.__ftNavRef = ref;
  }
  return ref;
})()`;

const NAV_STATE = `(() => {
  const ref = ${NAV_REF};
  if (!ref) return JSON.stringify({ error: 'no React Navigation container ref found' });
  if (!ref.isReady()) return JSON.stringify({ error: 'navigation not ready' });
  const cur = ref.getCurrentRoute();
  const root = ref.getRootState();
  return JSON.stringify({ route: cur && { name: cur.name, params: cur.params }, routeNames: root && root.routeNames });
})()`;

const navigateExpr = (screen, params) => `(() => {
  const ref = ${NAV_REF};
  if (!ref || !ref.isReady()) return 'no-nav';
  ref.navigate(${JSON.stringify(screen)}, ${params === undefined ? 'undefined' : JSON.stringify(params)});
  return 'ok';
})()`;

const logboxExpr = (hide) => `(() => {
  const r = globalThis.__r;
  if (!r || !r.getModules) return 'no-registry';
  const mods = r.getModules();
  for (const [id, mod] of (mods instanceof Map ? mods : Object.entries(mods))) {
    if (mod && /LogBox\\/LogBox\\.js$/.test(mod.verboseName || '')) {
      const m = r(Number(id)); const LB = m.default || m;
      // Clear on both edges: errors raised during the test are already in our report.
      if (LB.clearAllLogs) LB.clearAllLogs();
      LB.ignoreAllLogs(${hide});
      return 'ok';
    }
  }
  return 'not-found';
})()`;

const NOISE = /deprecated|NOTE: You are using an unsupported debugging client|registerDeviceForRemoteMessages/i;
const STATIC = /\.(png|jpe?g|gif|webp|svg|ttf|otf|woff2?|js|map|bundle)(\?|$)|symbolicate|\/logs$|inspector/i;

const fmtArg = (a) => a.value !== undefined ? (typeof a.value === 'string' ? a.value : JSON.stringify(a.value)) : (a.preview?.properties?.length
  ? `{${a.preview.properties.map((p) => `${p.name}: ${p.value}`).join(', ')}}` : a.description ?? a.type);

export class MetroBridge {
  ws = null;
  since = 0;
  events = [];
  seq = 0;
  pending = new Map();
  mocks = [];
  capturing = false;
  failedAt = 0;

  constructor({ port = Number(process.env.TESTA_METRO_PORT || 8081), appId } = {}) {
    this.port = port;
    this.appId = appId;
  }

  get connected() { return this.ws?.readyState === WebSocket.OPEN; }

  /** Connect if needed. Cheap when already connected; backs off 5s after a failed attempt. */
  async ensure({ waitMs = 0 } = {}) {
    if (this.connected) return true;
    if (!waitMs && Date.now() - this.failedAt < 5000) return false;
    const until = Date.now() + waitMs;
    do {
      if (await this.connect().catch(() => false)) return true;
      if (Date.now() < until) await new Promise((r) => setTimeout(r, 1000));
    } while (Date.now() < until);
    this.failedAt = Date.now();
    return false;
  }

  async connect() {
    this.close();
    let targets;
    try {
      targets = await (await fetch(`http://localhost:${this.port}/json/list`, { signal: AbortSignal.timeout(1500) })).json();
    } catch { return false; } // Metro not running
    const t = targets.find((x) => (!this.appId || x.appId === this.appId) && /Bridgeless|Hermes|React Native/i.test(x.description ?? ''))
      ?? targets.find((x) => /Bridgeless|Hermes/i.test(x.description ?? ''));
    if (!t?.webSocketDebuggerUrl) return false;

    const ws = new WebSocket(t.webSocketDebuggerUrl);
    this.ws = ws;
    ws.onmessage = (m) => this.onMessage(JSON.parse(m.data));
    ws.onerror = () => {};
    await new Promise((res, rej) => { ws.onopen = res; setTimeout(() => rej(new Error('metro ws timeout')), 3000); }).catch(() => null);
    if (!this.connected) { this.close(); return false; }
    await this.send('Runtime.enable');
    await this.install();
    return true;
  }

  async install() {
    await this.eval(HOOKS).catch(() => {});
    if (this.mocks.length) await this.pushMocks();
  }

  send(method, params = {}) {
    if (!this.connected) return Promise.reject(new Error('metro not connected'));
    const id = ++this.seq;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      setTimeout(() => { if (this.pending.delete(id)) rej(new Error(`${method} timeout`)); }, 4000);
    });
  }

  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result?.value;
  }

  onMessage(d) {
    if (d.id && this.pending.has(d.id)) {
      const p = this.pending.get(d.id);
      this.pending.delete(d.id);
      return d.error ? p.rej(new Error(d.error.message)) : p.res(d.result);
    }
    if (d.method === 'Runtime.executionContextCreated') {
      // JS reloaded: re-arm hooks and mocks.
      this.install();
      return;
    }
    if (!this.capturing) return;
    const ts = d.params?.timestamp;
    if (d.method === 'Runtime.consoleAPICalled' && (d.params.type === 'error' || d.params.type === 'warning')) {
      if (ts < this.since) return; // Runtime.enable replays old messages
      const text = d.params.args.map(fmtArg).join(' ').replace(/\x1b\[[0-9;]*m/g, '')
        .replace(/,?\s*(stack|nativeStackIOS): [\s\S]*?(?=, \w+: |}$|$)/g, '').replace(/\n\s+at [\s\S]*/, '').slice(0, 300);
      if (!NOISE.test(text)) this.events.push({ kind: `rn.console.${d.params.type}`, text });
    } else if (d.method === 'Runtime.exceptionThrown') {
      const e = d.params.exceptionDetails;
      this.events.push({ kind: 'rn.exception', text: `${e.exception?.description ?? e.text}`.split('\n')[0].slice(0, 300) });
    }
  }

  /** Start capturing for a run. */
  async mark() {
    if (!(await this.ensure({ waitMs: 3000 }))) return false;
    this.events = [];
    this.since = Date.now();
    this.capturing = true;
    await this.eval('globalThis.__ftNet && (globalThis.__ftNet.length = 0)').catch(() => {});
    if (process.env.TESTA_HIDE_LOGBOX !== '0') await this.eval(logboxExpr(true)).catch(() => {});
    return true;
  }

  /** @returns {Promise<{events: object[], network: object[]}>} */
  async take() {
    let network = [];
    if (this.connected) {
      try {
        network = JSON.parse((await this.eval('JSON.stringify((globalThis.__ftNet || []).splice(0))')) || '[]')
          .filter((n) => n.at >= this.since && !STATIC.test(n.url));
      } catch { /* app reloaded mid-run */ }
      if (process.env.TESTA_HIDE_LOGBOX !== '0') await this.eval(logboxExpr(false)).catch(() => {});
    }
    this.capturing = false;
    const events = this.events.splice(0);
    for (const n of network) {
      if (!n.mocked && (n.status === 0 || n.status >= 400)) events.push({ kind: 'rn.http', text: `${n.status || 'FAILED'} ${n.method} ${n.url}${n.body ? ` — ${n.body}` : ''}` });
    }
    return { events, network: network.map(({ method, url, status, ms, mocked }) => ({ method, url, status, ms, mocked })) };
  }

  async navState() {
    if (!(await this.ensure())) return null;
    try { return JSON.parse(await this.eval(NAV_STATE)); } catch { return null; }
  }

  async navigate(screen, params) {
    if (!(await this.ensure({ waitMs: 15000 }))) throw new Error('Metro not reachable (is the dev server running?)');
    let r;
    for (let i = 0; i < 20; i++) { // app may still be mounting its navigator
      r = await this.eval(navigateExpr(screen, params));
      if (r === 'ok') break;
      await new Promise((res) => setTimeout(res, 500));
    }
    if (r !== 'ok') throw new Error('No React Navigation container ref found in the app');
  }

  /** @param {Array<{method?:string,url:string,regex?:boolean,status?:number,body?:any,headers?:object,delayMs?:number,times?:number,fail?:boolean}>} rules */
  async setMocks(rules) {
    this.mocks = rules.map((r) => ({ ...r, method: r.method?.toUpperCase(), hits: 0 }));
    if (await this.ensure()) await this.pushMocks();
  }

  pushMocks() {
    return this.eval(`(globalThis.__ftMocks = ${JSON.stringify(this.mocks)}, 'ok')`).catch(() => {});
  }

  async clearMocks() {
    this.mocks = [];
    if (this.connected) await this.eval('(globalThis.__ftMocks = [], "ok")').catch(() => {});
  }

  close() {
    try { this.ws?.close(); } catch {}
    this.ws = null;
    for (const p of this.pending.values()) p.rej(new Error('closed'));
    this.pending.clear();
  }
}
