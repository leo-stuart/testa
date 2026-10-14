// Local safety gate. Runs before every action; Jev never gets to bypass it.

const RISKY = new RegExp(
  '\\b(?:' + [
    'excluir', 'deletar', 'apagar', 'remover', 'pagar', 'pagamento', 'finalizar (compra|pedido)', 'confirmar (compra|pedido|pagamento)',
    'comprar', 'transferir', 'enviar', 'cancelar (assinatura|conta|plano)', 'encerrar conta', 'sair da conta',
    'delete', 'remove', 'pay', 'purchase', 'buy now', 'place order', 'checkout', 'transfer', 'send', 'unsubscribe', 'log ?out', 'sign ?out',
  ].join('|') + ')',
  'i',
);

const DEFAULT_HOSTS = ['localhost', '127.0.0.1', '0.0.0.0', '*.local', '*.vercel.app', '*.ngrok-free.app', '*.ngrok.app'];

export function hostAllowed(url, extra = []) {
  const fromSettings = (process.env.TESTA_ALLOWED_HOSTS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (fromSettings.includes('*')) return true;
  let host;
  try { host = new URL(url).hostname; } catch { return false; }
  return [...DEFAULT_HOSTS, ...fromSettings, ...extra].some((p) => (p.startsWith('*.') ? host.endsWith(p.slice(1)) : host === p));
}

/**
 * @param {string[]} allow labels the project marked safe in its app.json (e.g. a staging-only "Finalizar pedido")
 * @returns {string|null} reason when the action needs human confirmation
 */
export function riskOf(action, el, allow = []) {
  if (!el || (action !== 'tap' && action !== 'submit')) return null;
  if (allow.some((a) => el.name?.toLowerCase().includes(a.toLowerCase()))) return null;
  const text = `${el.name ?? ''} ${el.testId ?? ''}`;
  const m = text.match(RISKY);
  return m ? `"${el.name}" looks sensitive (${m[0]})` : null;
}
