// Deterministic stand-in for the Jev API: answers from keywords in the state, so the
// loop, policy, mocks, replay and reporting can be tested without network or a key.
import { createServer } from 'node:http';

export function startMockJev() {
  const calls = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const { state, questions, model } = JSON.parse(body);
      calls.push(Object.keys(questions));
      if (!model || !req.headers.authorization?.startsWith('Bearer ')) { res.statusCode = 422; return res.end('bad request'); }
      const txt = JSON.stringify(state);
      const hist = (state.history || []).join(' ');
      // Next hint whose quoted label hasn't been acted on yet.
      const wanted = (state.hints || []).map((h) => h.match(/"([^"]+)"/)?.[1]).filter(Boolean).find((l) => !hist.includes(l));
      const answers = {};
      for (const [k, q] of Object.entries(questions)) {
        if (q.type === 'noul') {
          let yes;
          if (k === 'done') yes = state.goal.includes('login') ? txt.includes('Painel') : /Pedido criado|Erro ao criar pedido/.test(txt);
          else {
            const st = q.instructions.match(/Statement: "(.*)"$/)[1];
            yes = /POST \/api\/orders returned (\d+)/.test(st)
              ? txt.includes(`${st.match(/returned (\d+)/)[1]} POST`) && txt.includes('/api/orders')
              : txt.includes(st.match(/'([^']+)'/)?.[1] ?? '@@none@@');
          }
          answers[k] = { type: 'noul', noul: yes ? 0.95 : 0.05 };
        } else {
          const opts = Object.keys(q.criteria);
          let c;
          if (k === 'action') {
            c = opts.find((o) => o.startsWith('type:email:') && q.criteria[o].includes('E-mail'))
              ?? opts.find((o) => o.startsWith('type:senha:') && q.criteria[o].includes('Senha'))
              ?? 'tap';
          } else if (/UI changed/.test(q.instructions)) c = opts.find((o) => q.criteria[o].includes('Confirmar')) ?? 'none';
          else c = opts.find((o) => wanted && q.criteria[o].includes(`"${wanted}"`));
          const conf = c ? 0.9 : 0.1;
          c ??= opts[0];
          answers[k] = { type: 'choice', choice: c, confidence: conf, probabilities: { [c]: conf } };
        }
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ model: 'mock', answers }));
    });
  });
  return new Promise((ok) => server.listen(0, () => ok({ server, calls, url: `http://localhost:${server.address().port}` })));
}
