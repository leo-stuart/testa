# testa

MCP server for testing features you just implemented, on **web** (Playwright Chromium) and **iOS Simulator** (AXe + WebDriverAgent, plus Metro for React Native dev builds), with [Jev](https://docs.typesafe.ai) deciding each UI step. Works with any app, from Claude Code, Codex and Cursor.

The coding agent plans the scenario (goal, hints, data, assertions); Jev picks each tap/type from the DOM / accessibility tree as text — no screenshots, no per-click LLM round-trip. Reports come back with errors, HTTP calls, accessibility issues and evidence.

## Install

```sh
npm install -g testa     # or, from a checkout: npm install
testa setup                   # asks for the Jev key, downloads Chromium + AXe + WebDriverAgent, registers Claude Code / Codex / Cursor
testa doctor                  # checks everything and prints fixes
```

Restart your agent sessions afterwards. `testa agents uninstall` removes the registrations (config backups: `*.bak-testa`). Downloaded tools live in `~/.cache/testa/`. Tests: `npm test`.

## Configuration

Friendly settings, resolved in layers (later wins):

| Layer | Where | Set with |
|---|---|---|
| default | built in | — |
| user | `~/.config/testa/config.json` (mode 600) | `testa config set headless false` |
| project | `<project>/.testa/app.json` → `settings` | the `settings` MCP tool with `scope: "project"` |
| environment | `TYPESAFE_API_KEY`, `FT_*` | shell / CI |

`testa config` lists every setting, its value and where it came from. In a session you can just ask the agent ("deixa o browser escondido") — it uses the `settings` tool. The Jev key is per user and can only be set in the terminal (`testa config set jevApiKey <key>`), never through the agent or a project file.

| Setting | Default | |
|---|---|---|
| `jevApiKey` | — | TypeSafe Jev key |
| `jevModel` | `jev-latest` | |
| `headless` | `true` | `false` = watch tests in a real window |
| `showCursor` | on when visible | fake cursor + click ripple in the page |
| `slowMo` | `150` | ms between browser actions when visible |
| `allowedHosts` | — | extra web hosts besides localhost, *.vercel.app, ngrok (`*` = any) |
| `hideLogBox` | `true` | hide React Native LogBox toasts during runs |
| `iosInput` | `auto` | `auto`/`wda`/`axe` touch backend |
| `metroPort` | `8081` | |
| `wdaUrl` | `http://127.0.0.1:8100` | |
| `cacheDir` | `~/.cache/testa` | |

## Distribution

The package is self-contained (~50 kB: `bin/`, `src/`, `skill/`); binaries are downloaded by `setup`, keys are per user. To share it with a team:

1. **npm (recommended):** publish under your org scope (private npm, GitHub Packages or Verdaccio). Each dev runs `npm i -g <pkg> && testa setup`. Updates: `npm update -g <pkg>` (the agent registration points at the global install, so it keeps working).
2. **Git checkout:** `git clone … && npm install && npm run setup`. Same result, updates via `git pull`.
3. **Claude Code plugin (optional, later):** a marketplace repo can ship the skill + MCP entry; devs still run `testa setup` once for the key and tools.

Nothing about a specific app ships in the package: each project builds its own context on first use.

## Per-app context

**Rule: everything testa produces for a project lives in `<project>/.testa/`, and that directory is always git-ignored.** The first time it is created, `.testa/` is appended to the project's root `.gitignore` (created if missing) and an inner `.gitignore` with `*` is written as a second guard. Nothing in it is ever committed.

| File | What |
|---|---|
| `app.json` | urls, bundleId, start commands, test accounts, `allowedHosts`, `allowRisky`, per-project `settings` |
| `knowledge.md` | facts learned while testing (`remember` tool) — read at the start of every session |
| `scenarios/` | replayable scenarios with their start screen |
| `runs/` | evidence: `final.png`, `report.json` |
| `sessions/` | web login cookies |

`app_profile` also discovers routes from code: Next.js / expo-router / SvelteKit files and React Navigation `linking` configs (and warns when a linking config ignores OS deep links). If a client starts the server outside the repo, `app_profile({ projectDir })` switches project.

Example `app.json`:

```json
{
  "stack": "react-native",
  "ios": { "bundleId": "com.example.app" },
  "start": { "metro": { "command": "npx expo start", "port": 8081 }, "api": { "command": "npm run dev", "cwd": "../api", "port": 3021 } },
  "accounts": { "qa": { "email": "qa@example.com", "senha": "local-test-pw", "_env": "staging" } },
  "allowRisky": [],
  "settings": { "headless": false }
}
```

Accounts are test accounts for local/staging only; `"$VAR"` reads the value from the environment and `_`-prefixed keys are notes, never typed.

## Tools

| Tool | What it does |
|---|---|
| `app_profile` / `remember` | Read the app's context (config, notes, routes, scenarios); save new facts |
| `settings` | View/change settings (user or project scope); secrets excluded |
| `feature_context` | Git diff vs base: changed files, screens/routes, new testIDs, UI strings, endpoints |
| `start_app` / `app_logs` / `stop_app` | Start dev server / Metro / backend (or `app.json` presets), wait until ready, keep logs |
| `run_scenario` | Jev-driven run → pass/fail, steps, assertions, errors, HTTP calls, a11y issues, evidence. Options: `account`, `start`, `before`, `session`, `mocks`, `focus` |
| `replay` / `list_scenarios` | Deterministic re-run from the saved start; renamed elements self-heal via Jev |
| `navigate` | iOS RN: jump to any screen via the app's React Navigation (works when deep links are off). Web: url |
| `a11y_audit` | Web: axe-core WCAG audit. iOS: inputs hidden from VoiceOver, icon-only controls, unlabeled controls |
| `open` / `observe` / `act` / `screenshot` | Manual driving and debugging |

## What it sees

- **Web:** DOM elements (covered ones filtered via hit-testing), console/page errors, every XHR/fetch/document response (4xx/5xx bodies), mocks via `context.route`.
- **iOS:** AXe accessibility tree with heuristics for React Native: inputs hidden in accessible wrappers (named by the label above), icon-font buttons, layers (modals/sheets/stacked screens hide what's under them), iOS keyboard bars ignored.
- **React Native dev builds (any app, via Metro CDP):** current route + params, `navigate`, `console.error/warn`, exceptions, HTTP calls through an injected fetch/XHR hook, API mocks, LogBox toasts hidden during runs.
- **Server logs:** error lines from processes started with `start_app`.

## Mocks

`run_scenario({ mocks: [{ url: "/coupons/validate", status: 500 }] })` — substring or `regex: true`, optional `method`, `body`, `headers`, `delayMs`, `times`, `fail: true` (network error). Web uses Playwright routing; React Native patches `fetch`/`XMLHttpRequest` in the JS runtime. Mocked calls are labeled in the report and cleared after the run.

## Speed

One Jev pass per step (done? action incl. value→field pairs? tap target?), a focused second question only on low confidence. iOS taps go through WebDriverAgent W3C actions (~0.5s) when `vendor/wda` is installed, typing through one batched AXe call; the screen is read once per step (~0.6s).

## Safety

- Local gate blocks taps on sensitive labels (pagar, excluir, enviar, finalizar pedido, checkout, logout…) → `needs_confirmation` until `allowRisky: true` (or the label is in the project's `allowRisky`, e.g. a staging-only flow).
- Web hosts limited to localhost, *.vercel.app, ngrok + the project's `allowedHosts`. `TESTA_ALLOWED_HOSTS=*` disables.
- Project data stays in the git-ignored `.testa/`. Test accounts live in its `app.json` (or `"$VAR"` from env); `app_profile` masks their secrets, scenarios store only the account name, `remember` rejects secrets. Never use production credentials.
- Jev only chooses among listed options; screen text can't make it run arbitrary actions.

## Limits

- iOS: AXe types US-keyboard chars; other text is pasted via the simulator pasteboard.
- Hidden-input and layer detection are heuristics tuned on React Native apps; `a11y_audit` lists what they had to guess — fixing those labels makes tests (and VoiceOver) more reliable.
- Route/navigation/mocks on iOS need a React Native dev build connected to Metro.
- `assertions` are required in `run_scenario` (they are the test cases); vague ones like "works" are rejected. Replaying a scenario saved without them ends as `unverified`.
- Jev is weak at counting/math/dates: phrase assertions as observable facts.
