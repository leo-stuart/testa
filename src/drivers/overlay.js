// testa overlay: injected into every page of a visible test run so a human can follow along.
// Agent cursor (glides to each target, presses on click), action label, target highlight,
// a status HUD and the "human needed" banner (captcha).
//
// Rules for this file (it runs inside apps we don't control):
// - DOM via createElement + CSSOM only: innerHTML and <style> break on Trusted Types / strict CSP (YouTube).
// - Lives in a shadow root on <html>, outside the app's React tree; re-mounts if removed.
// - pointer-events:none everywhere (never intercepts clicks or elementFromPoint); aria-hidden (out of a11y audits).
(() => {
  if (window.__testa) return;
  const KEY = '__testa_cursor';
  const C = { accent: '#6d7bff', ink: 'rgba(14,17,28,.92)', ok: '#16a34a', fail: '#e11d48', human: '#f59e0b', line: 'rgba(255,255,255,.12)' };
  const EASE = 'cubic-bezier(.45,0,.2,1)';
  const FONT = '-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,system-ui,sans-serif';

  const el = (tag, css, kids = [], ns) => {
    const e = ns ? document.createElementNS(ns, tag) : document.createElement(tag);
    if (css) e.style.cssText = css;
    e.append(...kids);
    return e;
  };
  const svgEl = (tag, attrs) => {
    const e = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    return e;
  };
  const pill = (extra = '') => 'display:flex;align-items:center;gap:8px;background:' + C.ink + ';color:#fff;border:1px solid ' + C.line + ';' +
    'border-radius:10px;box-shadow:0 10px 30px rgba(0,0,0,.28),0 2px 6px rgba(0,0,0,.18);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);' +
    'font:500 12.5px/1.2 ' + FONT + ';letter-spacing:-.005em;' + extra;

  let pos;
  try { pos = JSON.parse(sessionStorage.getItem(KEY)); } catch {}
  pos ||= { x: innerWidth * 0.5, y: innerHeight * 0.45 };

  // ── highlight box (glides between targets) ─────────────────────────────────
  const box = el('div', 'position:absolute;left:0;top:0;width:0;height:0;border:2px solid ' + C.accent + ';border-radius:8px;' +
    'background:rgba(79,107,255,.06);box-shadow:0 0 0 4px rgba(79,107,255,.16);opacity:0;' +
    'transition:left .32s ' + EASE + ',top .32s ' + EASE + ',width .32s ' + EASE + ',height .32s ' + EASE + ',opacity .18s,border-color .2s,box-shadow .2s;');

  // ── click ripple ───────────────────────────────────────────────────────────
  const ring = el('div', 'position:absolute;left:0;top:0;width:44px;height:44px;margin:-22px 0 0 -22px;border-radius:50%;' +
    'border:2px solid ' + C.accent + ';background:rgba(79,107,255,.15);opacity:0;');

  // ── cursor + label ─────────────────────────────────────────────────────────
  // Modern rounded pointer (Figma/Linear-style), gradient fill, crisp white edge. Tip at (5.6,5.6) px.
  const arrow = svgEl('svg', { width: 30, height: 30, viewBox: '0 0 24 24', overflow: 'visible' });
  const defs = svgEl('defs', {});
  const grad = svgEl('linearGradient', { id: 'testa-g', x1: 0, y1: 0, x2: 1, y2: 1 });
  grad.append(svgEl('stop', { offset: '0%', 'stop-color': '#6d8bff' }), svgEl('stop', { offset: '100%', 'stop-color': '#7b5cff' }));
  defs.append(grad);
  arrow.append(defs, svgEl('path', {
    d: 'M4.04 4.69a.5.5 0 0 1 .65-.65l16 6.5a.5.5 0 0 1-.06.95l-6.13 1.58a2 2 0 0 0-1.43 1.43l-1.58 6.13a.5.5 0 0 1-.95.06z',
    fill: 'url(#testa-g)', stroke: '#fff', 'stroke-width': 1.6, 'stroke-linejoin': 'round',
  }));
  arrow.style.cssText = 'display:block;filter:drop-shadow(0 4px 10px rgba(79,70,229,.35)) drop-shadow(0 1px 2px rgba(15,18,40,.3));transform-origin:5.6px 5.6px;';
  // Tag attached to the pointer, same color: verb chip + element name.
  const verb = el('span', 'background:rgba(255,255,255,.22);color:#fff;border-radius:5px;padding:3px 6px;font:700 9.5px/1 ' + FONT + ';letter-spacing:.07em;text-transform:uppercase;');
  const name = el('span', 'max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600;');
  const dots = el('span', 'display:none;gap:3px;align-items:center;margin-left:-2px;', [0, 1, 2].map(() => el('i', 'width:4px;height:4px;border-radius:50%;background:#fff;opacity:.3;display:block;')));
  const label = el('div', 'position:absolute;left:23px;top:26px;display:flex;align-items:center;gap:7px;padding:4px 10px 4px 4px;white-space:nowrap;opacity:0;' +
    'background:linear-gradient(135deg,#6d8bff,#7b5cff);color:#fff;border-radius:3px 11px 11px 11px;' +
    'box-shadow:0 6px 18px rgba(79,70,229,.35),inset 0 0 0 1px rgba(255,255,255,.18);font:500 12.5px/1.2 ' + FONT + ';letter-spacing:-.005em;', [verb, name, dots]);
  const cur = el('div', 'position:absolute;left:0;top:0;will-change:transform;', [arrow, label]);
  let dotAnims = [];

  // ── status HUD (bottom-left) ───────────────────────────────────────────────
  const hudDot = el('span', 'width:8px;height:8px;border-radius:50%;background:' + C.accent + ';flex:none;');
  const hudText = el('span', 'max-width:420px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;opacity:.92;');
  const hud = el('div', pill('position:absolute;left:16px;bottom:16px;padding:8px 12px;opacity:0;transition:opacity .2s;'),
    [hudDot, el('b', 'font-weight:700;letter-spacing:-.01em;', ['testa']), el('span', 'opacity:.35;', ['·']), hudText]);
  let hudPulse;

  // ── human-needed banner (top-center) ───────────────────────────────────────
  const bTitle = el('div', 'font:700 14px/1.3 ' + FONT + ';');
  const bText = el('div', 'opacity:.8;margin-top:3px;');
  const bTime = el('div', 'margin-left:auto;font:600 13px/1 ui-monospace,SFMono-Regular,Menlo,monospace;color:' + C.human + ';padding-left:16px;');
  const bIcon = el('div', 'width:30px;height:30px;border-radius:8px;background:rgba(245,158,11,.18);color:' + C.human + ';display:grid;place-items:center;font:800 16px/1 ' + FONT + ';flex:none;', ['!']);
  const banner = el('div', pill('position:absolute;left:50%;top:16px;transform:translate(-50%,-8px);padding:12px 16px 12px 12px;gap:12px;min-width:380px;max-width:min(560px,calc(100vw - 32px));' +
    'border-left:3px solid ' + C.human + ';opacity:0;transition:opacity .2s,transform .2s ' + EASE + ';'), [bIcon, el('div', '', [bTitle, bText]), bTime]);
  let bTimer;

  const host = el('testa-overlay', 'all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483647;');
  host.setAttribute('aria-hidden', 'true');
  host.attachShadow({ mode: 'open' }).append(box, ring, cur, hud, banner);

  // Init scripts run before <html> exists: mount once it does, and again if the app removes us.
  const mount = () => { const d = document.documentElement; if (d && !host.isConnected) d.append(host); };
  const watch = new MutationObserver(mount);
  watch.observe(document, { childList: true });
  const watchHtml = () => { mount(); if (document.documentElement) watch.observe(document.documentElement, { childList: true }); };
  watchHtml();
  document.addEventListener('DOMContentLoaded', watchHtml);

  const place = (ms) => {
    cur.style.transition = ms ? 'transform ' + ms + 'ms ' + EASE : 'none';
    cur.style.transform = 'translate(' + (pos.x - 5.6) + 'px,' + (pos.y - 5.6) + 'px)';
    try { sessionStorage.setItem(KEY, JSON.stringify(pos)); } catch {}
  };
  place(0);

  addEventListener('mousedown', (e) => {
    ring.style.left = e.clientX + 'px';
    ring.style.top = e.clientY + 'px';
    ring.animate([{ opacity: 0.9, transform: 'scale(.35)' }, { opacity: 0, transform: 'scale(1.5)' }], { duration: 520, easing: 'cubic-bezier(.2,.7,.3,1)' });
    arrow.animate([{ transform: 'scale(1)' }, { transform: 'scale(.82)' }, { transform: 'scale(1)' }], { duration: 260, easing: EASE });
    box.animate([{ boxShadow: '0 0 0 4px rgba(79,107,255,.16)' }, { boxShadow: '0 0 0 9px rgba(79,107,255,.08)' }, { boxShadow: '0 0 0 4px rgba(79,107,255,.16)' }], { duration: 380 });
  }, true);

  const setDots = (on) => {
    dotAnims.forEach((a) => a.cancel());
    dotAnims = [];
    dots.style.display = on ? 'inline-flex' : 'none';
    if (on) [...dots.children].forEach((d, i) => dotAnims.push(d.animate([{ opacity: 0.25 }, { opacity: 1 }, { opacity: 0.25 }], { duration: 900, delay: i * 150, iterations: Infinity })));
  };

  window.__testa = {
    pos: () => pos,
    /** Glide to (x,y) in ms; show "VERB name" and frame `rect` ({x,y,width,height,radius}). */
    move(x, y, ms, v, n, rect) {
      pos = { x, y };
      verb.textContent = v || '';
      name.textContent = n || '';
      name.style.display = n ? '' : 'none';
      setDots(/^digit|^type/i.test(v || ''));
      const flip = x > innerWidth - 340; // keep the label on screen near the right edge
      label.style.left = flip ? 'auto' : '23px';
      label.style.right = flip ? '8px' : 'auto';
      label.style.borderRadius = flip ? '11px 3px 11px 11px' : '3px 11px 11px 11px';
      if (v) label.animate([{ opacity: 0, transform: 'translateY(4px) scale(.97)' }, { opacity: 1, transform: 'none' }], { duration: 200, delay: Math.max(0, ms - 220), fill: 'forwards', easing: EASE });
      if (rect) {
        Object.assign(box.style, {
          left: rect.x - 4 + 'px', top: rect.y - 4 + 'px', width: rect.width + 8 + 'px', height: rect.height + 8 + 'px',
          borderRadius: Math.min(16, (rect.radius || 4) + 4) + 'px', opacity: 1, borderColor: C.accent,
        });
      } else box.style.opacity = 0;
      place(ms);
    },
    clear() {
      box.style.opacity = 0;
      setDots(false);
      label.getAnimations().forEach((a) => a.cancel());
      label.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, fill: 'forwards' });
    },
    /** tone: run | ok | fail | human */
    hud(text, tone = 'run') {
      hudText.textContent = text;
      hudDot.style.background = { run: C.accent, ok: C.ok, fail: C.fail, human: C.human }[tone] || C.accent;
      hud.style.opacity = 1;
      hudPulse?.cancel();
      // Calm "alive" signal: fade only, nothing changes size.
      if (tone === 'run' || tone === 'human') hudPulse = hudDot.animate([{ opacity: 1 }, { opacity: 0.35 }, { opacity: 1 }], { duration: 1600, iterations: Infinity });
    },
    /** Show/hide the "human needed" banner; frame `rect` in amber; count down to `deadline` (epoch ms). */
    human(on, opts = {}) {
      clearInterval(bTimer);
      if (!on) {
        banner.style.opacity = 0;
        banner.style.transform = 'translate(-50%,-8px)';
        box.style.opacity = 0;
        box.style.borderColor = C.accent;
        box.style.boxShadow = '0 0 0 4px rgba(79,107,255,.16)';
        return;
      }
      bTitle.textContent = opts.title || 'Precisa de você';
      bText.textContent = opts.text || '';
      banner.style.opacity = 1;
      banner.style.transform = 'translate(-50%,0)';
      const tick = () => {
        const s = Math.max(0, Math.round(((opts.deadline || 0) - Date.now()) / 1000));
        bTime.textContent = opts.deadline ? Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0') : '';
      };
      tick();
      bTimer = setInterval(tick, 1000);
      if (opts.rect) {
        const r = opts.rect;
        // Static frame: no looping size/glow animation around the captcha.
        Object.assign(box.style, { left: r.x - 6 + 'px', top: r.y - 6 + 'px', width: r.width + 12 + 'px', height: r.height + 12 + 'px', borderRadius: '10px', opacity: 1, borderColor: C.human, boxShadow: '0 0 0 4px rgba(245,158,11,.22)' });
      }
    },
    /** Hide everything (for clean evidence screenshots). */
    visible(on) { host.style.visibility = on ? 'visible' : 'hidden'; },
  };
})();
