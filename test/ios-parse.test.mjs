// Accessibility-tree heuristics on a real (anonymized) React Native checkout screen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseIosTree } from '../src/drivers/ios.mjs';

const tree = JSON.parse(readFileSync(new URL('./fixtures/ios-checkout-address.json', import.meta.url), 'utf8'));
const parsed = parseIosTree(tree);
const byKind = (k) => parsed.elements.filter((e) => e.kind === k).map((e) => e.name);

test('hidden RN inputs are detected and named by the label above them', () => {
  assert.deepEqual(byKind('TextField?'), ['CEP', 'Logradouro', 'Número', 'Complemento — Apto, Bloco...', 'Bairro', 'Cidade']);
});

test('values, prices and section headers are not mistaken for fields', () => {
  const fields = byKind('TextField?').join(' ');
  assert.doesNotMatch(fields, /R\$|\/\d{4}|DESCONTO/);
});

test('icon-only back button is exposed with its position', () => {
  assert.deepEqual(byKind('IconButton?'), ['icon button @top-left']);
});

test('real buttons keep their labels', () => {
  assert.ok(byKind('Button').includes('Finalizar pedido'));
});

test('accessibility issues are reported for hidden inputs and icon buttons', () => {
  const rules = new Set(parsed.a11y.map((i) => i.rule));
  assert.ok(rules.has('input-not-exposed'));
  assert.ok(rules.has('icon-without-label'));
});

test('no personal data in the fixture', () => {
  assert.doesNotMatch(JSON.stringify(tree), /leostuart|961\.604/);
});
