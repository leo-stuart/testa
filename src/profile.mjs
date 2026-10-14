// Per-app context: config (.testa/app.json), learned notes (knowledge.md),
// discovered routes, saved scenarios. Lets the same MCP serve any web or mobile app.
//
// Rule: everything testa writes for a project lives in <project>/.testa/, and that
// directory is always git-ignored (root .gitignore entry + an inner `*` .gitignore) the moment it is created.
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync, appendFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SKIP_DIRS = new Set(['node_modules', '.git', 'ios', 'android', 'dist', 'build', '.next', '.expo', '.testa', 'coverage']);

function readJson(p) {
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return undefined; }
}

function walkFiles(dir, match, out = [], depth = 0) {
  if (depth > 8 || !existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name) || name.startsWith('.')) continue;
    const p = join(dir, name);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) walkFiles(p, match, out, depth + 1);
    else if (match(p)) out.push(p);
    if (out.length > 2000) break;
  }
  return out;
}

export function detectStack(dir) {
  const pkg = readJson(join(dir, 'package.json'));
  if (!pkg) return { stack: 'unknown' };
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  let stack = 'node';
  if (deps.expo || deps['react-native']) stack = deps['expo-router'] ? 'expo-router' : 'react-native';
  else if (deps.next) stack = 'next';
  else if (deps['@remix-run/react'] || deps['@react-router/dev']) stack = 'remix';
  else if (deps.nuxt) stack = 'nuxt';
  else if (deps['@sveltejs/kit']) stack = 'sveltekit';
  else if (deps.vite) stack = 'vite';
  const expo = readJson(join(dir, 'app.json'))?.expo ?? {};
  let scheme = expo.scheme;
  let bundleId = expo.ios?.bundleIdentifier;
  // app.config.ts is code; a regex read is enough for these two strings.
  for (const f of ['app.config.ts', 'app.config.js']) {
    const p = join(dir, f);
    if (!existsSync(p)) continue;
    const src = readFileSync(p, 'utf8');
    scheme ??= src.match(/scheme:\s*["'`]([^"'`]+)["'`]/)?.[1];
    bundleId ??= src.match(/bundleIdentifier:\s*["'`]([^"'`]+)["'`]/)?.[1];
  }
  const scripts = pkg.scripts ?? {};
  return { stack, name: pkg.name, scheme, bundleId, devScript: scripts.dev ? 'dev' : scripts.start ? 'start' : undefined };
}

/** Routes/screens from the code: Next/Remix/SvelteKit/expo-router files, React Navigation linking config. */
export function discoverRoutes(dir, stack) {
  const routes = [];
  const fileRoute = (base, file) => '/' + relative(base, file)
    .replace(/\.(tsx|jsx|ts|js|vue|svelte)$/, '')
    .replace(/(^|\/)(index|page|\+page|layout|_layout)$/, '')
    .replace(/\([^)]+\)\/?/g, '')
    .replace(/\[\.\.\.(\w+)\]/g, ':$1*').replace(/\[(\w+)\]/g, ':$1')
    .replace(/\/$/, '');

  if (stack === 'next') {
    for (const base of ['app', 'src/app']) {
      const b = join(dir, base);
      for (const f of walkFiles(b, (p) => /\/page\.(tsx|jsx|ts|js)$/.test(p))) routes.push({ path: fileRoute(b, f), file: relative(dir, f) });
    }
    for (const base of ['pages', 'src/pages']) {
      const b = join(dir, base);
      for (const f of walkFiles(b, (p) => /\.(tsx|jsx|ts|js)$/.test(p) && !/\/(api|_app|_document)/.test(p))) routes.push({ path: fileRoute(b, f), file: relative(dir, f) });
    }
  } else if (stack === 'expo-router') {
    for (const base of ['app', 'src/app']) {
      const b = join(dir, base);
      for (const f of walkFiles(b, (p) => /\.(tsx|jsx|ts|js)$/.test(p) && !/_layout|\+(html|not-found)/.test(p))) routes.push({ path: fileRoute(b, f), file: relative(dir, f) });
    }
  } else if (stack === 'sveltekit') {
    const b = join(dir, 'src/routes');
    for (const f of walkFiles(b, (p) => /\+page\.svelte$/.test(p))) routes.push({ path: fileRoute(b, f), file: relative(dir, f) });
  }

  if (stack === 'react-native' || stack === 'expo-router') {
    // React Navigation linking: `ScreenName: "path/:param"` inside a `screens:` config.
    for (const f of walkFiles(join(dir, 'src'), (p) => /\.(tsx|ts|js)$/.test(p))) {
      const src = readFileSync(f, 'utf8');
      if (!/prefixes\s*:/.test(src) || !/screens\s*:/.test(src)) continue;
      for (const m of src.matchAll(/^\s*(\w+)\s*:\s*["'`]([^"'`]*)["'`]\s*,?\s*$/gm)) routes.push({ screen: m[1], path: m[2], file: relative(dir, f) });
      const disabled = /getInitialURL\s*\(\)\s*{\s*return null/.test(src) || /subscribe\s*\(\)\s*{\s*return\s*\(\)\s*=>\s*{\s*}/.test(src);
      if (disabled) routes.push({ note: 'linking config does not listen to OS URLs: use navigate(screen) instead of deep links', file: relative(dir, f) });
    }
  }
  return routes.slice(0, 300);
}

export class Profile {
  constructor(projectDir) {
    this.dir = projectDir;
    this.home = join(projectDir, '.testa');
    this.configPath = join(this.home, 'app.json');
    this.knowledgePath = join(this.home, 'knowledge.md');
  }

  get config() { return readJson(this.configPath) ?? {}; }

  /** Create .testa/ and make sure git never sees it. Every write goes through here. */
  ensureHome() {
    mkdirSync(this.home, { recursive: true });
    // Inner guard: ignores everything even if someone drops the root entry.
    const inner = join(this.home, '.gitignore');
    if (!existsSync(inner) || readFileSync(inner, 'utf8').trim() !== '*') writeFileSync(inner, '*\n');
    // Root entry: mandatory, added once.
    const root = join(this.dir, '.gitignore');
    const lines = existsSync(root) ? readFileSync(root, 'utf8').split('\n').map((l) => l.trim()) : [];
    if (!lines.some((l) => ['.testa', '.testa/', '/.testa', '/.testa/'].includes(l))) {
      const prefix = existsSync(root) && !readFileSync(root, 'utf8').endsWith('\n') ? '\n' : '';
      appendFileSync(root, `${prefix}\n# testa: local test context and evidence (never commit)\n.testa/\n`);
    }
  }

  /** Create app.json from what we can detect, if missing. */
  init() {
    this.ensureHome();
    if (existsSync(this.configPath)) return false;
    const s = detectStack(this.dir);
    const mobile = s.stack === 'react-native' || s.stack === 'expo-router';
    const cfg = {
      name: s.name,
      stack: s.stack,
      ...(mobile ? {
        ios: { bundleId: s.bundleId, scheme: s.scheme },
        start: { metro: { command: 'npx expo start', port: 8081 } },
      } : {
        web: { baseUrl: 'http://localhost:3000' },
        start: { web: { command: `npm run ${s.devScript ?? 'dev'}`, port: 3000 } },
      }),
      accounts: {},
      settings: {},
      allowedHosts: [],
      allowRisky: [],
      notes: 'This directory is git-ignored. accounts: TEST accounts for local/staging only ("$VAR" reads the environment). settings: per-project overrides of testa settings.',
    };
    writeFileSync(this.configPath, JSON.stringify(cfg, null, 2) + '\n');
    return true;
  }

  accounts() {
    return this.config.accounts ?? {};
  }

  /** Resolve an account's fields; "$VAR" values come from the environment. */
  account(name) {
    const acc = this.accounts()[name];
    if (!acc) throw new Error(`No account "${name}" in ${this.configPath}`);
    const out = {};
    for (const [k, v] of Object.entries(acc)) {
      if (k.startsWith('_')) continue; // metadata like _env/_note, never typed
      if (typeof v === 'string' && v.startsWith('$')) {
        const val = process.env[v.slice(1)];
        if (!val) throw new Error(`Account "${name}": env ${v.slice(1)} is not set in the environment`);
        out[k] = val;
      } else out[k] = String(v);
    }
    return out;
  }

  knowledge() {
    return existsSync(this.knowledgePath) ? readFileSync(this.knowledgePath, 'utf8') : '';
  }

  remember(note, topic = 'General') {
    this.ensureHome();
    if (!existsSync(this.knowledgePath)) writeFileSync(this.knowledgePath, '# App knowledge for testa\n\nFacts learned while testing this app. Keep entries short and factual.\n');
    appendFileSync(this.knowledgePath, `\n- [${new Date().toISOString().slice(0, 10)}] (${topic}) ${note.replace(/\n+/g, ' ').trim()}`);
  }

  scenarios() {
    const d = join(this.home, 'scenarios');
    if (!existsSync(d)) return [];
    return readdirSync(d).filter((f) => f.endsWith('.json')).map((f) => readJson(join(d, f))).filter(Boolean);
  }

  summary({ includeRoutes = true } = {}) {
    const detected = detectStack(this.dir);
    // Never echo secret values into the agent's context; the account name is all it needs.
    const SECRET = /pass|senha|token|secret|pin|otp/i;
    const mask = (acc) => Object.fromEntries(Object.entries(acc).map(([k, v]) => [k, SECRET.test(k) ? '***' : v]));
    const cfg = { ...this.config, accounts: Object.fromEntries(Object.entries(this.accounts()).map(([n, a]) => [n, mask(a)])) };
    const routes = includeRoutes ? discoverRoutes(this.dir, cfg.stack ?? detected.stack) : [];
    return {
      project: this.dir,
      configured: existsSync(this.configPath),
      detected,
      config: cfg,
      knowledge: this.knowledge(),
      scenarios: this.scenarios().map((s) => ({ name: s.name, platform: s.platform, goal: s.goal, start: s.start, steps: s.steps?.length })),
      routes,
    };
  }
}
