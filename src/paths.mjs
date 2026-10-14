// Where downloaded tools live. Default: user cache (works for npm/npx installs where the package dir
// is read-only or ephemeral); a vendor/ dir inside a source checkout still works for development.
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import './settings.mjs';

const PKG_VENDOR = fileURLToPath(new URL('../vendor', import.meta.url));

export function cacheDir() {
  return process.env.TESTA_CACHE_DIR || join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'testa');
}

function pick(rel) {
  const cached = join(cacheDir(), rel);
  if (existsSync(cached)) return cached;
  const vendored = join(PKG_VENDOR, rel);
  return existsSync(vendored) ? vendored : cached;
}

export const axePath = () => process.env.AXE_PATH || (existsSync(pick('axe/axe')) ? pick('axe/axe') : 'axe');
export const wdaAppPath = () => pick('wda/WebDriverAgentRunner-Runner.app');
