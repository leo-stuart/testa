// Settings layers: default < user config < project app.json < real environment.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const cfgDir = mkdtempSync(join(tmpdir(), 'testa-cfg-'));
process.env.TESTA_CONFIG_DIR = cfgDir;
delete process.env.TESTA_HEADLESS;
process.env.TESTA_METRO_PORT = '9999'; // real env must win over everything
const S = await import('../src/settings.mjs');

test('layers resolve in order and export FT_* env', () => {
  const project = mkdtempSync(join(tmpdir(), 'testa-proj-'));
  try {
    writeFileSync(join(cfgDir, 'env'), 'TESTA_HEADLESS=0\n'); // legacy file still read
    let r = Object.fromEntries(S.resolveSettings(project).map((x) => [x.name, x]));
    assert.equal(r.headless.value, false);
    assert.equal(r.headless.source, 'user');

    S.writeUserSetting('slowMo', '300');
    assert.ok(!existsSync(join(cfgDir, 'env')) && existsSync(join(cfgDir, 'env.migrated')), 'legacy env migrated');
    assert.equal(JSON.parse(readFileSync(S.CONFIG_FILE, 'utf8')).headless, false);
    assert.equal(statSync(S.CONFIG_FILE).mode & 0o777, 0o600);

    mkdirSync(join(project, '.testa'));
    writeFileSync(join(project, '.testa/app.json'), JSON.stringify({ settings: {} }));
    S.writeProjectSetting(project, 'headless', 'true');
    r = Object.fromEntries(S.resolveSettings(project).map((x) => [x.name, x]));
    assert.equal(r.headless.value, true);
    assert.equal(r.headless.source, 'project');
    assert.equal(r.slowMo.value, 300);
    assert.equal(r.metroPort.source, 'env');

    S.applySettings(project);
    assert.equal(process.env.TESTA_HEADLESS, '1');
    assert.equal(process.env.TESTA_SLOWMO, '300');
    assert.equal(process.env.TESTA_METRO_PORT, '9999');
  } finally { rmSync(project, { recursive: true, force: true }); }
});

test('secrets cannot be stored per project and are masked', () => {
  assert.throws(() => S.writeProjectSetting('/tmp', 'jevApiKey', 'x'), /secret/);
  assert.equal(S.mask('jevApiKey', 'apikey-1234567890'), 'apik…90');
  assert.throws(() => S.coerce('iosInput', 'banana'), /auto\|wda\|axe/);
  assert.throws(() => S.coerce('nope', 1), /Unknown setting/);
});

test.after(() => rmSync(cfgDir, { recursive: true, force: true }));
