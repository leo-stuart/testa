import { test } from 'node:test';
import assert from 'node:assert/strict';
import { vagueAssertions } from '../src/assertions.mjs';

test('vague assertions are flagged', () => {
  const vague = ['Funciona', 'Login works', 'Everything OK', 'No errors', 'Tudo certo', 'o fluxo deve funcionar corretamente', 'It works as expected.'];
  assert.deepEqual(vagueAssertions(vague), vague);
});

test('observable assertions pass', () => {
  const ok = [
    'Cupom aplicado appears in the order summary',
    'A POST to /orders returned 2xx',
    'No error message is shown on screen',
    'Login works and Sair da conta is visible',
    'O total mostra R$ 10,00',
  ];
  assert.deepEqual(vagueAssertions(ok), []);
});
