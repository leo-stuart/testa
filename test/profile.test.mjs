// Per-project context: .testa/ is always git-ignored; accounts resolved and masked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Profile } from '../src/profile.mjs';

const tmpProject = (pkg = { name: 'demo', dependencies: { next: '15' } }) => {
  const dir = mkdtempSync(join(tmpdir(), 'testa-prof-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg));
  return dir;
};

test('creating .testa/ always git-ignores it (root entry once + inner *)', () => {
  const dir = tmpProject();
  try {
    writeFileSync(join(dir, '.gitignore'), 'node_modules'); // no trailing newline
    const p = new Profile(dir);
    p.init();
    p.remember('fact');
    p.ensureHome();
    const root = readFileSync(join(dir, '.gitignore'), 'utf8');
    assert.match(root, /^node_modules\n/);
    assert.equal(root.match(/^\.testa\/$/gm)?.length, 1, 'added exactly once');
    assert.equal(readFileSync(join(p.home, '.gitignore'), 'utf8'), '*\n');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('root .gitignore is created when the project has none', () => {
  const dir = tmpProject();
  try {
    new Profile(dir).ensureHome();
    assert.match(readFileSync(join(dir, '.gitignore'), 'utf8'), /^\.testa\/$/m);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('accounts: literal and $ENV values, metadata skipped, secrets masked in summaries', () => {
  const dir = tmpProject();
  try {
    const p = new Profile(dir);
    p.init();
    const cfg = JSON.parse(readFileSync(p.configPath, 'utf8'));
    cfg.accounts = { qa: { email: 'qa@team.dev', senha: 'pw-literal-123', _env: 'staging' }, admin: { email: 'a@team.dev', senha: '$TESTA_ADMIN_PW' } };
    writeFileSync(p.configPath, JSON.stringify(cfg));

    assert.deepEqual(p.account('qa'), { email: 'qa@team.dev', senha: 'pw-literal-123' });
    assert.throws(() => p.account('admin'), /TESTA_ADMIN_PW/);
    process.env.TESTA_ADMIN_PW = 'pw-from-env-456';
    assert.equal(p.account('admin').senha, 'pw-from-env-456');
    assert.doesNotMatch(JSON.stringify(p.summary({ includeRoutes: false })), /pw-literal-123|pw-from-env-456/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.TESTA_ADMIN_PW;
  }
});
