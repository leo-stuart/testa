// Smoke test without Jev: drivers + MCP handshake. Usage: npm run smoke [-- --ios]
import { createServer } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { WebDriver } from '../src/drivers/web.mjs';
import { IosDriver } from '../src/drivers/ios.mjs';
import { describeEl } from '../src/loop.mjs';

const html = `<!doctype html><title>Login</title>
<form onsubmit="event.preventDefault();document.body.innerHTML='<h1>Bem-vindo, '+email.value+'</h1>';console.error('demo error')">
<label for=email>E-mail</label><input id=email><label for=pw>Senha</label><input id=pw type=password>
<button>Entrar</button></form><a href="/x">Esqueci a senha</a>`;
const http = createServer((_, res) => res.end(html)).listen(0);
const url = `http://localhost:${http.address().port}/`;

const t = Date.now();
const web = new WebDriver();
await web.open({ url });
web.markEvents();
let obs = await web.observe();
console.log('web observe', Date.now() - t, 'ms\n ', obs.elements.map(describeEl).join('\n  '));
const byName = (n) => obs.elements.find((e) => e.name === n);
await web.act({ action: 'type', el: byName('E-mail'), value: 'qa@example.com' });
await web.act({ action: 'tap', el: byName('Entrar') });
obs = await web.observe();
console.log('after login:', obs.text, (await web.takeEvents()).events);
await web.close();
http.close();

if (process.argv.includes('--ios')) {
  const ios = new IosDriver();
  const t1 = Date.now();
  const o = await ios.observe();
  console.log(`ios observe ${Date.now() - t1}ms, ${o.elements.length} elements\n `, o.elements.slice(0, 25).map(describeEl).join('\n  '));
}

const client = new Client({ name: 'smoke', version: '0' });
await client.connect(new StdioClientTransport({ command: 'node', args: ['src/server.mjs'], env: { ...process.env, TYPESAFE_API_KEY: '' } }));
console.log('mcp tools:', (await client.listTools()).tools.map((x) => x.name).join(', '));
await client.close();
