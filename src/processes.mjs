// Dev servers / Metro / backends started by the agent: spawn, wait until ready, keep logs.
import { spawn } from 'node:child_process';
import { connect } from 'node:net';

const ERROR_LINE = /\b(error|exception|unhandled|failed|fatal|panic|traceback|ERR!)\b|\s5\d\d\s/i;
const MAX_LINES = 2000;
const procs = new Map();

const portOpen = (port, host = '127.0.0.1') => new Promise((res) => {
  const s = connect({ port, host }, () => { s.destroy(); res(true); });
  s.on('error', () => res(false));
  s.setTimeout(500, () => { s.destroy(); res(false); });
});

async function urlUp(url) {
  try { await fetch(url, { signal: AbortSignal.timeout(1500), redirect: 'manual' }); return true; } catch { return false; }
}

/**
 * @param {{name:string, command:string, cwd:string, port?:number, url?:string, readyPattern?:string, timeoutSec?:number, env?:Record<string,string>}} o
 */
export async function startApp({ name, command, cwd, port, url, readyPattern, timeoutSec = 120, env = {} }) {
  const existing = procs.get(name);
  if (existing && existing.exitCode === null) return { name, status: 'already running (managed)', pid: existing.child.pid };
  if ((port && await portOpen(port)) || (url && await urlUp(url))) {
    return { name, status: `already up on ${port ? `port ${port}` : url} (not managed: logs unavailable)` };
  }

  const child = spawn(command, { cwd, shell: true, detached: true, env: { ...process.env, FORCE_COLOR: '0', CI: '1', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const p = { name, command, cwd, child, lines: [], exitCode: null, startedAt: Date.now() };
  procs.set(name, p);
  const ready = readyPattern ? new RegExp(readyPattern, 'i') : null;
  let sawReady = false;
  const onData = (buf) => {
    for (const raw of buf.toString().split('\n')) {
      const line = raw.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').trimEnd();
      if (!line) continue;
      p.lines.push({ at: Date.now(), line: line.slice(0, 500) });
      if (p.lines.length > MAX_LINES) p.lines.shift();
      if (ready?.test(line)) sawReady = true;
    }
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  child.on('exit', (code) => { p.exitCode = code ?? -1; });

  const until = Date.now() + timeoutSec * 1000;
  while (Date.now() < until) {
    if (p.exitCode !== null) {
      return { name, status: `exited with code ${p.exitCode}`, tail: tail(name, 40) };
    }
    const up = (port ? await portOpen(port) : true) && (url ? await urlUp(url) : true) && (ready ? sawReady : true);
    if (up && (port || url || ready)) return { name, status: 'ready', pid: child.pid, ms: Date.now() - p.startedAt };
    if (!port && !url && !ready && Date.now() - p.startedAt > 3000) return { name, status: 'started (no readiness check given)', pid: child.pid };
    await new Promise((r) => setTimeout(r, 400));
  }
  return { name, status: `not ready after ${timeoutSec}s (still running)`, pid: child.pid, tail: tail(name, 30) };
}

export async function stopApp(name) {
  const p = procs.get(name);
  if (!p) return `no managed process "${name}"`;
  procs.delete(name);
  if (p.exitCode !== null) return `${name} had already exited (${p.exitCode})`;
  const exited = new Promise((r) => p.child.once('exit', r));
  try { process.kill(-p.child.pid, 'SIGTERM'); } catch {}
  const timeout = new Promise((r) => setTimeout(() => r('timeout'), 5000));
  if ((await Promise.race([exited, timeout])) === 'timeout') {
    try { process.kill(-p.child.pid, 'SIGKILL'); } catch {}
    await exited;
  }
  return `stopped ${name}`;
}

export function tail(name, n = 80, grep) {
  const p = procs.get(name);
  if (!p) return `no managed process "${name}"`;
  const re = grep ? new RegExp(grep, 'i') : null;
  return p.lines.filter((l) => !re || re.test(l.line)).slice(-n).map((l) => l.line).join('\n');
}

export function listApps() {
  return [...procs.values()].map((p) => `${p.name} pid=${p.child.pid} ${p.exitCode === null ? 'running' : `exited(${p.exitCode})`} — ${p.command} (${p.cwd})`);
}

/** Error-looking server log lines since `since` (ms), for scenario reports. */
export function errorsSince(since) {
  const out = [];
  for (const p of procs.values()) {
    for (const l of p.lines) if (l.at >= since && ERROR_LINE.test(l.line)) out.push({ kind: `log:${p.name}`, text: l.line.slice(0, 300) });
  }
  return out.slice(-30);
}

export function stopAll() {
  for (const p of procs.values()) { try { process.kill(-p.child.pid, 'SIGTERM'); } catch {} }
  procs.clear();
}
