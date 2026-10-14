// iOS Simulator driver. Reads the accessibility tree with AXe; taps/swipes through WebDriverAgent
// when available (~0.5s vs ~1s per AXe process), typing through one batched AXe call.
// React Native dev builds also get route/navigation/mocks/logs through Metro.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { axePath, wdaAppPath } from '../paths.mjs';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { MetroBridge } from './metro.mjs';

const run = promisify(execFile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (s) => createHash('sha1').update(s).digest('hex');

const WDA_BUNDLE = 'com.facebook.WebDriverAgentRunner.xctrunner';
const wdaUrl = () => process.env.TESTA_WDA_URL || 'http://127.0.0.1:8100';

const INTERACTIVE = new Set([
  'Button', 'Link', 'TextField', 'SecureTextField', 'TextView', 'SearchField', 'Switch', 'Toggle',
  'Slider', 'Cell', 'Tab', 'RadioButton', 'CheckBox', 'PopUpButton', 'MenuItem', 'Incrementor',
]);
const TEXT_INPUTS = new Set(['TextField', 'SecureTextField', 'TextView', 'SearchField']);
// Scroll indicators and the iOS keyboard AutoFill bar are never what a test wants to tap.
const SYSTEM_NOISE = /barra de rolagem|scroll bar|^(Preenchimento Automático|AutoFill|Senhas|Passwords)$/i;
const LOGBOX = /\b(Render Error|Console Error|Uncaught Error|Syntax Error|Failed to compile)\b/;
const LOADING = /progress indicator|activity indicator|"AXLabel" : "(?:Carregando|Loading|Aguarde)/i;

const PLACEHOLDER = /^(digite|insira|informe|escreva|preencha|enter|type|search|buscar|pesquis)/i;
const INPUT_MASK = /^[0_9#X\s().\/-]{4,}$|^(DD|MM|AAAA|YYYY)[\/-]/i; // "00000-000", "(00) 00000-0000", "__/__/____", "DD/MM/AAAA"
const FIELD_LABEL = /^[A-Za-zÀ-ú][A-Za-zÀ-ú\s\/().,-]{1,40}$/; // "CEP", "E-mail ou CPF", "Número"
const ICON_GLYPHS = /[\uE000-\uF8FF]/g; // icon fonts (Ionicons, FontAwesome...) use the private-use area
const HAS_ICON = /[\uE000-\uF8FF]/;

const cleanLabel = (s) => (s ?? '').toString().replace(ICON_GLYPHS, '').replace(/\s+/g, ' ').replace(/^[,\s]+|[,\s]+$/g, '').trim();
const position = (f, W, H) => `${f.y < H * 0.2 ? 'top' : f.y > H * 0.8 ? 'bottom' : 'middle'}-${f.x + f.width / 2 < W * 0.33 ? 'left' : f.x + f.width / 2 > W * 0.66 ? 'right' : 'center'}`;

/**
 * Turn an AXe describe-ui tree into actionable elements. Pure, so heuristics are testable on fixtures.
 * @returns {{title:string, elements:object[], text:string, hidden:number, a11y:object[], W:number, H:number}}
 */
export function parseIosTree(roots) {
  const app = roots[0] ?? {};
  const W = app.frame?.width ?? 402;
  const H = app.frame?.height ?? 874;

  const interactive = [];
  const texts = [];
  const textLines = [];
  const a11y = [];

  // RN apps often wrap TextInput in an accessible View, hiding the field. Field-sized boxes that
  // are empty or show a placeholder, right under a label, are treated as inputs and named by it.
  const labels = []; // one-line texts seen so far (document order = top-down)
  const labelAbove = (f) => {
    let best = null;
    for (const l of labels) {
      const gap = f.y - (l.f.y + l.f.height);
      const overlap = Math.min(f.x + f.width, l.f.x + l.f.width) - Math.max(f.x, l.f.x);
      const header = l.label.length > 4 && l.label === l.label.toUpperCase();
      if (gap >= -2 && gap < 30 && overlap > 10 && FIELD_LABEL.test(l.label) && !header && (!best || gap < best.gap)) best = { gap, label: l.label };
    }
    return best?.label ?? '';
  };
  const looksLikeField = (type, label, f) => {
    if (!(type === 'GenericElement' || type === 'StaticText') || !f || f.height < 34 || f.height > 64 || f.width < W * 0.3) return false;
    if (PLACEHOLDER.test(label) || INPUT_MASK.test(label)) return true;
    if (!label) return Boolean(labelAbove(f));
    // Short text inside a field-sized box under a label: a placeholder like "123" or "Apto, Bloco...".
    return label.length <= 24 && !/R\$|%|\d{2}\/\d{2}/.test(label) && Boolean(labelAbove(f));
  };

  // Layers: full-screen siblings later in the tree render on top (modals, sheets, stacked screens).
  const fullScreen = (f) => f && f.width >= W * 0.95 && f.height >= H * 0.9;
  const layerInfo = new Map();
  const cmpLayer = (a, b) => { for (let i = 0; i < Math.max(a.length, b.length); i++) { const d = (a[i] ?? -1) - (b[i] ?? -1); if (d) return d; } return 0; };
  const isPrefix = (a, b) => a.length <= b.length && a.every((v, i) => v === b[i]);

  const walk = (node, insideInteractive, ctx, layer) => {
    const type = node.type ?? node.role?.replace(/^AX/, '');
    const rawLabel = (node.AXLabel ?? node.title ?? '').toString();
    const label = cleanLabel(rawLabel);
    const value = node.AXValue == null ? '' : String(node.AXValue).trim();
    const f = node.frame;
    const lk = layer.join('.');
    if (!layerInfo.has(lk)) layerInfo.set(lk, { layer, backdrop: false, box: null });
    // RN modals/sheets mount a dimming view much larger than the screen.
    if (f && f.width > W * 1.5 && f.height > H * 1.5 && !(node.children?.length)) layerInfo.get(lk).backdrop = true;
    if (label) textLines.push(label);
    else if (value && !TEXT_INPUTS.has(type)) textLines.push(value);

    const visible = f && f.width > 1 && f.height > 1 && f.x < W && f.y < H && f.x + f.width > 0 && f.y + f.height > 0;
    const fieldGuess = visible && looksLikeField(type, label, f);
    // Icon-font-only buttons (back arrows, close X) have a label made purely of glyphs.
    const iconOnly = visible && !label && HAS_ICON.test(rawLabel) && f.width <= 64 && f.height <= 64 && type !== 'StaticText';
    const above = fieldGuess ? labelAbove(f) : '';
    const isInteractive = (INTERACTIVE.has(type) || fieldGuess || iconOnly) && node.enabled !== false && !SYSTEM_NOISE.test(label);
    const name = (fieldGuess ? [above, label].filter(Boolean).join(' — ')
      : iconOnly ? `icon button @${position(f, W, H)}`
        : label || value || node.AXUniqueId || '').slice(0, 80);
    if (type === 'StaticText' && label && f && f.height <= 24 && !fieldGuess) labels.push({ label, f });
    const el = visible && {
      kind: fieldGuess ? 'TextField?' : iconOnly ? 'IconButton?' : type, name,
      value: TEXT_INPUTS.has(type) && type !== 'SecureTextField' ? value.slice(0, 60) : undefined,
      testId: node.AXUniqueId || undefined,
      ctx: ctx && ctx !== name ? ctx : undefined,
      x: Math.round(f.x), y: Math.round(f.y), w: Math.round(f.width), h: Math.round(f.height),
      layer,
    };
    const grow = () => {
      const li = layerInfo.get(lk);
      const b = { x1: Math.max(0, f.x), y1: Math.max(0, f.y), x2: Math.min(W, f.x + f.width), y2: Math.min(H, f.y + f.height) };
      li.box = li.box ? { x1: Math.min(li.box.x1, b.x1), y1: Math.min(li.box.y1, b.y1), x2: Math.max(li.box.x2, b.x2), y2: Math.max(li.box.y2, b.y2) } : b;
    };
    if (el && isInteractive) {
      interactive.push(el);
      grow();
      if (fieldGuess) a11y.push({ rule: 'input-not-exposed', name, layer, hint: 'TextInput is hidden inside an accessible wrapper: set accessible={false} on the wrapper or label the TextInput (accessibilityLabel)' });
      else if (iconOnly) a11y.push({ rule: 'icon-without-label', name, layer, hint: 'Icon-only control: add accessibilityLabel (and accessibilityRole="button")' });
      else if (!label && !value) a11y.push({ rule: 'missing-label', name: name || `${type} @${position(f, W, H)}`, layer, hint: 'Interactive element without an accessible name' });
    } else if (el && !insideInteractive && label && type !== 'Application' && !SYSTEM_NOISE.test(label) && f.width < W * 0.98) {
      // Labeled non-interactive nodes (RN Pressables without a role often land here).
      texts.push({ ...el, kind: type === 'StaticText' ? 'text' : type });
      grow();
    }
    // A labeled container or heading names the section its children live in.
    const namesSection = type === 'Heading' || (type !== 'Application' && !isInteractive && label && (node.children?.length ?? 0) > 1);
    const childCtx = namesSection ? label.slice(0, 40) : ctx;
    const kids = node.children ?? [];
    const isLayerNode = (c) => fullScreen(c.frame) || (c.frame && c.frame.width > W * 1.5);
    const stacked = kids.filter(isLayerNode).length >= 2;
    let z = 0;
    for (const c of kids) walk(c, insideInteractive || isInteractive, childCtx, stacked && isLayerNode(c) ? [...layer, z++] : layer);
  };
  for (const r of roots) walk(r, false, undefined, []);

  // Drop elements covered by a higher layer: all of them under a modal backdrop,
  // otherwise those whose center falls inside the higher layer's content box.
  const layers = [...layerInfo.values()].filter((l) => l.box || l.backdrop);
  const covered = (e) => layers.some((l) => cmpLayer(l.layer, e.layer) > 0 && !isPrefix(l.layer, e.layer) && !isPrefix(e.layer, l.layer) && (l.backdrop
    || (l.box && e.x + e.w / 2 >= l.box.x1 && e.x + e.w / 2 <= l.box.x2 && e.y + e.h / 2 >= l.box.y1 && e.y + e.h / 2 <= l.box.y2)));
  let hidden = 0;
  const keep = (e) => { if (covered(e)) { hidden++; return false; } return true; };

  // RN nests views that repeat the same label; keep one per name+position.
  const seen = new Set();
  const unique = [...interactive.filter(keep), ...texts.filter(keep)].filter((e) => {
    const k = `${e.name}|${Math.round(e.y / 8)}`;
    if (!e.name || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const elements = unique.slice(0, 240).map(({ layer, ...e }, i) => ({ id: `e${i}`, ...e }));
  const visibleA11y = a11y.filter((i) => !layers.some((l) => l.backdrop && cmpLayer(l.layer, i.layer) > 0 && !isPrefix(l.layer, i.layer) && !isPrefix(i.layer, l.layer)))
    .map(({ layer, ...i }) => i);
  const missingTestIds = elements.filter((e) => e.kind !== 'text' && !e.testId).length;
  return { title: app.AXLabel ?? '', elements, text: textLines.join('\n').slice(0, 3000), hidden, a11y: visibleA11y, missingTestIds, W, H };
}

function spawnWithInput(cmd, args, input) {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, (err, stdout) => (err ? reject(err) : resolve(stdout)));
    child.stdin.end(input);
  });
}

/** WebDriverAgent client for fast touch input (W3C actions ≈ 0.5s per tap). */
class Wda {
  sid = null;
  async req(method, path, body) {
    const r = await fetch(wdaUrl() + path, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body), signal: AbortSignal.timeout(15000) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`WDA ${r.status}: ${JSON.stringify(j.value ?? j).slice(0, 200)}`);
    return j;
  }
  async up() {
    try { await fetch(`${wdaUrl()}/status`, { signal: AbortSignal.timeout(800) }); return true; } catch { return false; }
  }
  async session() {
    if (this.sid) return this.sid;
    const j = await this.req('POST', '/session', { capabilities: { alwaysMatch: { shouldWaitForQuiescence: false } } });
    this.sid = j.sessionId ?? j.value?.sessionId;
    await this.req('POST', `/session/${this.sid}/appium/settings`, { settings: { waitForIdleTimeout: 0, animationCoolOffTimeout: 0 } }).catch(() => {});
    return this.sid;
  }
  async pointer(steps) {
    const sid = await this.session();
    try {
      await this.req('POST', `/session/${sid}/actions`, { actions: [{ type: 'pointer', id: 'f1', parameters: { pointerType: 'touch' }, actions: steps }] });
    } catch (e) {
      if (/session/i.test(e.message)) { this.sid = null; return this.pointer(steps); }
      throw e;
    }
  }
  tap(x, y) {
    return this.pointer([{ type: 'pointerMove', duration: 0, x, y }, { type: 'pointerDown', button: 0 }, { type: 'pause', duration: 30 }, { type: 'pointerUp', button: 0 }]);
  }
  swipe(x1, y1, x2, y2, ms = 300) {
    return this.pointer([{ type: 'pointerMove', duration: 0, x: x1, y: y1 }, { type: 'pointerDown', button: 0 }, { type: 'pointerMove', duration: ms, x: x2, y: y2 }, { type: 'pointerUp', button: 0 }]);
  }
}

export class IosDriver {
  kind = 'ios';
  udid = null;
  bundleId = null;
  screen = { w: 402, h: 874 };
  events = [];
  stableTree = null; // raw describe-ui captured by settle(), reused by the next observe()
  lastHash = '';
  metro = null;
  wda = null; // set when WebDriverAgent is usable
  wdaChecked = false;
  since = null;

  async axe(...args) {
    const { stdout } = await run(axePath(), [...args, '--udid', this.udid], { maxBuffer: 64 << 20, timeout: 20000 });
    return stdout;
  }

  async ensure({ udid } = {}) {
    if (udid) this.udid = udid;
    if (!this.udid) {
      const { stdout } = await run('xcrun', ['simctl', 'list', 'devices', 'booted', '-j']);
      const booted = Object.values(JSON.parse(stdout).devices).flat().find((d) => d.state === 'Booted');
      if (!booted) throw new Error('No booted iOS simulator. Boot one (open -a Simulator) or pass udid.');
      this.udid = booted.udid;
    }
    this.metro ??= new MetroBridge({ appId: this.bundleId ?? undefined });
  }

  /** Start WebDriverAgent once (installs the vendored runner); fall back to AXe input on any failure. */
  async ensureWda() {
    if (this.wdaChecked || process.env.TESTA_IOS_INPUT === 'axe') return this.wda;
    this.wdaChecked = true;
    const w = new Wda();
    try {
      if (!(await w.up())) {
        if (!existsSync(wdaAppPath())) return null;
        await run('xcrun', ['simctl', 'install', this.udid, wdaAppPath()]);
        await run('xcrun', ['simctl', 'launch', this.udid, WDA_BUNDLE]);
        for (let i = 0; i < 40 && !(await w.up()); i++) await sleep(500);
        if (!(await w.up())) return null;
        // Launching the runner brings it to the foreground; give the app under test the screen back.
        if (this.bundleId) await run('xcrun', ['simctl', 'launch', this.udid, this.bundleId]).catch(() => {});
        await sleep(800);
      }
      await w.session();
      this.wda = w;
    } catch (e) {
      console.error(`[testa] WDA unavailable, using AXe input: ${e.message}`);
    }
    return this.wda;
  }

  async open({ udid, bundleId, url, relaunch = false }) {
    if (bundleId && bundleId !== this.bundleId) { this.bundleId = bundleId; this.metro?.close(); this.metro = null; }
    await this.ensure({ udid });
    if (url) {
      await run('xcrun', ['simctl', 'openurl', this.udid, url]);
    } else if (bundleId) {
      if (relaunch) await run('xcrun', ['simctl', 'terminate', this.udid, bundleId]).catch(() => {});
      await run('xcrun', ['simctl', 'launch', this.udid, bundleId]);
    }
    await this.settle({ minMs: relaunch ? 1200 : 400, maxMs: relaunch ? 8000 : 3000 });
  }

  /** React Navigation: jump straight to a screen (works even when deep links are disabled). */
  async navigate(screen, params) {
    await this.ensure();
    await this.metro.navigate(screen, params);
    await this.settle({ minMs: 500, maxMs: 4000 });
  }

  async setMocks(rules) { await this.ensure(); await this.metro.setMocks(rules); }
  async clearMocks() { await this.metro?.clearMocks(); }

  async markEvents() {
    await this.ensure();
    this.events = [];
    this.since = new Date();
    this.metroOn = await this.metro.mark();
  }

  /** @returns {Promise<{events: object[], network: object[], source: string}>} */
  async takeEvents() {
    const events = this.events.splice(0);
    if (this.metroOn) {
      this.metroOn = false;
      const r = await this.metro.take();
      return { events: [...events, ...r.events], network: r.network, source: 'metro' };
    }
    // No Metro (release build or not running): fall back to the unified log.
    if (this.since) {
      const start = this.since.toISOString().replace('T', ' ').slice(0, 19);
      try {
        const { stdout } = await run('xcrun', [
          'simctl', 'spawn', this.udid, 'log', 'show', '--style', 'compact', '--start', start, '--timezone', 'UTC',
          '--predicate', 'subsystem == "com.facebook.react.log" AND (messageType == error OR messageType == fault)',
        ], { timeout: 8000, maxBuffer: 16 << 20 });
        for (const line of stdout.split('\n').slice(1).filter(Boolean).slice(-30)) events.push({ kind: 'rn.log', text: line.slice(0, 400) });
      } catch { /* best-effort */ }
    }
    return { events, network: [], source: 'oslog' };
  }

  async rawTree() {
    const cached = this.stableTree;
    this.stableTree = null;
    const raw = cached ?? (await this.axe('describe-ui'));
    this.lastHash = sha(raw);
    return JSON.parse(raw);
  }

  async observe() {
    await this.ensure();
    const parsed = parseIosTree(await this.rawTree());
    this.screen = { w: parsed.W, h: parsed.H };
    if (LOGBOX.test(parsed.text)) this.events.push({ kind: 'logbox', text: parsed.text.match(new RegExp(`.*${LOGBOX.source}.*`))?.[0] ?? 'LogBox visible' });
    const nav = await this.metro.navState();
    const route = nav?.route;
    return {
      title: parsed.title,
      where: route ? `route:${route.name}` : `sim:${this.udid}`,
      route, routeNames: nav?.routeNames,
      elements: parsed.elements, text: parsed.text, vh: parsed.H, hidden: parsed.hidden,
      a11y: parsed.a11y, missingTestIds: parsed.missingTestIds,
    };
  }

  /**
   * Wait for the UI to react: accept the first read that differs from the pre-action tree
   * and shows no spinner, else keep polling until maxMs. One describe-ui (~0.6s) in the common case.
   */
  async settle({ minMs = 300, maxMs = 2500 } = {}) {
    const before = this.lastHash;
    const until = Date.now() + maxMs;
    await sleep(minMs);
    while (true) {
      const raw = await this.axe('describe-ui').catch(() => '');
      if (raw && sha(raw) !== before && !LOADING.test(raw)) { this.stableTree = raw; return; }
      if (Date.now() >= until) { this.stableTree = raw || null; return; }
    }
  }

  /** Tap a field, select-all, then enter text, all in one AXe process. */
  async tapAndType(x, y, value) {
    const text = String(value);
    const head = [`tap -x ${x} -y ${y}`, 'sleep 0.25', 'key-combo --modifiers 227 --key 4'];
    if (/^[\x20-\x7e]*$/.test(text) && !text.includes("'")) {
      await spawnWithInput(axePath(), ['batch', '--udid', this.udid, '--stdin'], [...head, `type '${text}'`].join('\n') + '\n');
    } else {
      // AXe only types US-keyboard chars (and batch lines are shell-quoted): paste anything else.
      await spawnWithInput('xcrun', ['simctl', 'pbcopy', this.udid], text);
      await spawnWithInput(axePath(), ['batch', '--udid', this.udid, '--stdin'], [...head, 'key-combo --modifiers 227 --key 25'].join('\n') + '\n');
    }
  }

  async tap(x, y) {
    const wda = await this.ensureWda();
    if (wda) { try { return await wda.tap(x, y); } catch (e) { console.error(`[testa] WDA tap failed, AXe fallback: ${e.message}`); } }
    await this.axe('tap', '-x', String(x), '-y', String(y));
  }

  async swipe(x1, y1, x2, y2) {
    const wda = await this.ensureWda();
    if (wda) { try { return await wda.swipe(x1, y1, x2, y2); } catch { /* fall back */ } }
    await this.axe('swipe', '--start-x', `${x1}`, '--start-y', `${y1}`, '--end-x', `${x2}`, '--end-y', `${y2}`, '--duration', '0.3');
  }

  async act({ action, el, value }) {
    const { w: W, h: H } = this.screen;
    const cx = el && Math.round(el.x + el.w / 2);
    const cy = el && Math.round(el.y + el.h / 2);
    switch (action) {
      case 'tap': await this.tap(cx, cy); break;
      case 'type': await this.tapAndType(cx, cy, value); break;
      case 'submit': await this.axe('key', '40'); break;
      case 'scroll_down': await this.swipe(W / 2, H * 0.7, W / 2, H * 0.3); break;
      case 'scroll_up': await this.swipe(W / 2, H * 0.3, W / 2, H * 0.7); break;
      case 'back': await this.swipe(2, H / 2, W * 0.7, H / 2); break;
      case 'wait': await sleep(800); break;
      default: throw new Error(`ios: unknown action ${action}`);
    }
    await this.settle();
  }

  async screenshot(path) {
    await this.axe('screenshot', '--output', path);
    return path;
  }

  async close() {
    this.metro?.close();
  }
}
