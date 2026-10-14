// Tiny web app under test: login → painel → create order, with a server error, a help overlay
// (occlusion), an unlabeled input (a11y) and a V2 mode that renames the order button (self-heal).
import { createServer } from 'node:http';

const v2 = process.env.V2 === '1';
const page = (b) => `<!doctype html><html lang="pt"><head><title>Demo</title></head><body>${b}</body></html>`;

createServer((req, res) => {
  const authed = (req.headers.cookie || '').includes('sid=ok');
  if (req.url === '/api/login' && req.method === 'POST') { res.setHeader('set-cookie', 'sid=ok; Path=/'); return res.end('{}'); }
  if (req.url === '/api/orders' && req.method === 'POST') { res.statusCode = 201; return res.end('{"id":1}'); }
  if (req.url === '/api/broken') { console.error('ERROR boom while loading recommendations'); res.statusCode = 500; return res.end('{"error":"boom"}'); }
  if (req.url.startsWith('/painel')) {
    if (!authed) { res.statusCode = 302; res.setHeader('location', '/login'); return res.end(); }
    return res.end(page(`<h1>Painel</h1>
<section aria-label="Pedidos"><button id=b>${v2 ? 'Confirmar pedido' : 'Criar pedido'}</button><button id=help>Abrir ajuda</button><input placeholder="Cupom"></section>
<div id=out></div>
<div id=ov role=dialog aria-modal=true style="display:none;position:fixed;inset:0;background:#fff"><p>Ajuda</p><button id=close>Fechar</button></div>
<script>fetch('/api/broken');
b.onclick=async()=>{const r=await fetch('/api/orders',{method:'POST'});out.innerText=r.status===201?'Pedido criado':'Erro ao criar pedido'};
help.onclick=()=>{ov.style.display='block'};close.onclick=()=>{ov.style.display='none'}</script>`));
  }
  res.end(page(`<h1>Login</h1><form id=f><label for=email>E-mail</label><input id=email><label for=pw>Senha</label><input id=pw type=password><button>Entrar</button></form>
<script>f.onsubmit=async(e)=>{e.preventDefault();await fetch('/api/login',{method:'POST'});location.href='/painel'}</script>`));
}).listen(Number(process.env.PORT), () => console.log('app ready'));
