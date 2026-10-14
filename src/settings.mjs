// Settings with friendly names, resolved in layers (later wins):
//   defaults < user config (~/.config/testa/config.json) < project (.testa/app.json "settings") < real environment
// Resolved values are exported to process.env under their FT_* names, which is what the drivers read.
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

export const CONFIG_DIR = process.env.TESTA_CONFIG_DIR || join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'testa');
export const CONFIG_FILE = join(CONFIG_DIR, 'config.json');
const LEGACY_ENV_FILE = join(CONFIG_DIR, 'env'); // KEY=value lines from v0.1–0.3

const bool = (v) => (typeof v === 'boolean' ? v : /^(1|true|yes|on|sim)$/i.test(String(v)));
const toEnvBool = (v) => (bool(v) ? '1' : '0');

/** name → { env, type, default, secret?, desc } */
export const SETTINGS = {
  jevApiKey:   { env: 'TYPESAFE_API_KEY', type: 'string', secret: true, desc: 'TypeSafe Jev API key (console.typesafe.ai)' },
  jevModel:    { env: 'JEV_MODEL', type: 'string', default: 'jev-latest', desc: 'Jev model id' },
  headless:    { env: 'TESTA_HEADLESS', type: 'bool', default: true, desc: 'Hide the browser window (false = watch tests run)', toEnv: toEnvBool },
  showCursor:  { env: 'TESTA_SHOW_CURSOR', type: 'bool', desc: 'Draw a fake cursor in the page (default: on when the browser is visible)', toEnv: toEnvBool },
  slowMo:      { env: 'TESTA_SLOWMO', type: 'number', default: 150, desc: 'ms pause between browser actions when visible' },
  allowedHosts:{ env: 'TESTA_ALLOWED_HOSTS', type: 'list', desc: 'Extra web hosts allowed besides localhost/*.vercel.app/ngrok ("*" = any)' },
  hideLogBox:  { env: 'TESTA_HIDE_LOGBOX', type: 'bool', default: true, desc: 'Hide React Native LogBox toasts during runs', toEnv: toEnvBool },
  iosInput:    { env: 'TESTA_IOS_INPUT', type: 'enum', values: ['auto', 'wda', 'axe'], default: 'auto', desc: 'iOS touch backend (auto = WebDriverAgent when available)' },
  metroPort:   { env: 'TESTA_METRO_PORT', type: 'number', default: 8081, desc: 'Metro dev server port' },
  wdaUrl:      { env: 'TESTA_WDA_URL', type: 'string', default: 'http://127.0.0.1:8100', desc: 'WebDriverAgent URL' },
  cacheDir:    { env: 'TESTA_CACHE_DIR', type: 'string', desc: 'Where Chromium-independent tools (AXe, WDA) are downloaded' },
};

// Snapshot the real environment before we write into process.env, so it always wins.
const REAL_ENV = Object.fromEntries(Object.values(SETTINGS).map((s) => [s.env, process.env[s.env]]).filter(([, v]) => v !== undefined));

function readJson(p) { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return undefined; } }

function legacyEnv() {
  if (!existsSync(LEGACY_ENV_FILE)) return {};
  const byEnv = Object.fromEntries(Object.entries(SETTINGS).map(([k, s]) => [s.env, k]));
  const out = {};
  for (const line of readFileSync(LEGACY_ENV_FILE, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && m[2] && byEnv[m[1]]) out[byEnv[m[1]]] = coerce(byEnv[m[1]], m[2].replace(/^["']|["']$/g, ''));
  }
  return out;
}

export function readUserConfig() {
  return { ...legacyEnv(), ...(readJson(CONFIG_FILE) ?? {}) };
}

function readProjectSettings(projectDir) {
  if (!projectDir) return {};
  return readJson(join(projectDir, '.testa', 'app.json'))?.settings ?? {};
}

export function coerce(name, value) {
  const s = SETTINGS[name];
  if (!s) throw new Error(`Unknown setting "${name}". Known: ${Object.keys(SETTINGS).join(', ')}`);
  if (value === null || value === undefined || value === '') return undefined;
  switch (s.type) {
    case 'bool': return bool(value);
    case 'number': { const n = Number(value); if (Number.isNaN(n)) throw new Error(`${name} must be a number`); return n; }
    case 'list': return Array.isArray(value) ? value : String(value).split(',').map((x) => x.trim()).filter(Boolean);
    case 'enum': if (!s.values.includes(String(value))) throw new Error(`${name} must be one of ${s.values.join('|')}`); return String(value);
    default: return String(value);
  }
}

/** Resolve all layers; returns [{ name, value, source }]. */
export function resolveSettings(projectDir) {
  const user = readUserConfig();
  const project = readProjectSettings(projectDir);
  return Object.entries(SETTINGS).map(([name, s]) => {
    if (REAL_ENV[s.env] !== undefined) return { name, value: REAL_ENV[s.env], source: 'env' };
    if (project[name] !== undefined) return { name, value: coerce(name, project[name]), source: 'project' };
    if (user[name] !== undefined) return { name, value: coerce(name, user[name]), source: 'user' };
    return { name, value: s.default, source: 'default' };
  });
}

/** Export resolved settings to process.env (FT_* names the drivers read). Call again when the project changes. */
export function applySettings(projectDir) {
  for (const { name, value, source } of resolveSettings(projectDir)) {
    const s = SETTINGS[name];
    if (source === 'env') continue;
    if (value === undefined) { delete process.env[s.env]; continue; }
    process.env[s.env] = s.toEnv ? s.toEnv(value) : Array.isArray(value) ? value.join(',') : String(value);
  }
}

export function mask(name, value) {
  if (value === undefined) return '(unset)';
  return SETTINGS[name]?.secret ? `${String(value).slice(0, 4)}…${String(value).slice(-2)}` : Array.isArray(value) ? value.join(',') : String(value);
}

export function writeUserSetting(name, value) {
  // First write folds the legacy KEY=value env file into config.json.
  const cfg = { ...legacyEnv(), ...(readJson(CONFIG_FILE) ?? {}) };
  if (existsSync(LEGACY_ENV_FILE)) renameSync(LEGACY_ENV_FILE, `${LEGACY_ENV_FILE}.migrated`);
  const v = coerce(name, value);
  if (v === undefined) delete cfg[name]; else cfg[name] = v;
  mkdirSync(dirname(CONFIG_FILE), { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
  chmodSync(CONFIG_FILE, 0o600); // holds the API key
}

export function writeProjectSetting(projectDir, name, value) {
  if (SETTINGS[name]?.secret) throw new Error(`${name} is a secret: set it per user with \`testa config set ${name}\`, never in a project`);
  const p = join(projectDir, '.testa', 'app.json');
  const cfg = readJson(p);
  if (!cfg) throw new Error(`No ${p}; run app_profile({ init: true }) first`);
  cfg.settings ??= {};
  const v = coerce(name, value);
  if (v === undefined) delete cfg.settings[name]; else cfg.settings[name] = v;
  writeFileSync(p, JSON.stringify(cfg, null, 2) + '\n');
}

// User-level settings apply as soon as any module imports this one.
applySettings();
