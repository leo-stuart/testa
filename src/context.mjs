// Feature context from git: what changed, which screens/routes, which UI hooks to target.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { detectStack } from './profile.mjs';

const run = promisify(execFile);
const git = async (cwd, ...args) => (await run('git', args, { cwd, maxBuffer: 32 << 20 })).stdout.trim();

async function resolveBase(cwd, base) {
  if (base) return base;
  // Pick the integration branch closest to HEAD (fewest commits ahead), e.g. develop over main.
  let best = { ref: 'HEAD', ahead: Infinity };
  for (const b of ['origin/develop', 'origin/main', 'origin/master', 'origin/staging', 'develop', 'main', 'master']) {
    try {
      const mb = await git(cwd, 'merge-base', 'HEAD', b);
      const ahead = Number(await git(cwd, 'rev-list', '--count', `${mb}..HEAD`));
      if (ahead < best.ahead) best = { ref: mb, ahead };
    } catch { /* branch missing */ }
  }
  return best.ref;
}

function routeOf(file, stack) {
  const m = file.match(/(?:^|\/)(?:src\/)?(app|pages)\/(.+)\.(tsx|jsx|ts|js)$/);
  if (!m) return null;
  let r = m[2].replace(/(^|\/)(index|page|layout|_layout)$/, '').replace(/\([^)]+\)\/?/g, '').replace(/\[\.\.\.(\w+)\]/g, ':$1*').replace(/\[(\w+)\]/g, ':$1');
  if (/(^|\/)(api|_app|_document|route)$/.test(m[2]) || m[2].startsWith('api/')) return null;
  if (stack === 'next' && m[1] === 'app' && !/(^|\/)page$/.test(m[2])) return null;
  return '/' + r.replace(/\/$/, '');
}

export async function featureContext({ repoPath, base }) {
  const cwd = repoPath;
  await git(cwd, 'rev-parse', '--show-toplevel');
  const baseRef = await resolveBase(cwd, base);
  const info = detectStack(cwd);
  const branch = await git(cwd, 'rev-parse', '--abbrev-ref', 'HEAD');
  const log = await git(cwd, 'log', '--oneline', '-n', '15', `${baseRef}..HEAD`).catch(() => '');
  const nameStatus = await git(cwd, 'diff', '--name-status', baseRef);
  const untracked = await git(cwd, 'ls-files', '--others', '--exclude-standard');
  const diff = await git(cwd, 'diff', '-U0', baseRef, '--', '*.tsx', '*.jsx', '*.ts', '*.js', '*.vue', '*.svelte');

  const files = [
    ...nameStatus.split('\n').filter(Boolean).map((l) => { const [s, ...f] = l.split('\t'); return { status: s, file: f.at(-1) }; }),
    ...untracked.split('\n').filter(Boolean).map((f) => ({ status: '?', file: f })),
  ].filter((f) => !/(^|\/)(node_modules|dist|build|\.next|ios|android)\//.test(f.file) && !/lock|\.snap$/.test(f.file));

  const routes = [...new Set(files.map((f) => routeOf(f.file, info.stack)).filter(Boolean))];
  const screens = [...new Set(files.map((f) => f.file.match(/(?:^|\/)(?:screens?|views|features|modules)\/([^/]+(?:\/[^/]+)?)/i)?.[1]?.replace(/\.(tsx|jsx|ts|js)$/, '')).filter(Boolean))];
  const added = diff.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++'));
  const pick = (re) => [...new Set(added.flatMap((l) => [...l.matchAll(re)].map((m) => m[1])))].slice(0, 40);
  const testIds = pick(/(?:testID|data-testid|accessibilityLabel|aria-label)\s*=\s*["'{`]+([^"'`}]+)/g);
  const uiStrings = pick(/>\s*([A-Za-zÀ-ú][^<>{}]{2,60}?)\s*</g)
    .concat(pick(/(?:title|label|placeholder)\s*=\s*["']([^"']{3,60})["']/g)).slice(0, 40);
  const endpoints = pick(/["'`](\/(?:api|v\d)\/[^"'`\s]+)["'`]/g);

  return {
    repo: cwd, branch, base: baseRef, ...info,
    commits: log ? log.split('\n') : [],
    files, routes, screens, testIds, uiStrings, endpoints,
    diffStat: await git(cwd, 'diff', '--shortstat', baseRef),
  };
}
