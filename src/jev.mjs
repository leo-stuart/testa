// Minimal client for TypeSafe's Jev (System One) decision API.
// Docs: https://docs.typesafe.ai/api

import './settings.mjs'; // loads ~/.config/testa/config.json (key, model) into process.env

const RETRYABLE = new Set([429, 529, 502, 503]);

export function hasJevKey() {
  return Boolean(process.env.TYPESAFE_API_KEY);
}

/**
 * Ask Jev several questions about one state in a single parallel pass.
 * @param {object|string} state
 * @param {Record<string, {type:'noul'|'choice'|'score', instructions:any, criteria?:any}>} questions
 * @returns {Promise<{answers: Record<string, any>, ms: number, usage?: object}>}
 */
export async function ask(state, questions) {
  const key = process.env.TYPESAFE_API_KEY;
  if (!key) throw new Error('Jev API key not set: run `testa config set jevApiKey <key>` (get one at https://console.typesafe.ai)');

  const body = JSON.stringify({ model: process.env.JEV_MODEL || 'jev-latest', state, questions });
  const endpoint = process.env.JEV_ENDPOINT || 'https://api.typesafe.ai/v1/systemone';
  const started = Date.now();
  let delay = 300;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body,
    });
    if (res.ok) {
      const json = await res.json();
      return { answers: json.answers, usage: json.usage, ms: Date.now() - started };
    }
    if (RETRYABLE.has(res.status) && attempt < 4) {
      await new Promise((r) => setTimeout(r, delay));
      delay *= 2;
      continue;
    }
    throw new Error(`Jev ${res.status}: ${(await res.text()).slice(0, 500)}`);
  }
}
