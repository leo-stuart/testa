// End-to-end through the MCP protocol: mock Jev + demo web app (headless Chromium).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startMockJev } from './helpers/mock-jev.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PORT = 4600 + Math.floor(Math.random() * 300);
const BASE = `http://localhost:${PORT}`;
const APP = join(ROOT, 'test/helpers/demo-app.mjs');
let jev, client, project;

const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 120000 });
  return r.content.map((c) => c.text ?? '').join('\n');
};

before(async () => {
  jev = await startMockJev();
  project = mkdtempSync(join(tmpdir(), 'testa-it-'));
  client = new Client({ name: 'it', version: '0' });
  await client.connect(new StdioClientTransport({
    command: process.execPath, args: [join(ROOT, 'src/server.mjs')],
    env: { ...process.env, JEV_ENDPOINT: jev.url, TYPESAFE_API_KEY: 'mock', TESTA_PROJECT_DIR: project, TESTA_HEADLESS: '1', TESTA_QA_PASSWORD: 's3cr3t' },
  }));
});

after(async () => {
  await call('stop_app', { name: 'demo' }).catch(() => {});
  await client?.close();
  jev?.server.close();
  rmSync(project, { recursive: true, force: true });
});

test('app_profile init + remember build per-app context', async () => {
  const out = await call('app_profile', { init: true });
  assert.match(out, /app\.json created/);
  await call('remember', { note: 'Orders need login first', topic: 'orders' });
  assert.match(await call('app_profile'), /Orders need login first/);
  assert.match(await call('remember', { note: 'senha: hunter2' }), /secret/i);
});

test('start_app waits for the port and keeps logs', async () => {
  const out = await call('start_app', { name: 'demo', command: `PORT=${PORT} ${process.execPath} ${APP}`, port: PORT });
  assert.match(out, /demo: ready/);
});

test('login scenario passes, saves session and scenario, keeps secrets out', async () => {
  const out = await call('run_scenario', {
    platform: 'web', url: `${BASE}/login`, goal: 'login', hints: ['Fill e-mail and senha', 'Tap "Entrar"'],
    data: { email: 'qa@example.com', senha: 's3cr3t' }, assertions: ["'Painel' is visible"], session: 'qa', saveAs: 'login',
  });
  assert.match(out, /STATUS: passed/);
  assert.match(out, /500 GET .*\/api\/broken — \{"error":"boom"\}/, 'failed response body reported');
  assert.match(out, /\[log:demo\] ERROR boom/, 'server log errors attached');
  assert.match(out, /saved session: qa/);
  const sc = JSON.parse(readFileSync(join(project, '.testa/scenarios/login.json'), 'utf8'));
  assert.equal(sc.data.senha, undefined);
  assert.deepEqual(sc.secretKeys, ['senha']);
  assert.ok(existsSync(join(project, '.testa/.gitignore')));
});

test('feature scenario with session: one Jev pass per step, HTTP assertion, a11y reported', async () => {
  jev.calls.length = 0;
  const out = await call('run_scenario', {
    platform: 'web', url: `${BASE}/painel`, goal: 'criar pedido', hints: ['Tap "Criar pedido"'],
    assertions: ["'Pedido criado' is shown", 'A POST /api/orders returned 201'], focus: ['Criar pedido'], session: 'qa', saveAs: 'criar pedido',
  });
  assert.match(out, /STATUS: passed/);
  assert.match(out, /session "qa" loaded/);
  assert.match(out, /accessibility: .*input-without-label/s, 'unlabeled Cupom input flagged');
  const stepCalls = jev.calls.filter((q) => q.includes('done'));
  assert.ok(stepCalls.every((q) => q.length <= 4), 'single parallel pass per step');
});

test('mocks force an API error and are reported', async () => {
  const out = await call('run_scenario', {
    platform: 'web', url: `${BASE}/painel`, goal: 'criar pedido com erro', hints: ['Tap "Criar pedido"'], session: 'qa',
    assertions: ["'Erro ao criar pedido' is shown"], mocks: [{ url: '/api/orders', method: 'POST', status: 500, body: { error: 'forced' } }],
  });
  assert.match(out, /STATUS: passed/);
  assert.match(out, /500 POST .*\/api\/orders \(mocked\)/);
  assert.match(out, /mocks: POST \/api\/orders → 500/);
});

test('overlay hides covered elements from observe', async () => {
  await call('open', { platform: 'web', url: `${BASE}/painel`, session: 'qa' });
  const before = await call('observe', { platform: 'web' });
  const helpId = before.match(/(e\d+) button "Abrir ajuda"/)[1];
  const after = await call('act', { platform: 'web', action: 'tap', elementId: helpId });
  assert.match(after, /button "Fechar"/);
  assert.doesNotMatch(after, /Criar pedido/);
  assert.match(after, /hidden behind an overlay/);
});

test('a11y_audit runs axe-core on web', async () => {
  await call('open', { platform: 'web', url: `${BASE}/painel`, session: 'qa' });
  assert.match(await call('a11y_audit', { platform: 'web' }), /landmark-one-main/);
});

test('replay self-heals a renamed button and the risk gate still applies', async () => {
  await call('stop_app', { name: 'demo' });
  assert.match(await call('start_app', { name: 'demo', command: `V2=1 PORT=${PORT} ${process.execPath} ${APP}`, port: PORT }), /ready/);
  const out = await call('replay', { name: 'criar pedido' });
  assert.match(out, /self-healed:\s+step 1: button "Criar pedido" → button "Confirmar pedido"/);
  assert.match(out, /STATUS: needs_confirmation/);
});
