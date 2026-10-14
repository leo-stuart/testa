// Installation pieces used by the `testa` CLI: agent registration, tool downloads, health checks.
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, copyFileSync, mkdtempSync } from 'node:fs';
import { homedir, tmpdir, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { cacheDir, axePath, wdaAppPath } from './paths.mjs';
import { resolveSettings, CONFIG_FILE } from './settings.mjs';

const run = promisify(execFile);
const require = createRequire(import.meta.url);
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SERVER = join(ROOT, 'src', 'server.mjs');
const SKILL = join(ROOT, 'skill', 'testa');
const H = homedir();

// Pinned tool versions (each at least two weeks old when pinned).
export const AXE_VERSION = 'v1.8.0';
export const WDA_VERSION = 'v16.13.6';

const has = (cmd) => { try { execFileSync('which', [cmd], { stdio: 'ignore' }); return true; } catch { return false; } };
const backup = (f) => existsSync(f) && copyFileSync(f, `${f}.bak-testa`);

/** Register (or remove) the MCP server + skill in Claude Code, Codex and Cursor, user scope. Idempotent. */
export function installAgents({ uninstall = false, log = console.log } = {}) {
  const node = process.execPath;
  if (has('claude')) {
    try { execFileSync('claude', ['mcp', 'remove', '--scope', 'user', 'testa'], { stdio: 'ignore' }); } catch {}
    if (!uninstall) execFileSync('claude', ['mcp', 'add', '--scope', 'user', 'testa', '--', node, SERVER], { stdio: 'ignore' });
    const dst = join(H, '.claude', 'skills', 'testa');
    rmSync(dst, { recursive: true, force: true });
    if (!uninstall) cpSync(SKILL, dst, { recursive: true });
    log(`  Claude Code: ${uninstall ? 'removed' : 'MCP + skill installed'}`);
  } else log('  Claude Code: not found (skipped)');

  const codexCfg = join(H, '.codex', 'config.toml');
  if (existsSync(dirname(codexCfg))) {
    backup(codexCfg);
    let toml = existsSync(codexCfg) ? readFileSync(codexCfg, 'utf8') : '';
    toml = toml.replace(/\n?# >>> testa[\s\S]*?# <<< testa\n?/, '\n');
    if (!uninstall) {
      toml = `${toml.trimEnd()}\n\n# >>> testa\n[mcp_servers.testa]\ncommand = ${JSON.stringify(node)}\nargs = [${JSON.stringify(SERVER)}]\nstartup_timeout_sec = 30\ntool_timeout_sec = 600\n# <<< testa\n`;
    }
    writeFileSync(codexCfg, toml);
    const dst = join(H, '.codex', 'skills', 'testa');
    rmSync(dst, { recursive: true, force: true });
    if (!uninstall) cpSync(SKILL, dst, { recursive: true });
    log(`  Codex: ${uninstall ? 'removed' : 'MCP + skill installed'}`);
  } else log('  Codex: not found (skipped)');

  const cursorCfg = join(H, '.cursor', 'mcp.json');
  if (existsSync(dirname(cursorCfg))) {
    backup(cursorCfg);
    const json = existsSync(cursorCfg) ? JSON.parse(readFileSync(cursorCfg, 'utf8') || '{}') : {};
    json.mcpServers ??= {};
    delete json.mcpServers['testa'];
    if (!uninstall) json.mcpServers['testa'] = { command: node, args: [SERVER], env: { TESTA_PROJECT_DIR: '${workspaceFolder}' } };
    writeFileSync(cursorCfg, JSON.stringify(json, null, 2) + '\n');
    log(`  Cursor: ${uninstall ? 'removed' : 'MCP installed (workflow comes from the server instructions)'}`);
  } else log('  Cursor: not found (skipped)');
}

async function download(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download ${url}: ${res.status}`);
  writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

export async function installChromium() {
  const cli = require.resolve('playwright/cli.js');
  await run(process.execPath, [cli, 'install', 'chromium'], { maxBuffer: 16 << 20 });
}

export async function installAxe() {
  const dir = join(cacheDir(), 'axe');
  const tmp = mkdtempSync(join(tmpdir(), 'ft-axe-'));
  try {
    await download(`https://github.com/cameroncooke/AXe/releases/download/${AXE_VERSION}/AXe-macOS-${AXE_VERSION}-universal.tar.gz`, join(tmp, 'axe.tgz'));
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    await run('tar', ['xzf', join(tmp, 'axe.tgz'), '-C', dir]);
    await run('xattr', ['-dr', 'com.apple.quarantine', dir]).catch(() => {});
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

export async function installWda() {
  const dir = join(cacheDir(), 'wda');
  const arch = process.arch === 'arm64' ? 'arm64' : 'x86_64';
  const tmp = mkdtempSync(join(tmpdir(), 'ft-wda-'));
  try {
    await download(`https://github.com/appium/WebDriverAgent/releases/download/${WDA_VERSION}/WebDriverAgentRunner-Build-Sim-${arch}.zip`, join(tmp, 'wda.zip'));
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    await run('unzip', ['-q', join(tmp, 'wda.zip'), '-d', dir]);
    await run('xattr', ['-dr', 'com.apple.quarantine', dir]).catch(() => {});
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

/** Health checks: [{ name, ok, detail, fix? }] */
export async function doctor() {
  const out = [];
  const add = (name, ok, detail, fix) => out.push({ name, ok, detail, fix });
  const settings = Object.fromEntries(resolveSettings(process.env.TESTA_PROJECT_DIR).map((s) => [s.name, s]));

  add('node', Number(process.versions.node.split('.')[0]) >= 20, process.version, 'install Node 20+');

  const key = settings.jevApiKey.value;
  if (!key) add('jev key', false, 'not set', 'testa config set jevApiKey <key>');
  else {
    try {
      const r = await fetch(process.env.JEV_ENDPOINT || 'https://api.typesafe.ai/v1/systemone', {
        method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: settings.jevModel.value, state: 'ping', questions: { ok: { type: 'noul', instructions: 'Is this a ping?' } } }),
        signal: AbortSignal.timeout(8000),
      });
      add('jev key', r.ok, r.ok ? `valid (${settings.jevApiKey.source})` : `HTTP ${r.status}`, r.ok ? undefined : 'check the key at console.typesafe.ai');
    } catch (e) { add('jev key', false, e.message, 'check network'); }
  }

  try {
    const { chromium } = await import('playwright');
    add('chromium', existsSync(chromium.executablePath()), 'Playwright Chromium', 'testa setup (or npx playwright install chromium)');
  } catch (e) { add('chromium', false, e.message, 'npm install'); }

  if (platform() === 'darwin') {
    add('xcode', has('xcrun'), has('xcrun') ? 'xcrun available' : 'missing', 'install Xcode + command line tools');
    const axe = axePath();
    add('axe (iOS)', axe !== 'axe' || has('axe'), axe, 'testa setup');
    add('webdriveragent (iOS, optional)', existsSync(wdaAppPath()), existsSync(wdaAppPath()) ? wdaAppPath() : 'not installed — taps use AXe (slower)', 'testa setup');
    try {
      const { stdout } = await run('xcrun', ['simctl', 'list', 'devices', 'booted', '-j']);
      const booted = Object.values(JSON.parse(stdout).devices).flat().filter((d) => d.state === 'Booted');
      add('simulator', booted.length > 0, booted.map((d) => d.name).join(', ') || 'none booted', 'open -a Simulator');
    } catch { add('simulator', false, 'simctl failed', 'install Xcode'); }
  }

  const reg = [];
  if (has('claude')) { try { reg.push(`claude:${/testa/.test(execFileSync('claude', ['mcp', 'list'], { encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'ignore'] })) ? 'yes' : 'no'}`); } catch { reg.push('claude:?'); } }
  if (existsSync(join(H, '.codex', 'config.toml'))) reg.push(`codex:${/mcp_servers\.testa/.test(readFileSync(join(H, '.codex', 'config.toml'), 'utf8')) ? 'yes' : 'no'}`);
  if (existsSync(join(H, '.cursor', 'mcp.json'))) reg.push(`cursor:${/testa/.test(readFileSync(join(H, '.cursor', 'mcp.json'), 'utf8')) ? 'yes' : 'no'}`);
  add('agents', reg.length > 0 && !reg.some((r) => r.endsWith(':no')), reg.join(' ') || 'no agent found', 'testa agents install');
  add('config', true, CONFIG_FILE);
  return out;
}
