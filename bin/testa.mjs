#!/usr/bin/env node
// testa CLI: setup, config, doctor, agent registration. The MCP server itself is `testa mcp`.
import { createInterface } from 'node:readline/promises';
import { platform } from 'node:os';
import { SETTINGS, resolveSettings, writeUserSetting, mask, CONFIG_FILE, readUserConfig } from '../src/settings.mjs';
import { installAgents, installChromium, installAxe, installWda, doctor } from '../src/setup.mjs';

const [cmd, ...args] = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };

const HELP = `testa — test implemented features on web and iOS Simulator with Jev

  testa setup [--key <jev key>] [--yes] [--no-ios] [--no-agents]
      one-time install: Jev key, Chromium, AXe/WebDriverAgent (macOS), MCP + skill in Claude Code/Codex/Cursor
  testa config                     list settings and where each value comes from
  testa config set <name> <value>  e.g. config set headless false
  testa config unset <name>
  testa doctor                     check everything and print fixes
  testa agents install|uninstall   (re)register in Claude Code, Codex, Cursor
  testa mcp                        run the MCP server (stdio)

settings file: ${CONFIG_FILE}`;

function printSettings() {
  for (const { name, value, source } of resolveSettings(process.env.TESTA_PROJECT_DIR)) {
    console.log(`  ${name.padEnd(13)} ${mask(name, value).padEnd(24)} [${source}]  ${SETTINGS[name].desc}`);
  }
}

async function ask(rl, q, { secret = false } = {}) {
  if (!secret) return (await rl.question(q)).trim();
  // Hide typed characters for the API key.
  const out = process.stdout;
  const origWrite = out.write.bind(out);
  out.write = (s, ...r) => (s.includes(q) ? origWrite(s, ...r) : true);
  try { return (await rl.question(q)).trim(); } finally { out.write = origWrite; out.write('\n'); }
}

async function setup() {
  const yes = flag('yes');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log('testa setup\n');
    const current = readUserConfig();
    let key = opt('key');
    if (!key && !current.jevApiKey && !yes) key = await ask(rl, 'Jev API key (console.typesafe.ai): ', { secret: true });
    if (key) { writeUserSetting('jevApiKey', key); console.log('✓ Jev key saved'); }
    else if (current.jevApiKey) console.log('✓ Jev key already set');
    else console.log('! no Jev key: set later with `testa config set jevApiKey <key>`');

    if (!yes && current.headless === undefined) {
      const watch = (await ask(rl, 'Show the browser while tests run? [Y/n] ')).toLowerCase();
      writeUserSetting('headless', watch === 'n' || watch === 'nao' || watch === 'não');
    }

    process.stdout.write('… Chromium (Playwright) '); await installChromium(); console.log('✓');
    if (platform() === 'darwin' && !flag('no-ios')) {
      process.stdout.write('… AXe (iOS Simulator) '); await installAxe(); console.log('✓');
      process.stdout.write('… WebDriverAgent (faster iOS taps) '); await installWda().then(() => console.log('✓')).catch((e) => console.log(`skipped: ${e.message}`));
    }
    if (!flag('no-agents')) { console.log('… registering in coding agents'); installAgents(); }
    console.log('\nDone. Restart your Claude Code / Codex / Cursor sessions, then ask: "testa a feature".');
    console.log('Check anytime with: testa doctor');
  } finally { rl.close(); }
}

async function main() {
  switch (cmd) {
    case 'setup': return setup();
    case 'config': {
      const [sub, name, ...rest] = args;
      if (!sub || sub === 'list') return printSettings();
      if (sub === 'get') { const s = resolveSettings(process.env.TESTA_PROJECT_DIR).find((x) => x.name === name); if (!s) throw new Error(`unknown setting ${name}`); return console.log(SETTINGS[name].secret ? mask(name, s.value) : s.value ?? ''); }
      if (sub === 'set') { writeUserSetting(name, rest.join(' ')); return console.log(`✓ ${name} = ${mask(name, rest.join(' '))}`); }
      if (sub === 'unset') { writeUserSetting(name, null); return console.log(`✓ ${name} unset`); }
      if (sub === 'path') return console.log(CONFIG_FILE);
      throw new Error(`unknown config command ${sub}`);
    }
    case 'doctor': {
      const rows = await doctor();
      for (const r of rows) console.log(`${r.ok ? '✓' : '✗'} ${r.name.padEnd(30)} ${r.detail ?? ''}${!r.ok && r.fix ? `\n    fix: ${r.fix}` : ''}`);
      process.exitCode = rows.some((r) => !r.ok && !r.name.includes('optional')) ? 1 : 0;
      return;
    }
    case 'agents': return installAgents({ uninstall: args[0] === 'uninstall' });
    case 'mcp': return import('../src/server.mjs');
    default: console.log(HELP);
  }
}

main().catch((e) => { console.error(`error: ${e.message}`); process.exitCode = 1; });
