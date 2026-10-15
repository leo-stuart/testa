// Scenario runner: the coding agent plans, Jev picks each micro-step locally.
import { ask, hasJevKey } from './jev.mjs';
import { riskOf } from './policy.mjs';

const INPUT_KIND = /^(input|textarea|select|textbox|combobox|TextField|SecureTextField|TextView|SearchField)/i;
const REFINE_BELOW = 0.35; // target confidence that triggers a focused second question
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const elKey = (e) => `${e.kind}|${e.name}`;
// Field identity across screens: hidden RN inputs lose their placeholder once typed into.
const fieldKey = (e) => `${e.name.split(' — ')[0]}|${Math.round(e.y / 20)}`;

export function describeEl(e) {
  let s = `${e.id} ${e.kind} "${e.name}"`;
  if (e.value) s += ` value="${e.value}"`;
  if (e.filledWith) s += ` (already filled with "${e.filledWith}")`;
  if (e.testId && e.testId !== e.name) s += ` testId=${e.testId}`;
  if (e.ctx) s += ` in ${e.ctx}`;
  if (e.region) s += ` @${e.region}`;
  if (e.offscreen) s += ' (offscreen)';
  if (e.isNew) s += ' [new]';
  if (e.focus) s += ' [feature]';
  return s;
}

/** Add position, "appeared since last screen" and "touched by this feature" hints. */
export function annotate(obs, prev, focus = []) {
  const before = prev ? new Set(prev.elements.map(elKey)) : null;
  const terms = focus.map((f) => f.toLowerCase()).filter((f) => f.length > 2);
  for (const e of obs.elements) {
    if (obs.vh && !e.offscreen) e.region = e.y < obs.vh * 0.2 ? 'top' : e.y > obs.vh * 0.8 ? 'bottom' : undefined;
    if (before && !before.has(elKey(e))) e.isNew = true;
    const hay = `${e.name} ${e.testId ?? ''}`.toLowerCase();
    if (terms.some((t) => hay.includes(t))) e.focus = true;
  }
  return obs;
}

// Elements + visible text: a status message appearing is a change even if no control changed.
const signature = (obs) => obs.elements.map((e) => `${e.kind}|${e.name}|${e.value ?? ''}`).join('\n') + obs.where + obs.text.slice(0, 2000);

function screenState(obs) {
  return {
    title: obs.title,
    where: obs.where,
    route: obs.route ? `${obs.route.name}${obs.route.params && Object.keys(obs.route.params).length ? ` ${JSON.stringify(obs.route.params).slice(0, 200)}` : ''}` : undefined,
    elements: obs.elements.map(describeEl).join('\n'),
    visible_text: obs.text.slice(0, 1500),
  };
}

function actionOptions(remainingKeys, inputs = [], filled = new Map()) {
  const opts = {
    tap: 'Tap/click one element on screen (button, link, tab, list item, checkbox)',
    submit: 'Press Enter/Return to submit the focused form',
    scroll_down: 'Scroll down to reveal content that is not visible yet',
    scroll_up: 'Scroll up',
    back: 'Navigate back to the previous screen',
    wait: 'Wait because the screen is still loading',
  };
  // Value×field pairs let Jev match data to the right field in the same pass.
  if (remainingKeys.length * inputs.length <= 200) {
    for (const k of remainingKeys) for (const e of inputs) if (!filled.has(fieldKey(e)) || filled.get(fieldKey(e)) === k) opts[`type:${k}:${e.id}`] = `Type the provided "${k}" value into field ${e.kind} "${e.name}"${e.value ? ` (now "${e.value}")` : ''}`;
  } else {
    for (const k of remainingKeys) opts[`type_${k}`] = `Fill a text field with the provided data value "${k}"`;
  }
  return opts;
}

const targetCriteria = (pool) => Object.fromEntries(pool.slice(0, 250).map((e) => [e.id, describeEl(e).slice(e.id.length + 1)]));

export async function checkAssertions(obs, assertions, { events = [], network = [] } = {}) {
  if (!assertions.length) return [];
  const questions = {};
  assertions.forEach((a, i) => {
    questions[`a${i}`] = {
      type: 'noul',
      instructions: `Using \`screen\`, \`errors\` and \`network\` (HTTP calls made during the test), is this statement true right now? Statement: "${a}"`,
      criteria: { true: 'The evidence clearly shows the statement holds', false: 'The statement does not hold or cannot be confirmed' },
    };
  });
  const state = {
    screen: screenState(obs),
    errors: events.map((e) => `${e.kind}: ${e.text}`).slice(0, 40),
    network: network.slice(-60).map((n) => `${n.status} ${n.method} ${n.url}`),
  };
  const { answers } = await ask(state, questions);
  return assertions.map((a, i) => ({ assertion: a, p: Math.round(answers[`a${i}`].noul * 100) / 100, pass: answers[`a${i}`].noul >= 0.6 }));
}

/**
 * @param {object} o
 * @param {import('./drivers/web.mjs').WebDriver|import('./drivers/ios.mjs').IosDriver} o.driver
 */
export async function runScenario({ driver, goal, hints = [], data = {}, assertions = [], focus = [], maxSteps = 15, allowRisky = false, riskAllow = [], eventsMarked = false, capture = true, onStep }) {
  if (!hasJevKey()) throw new Error('TYPESAFE_API_KEY not set — run_scenario needs Jev. Use observe/act for manual driving.');
  if (capture && !eventsMarked) await driver.markEvents();
  const history = [];
  const steps = [];
  const typed = new Set();
  const filled = new Map(); // fieldKey -> data key typed into it
  const a11y = new Map(); // rule|name -> issue, collected across every screen visited
  let missingTestIds = 0;
  const collectA11y = (o) => {
    for (const i of o.a11y ?? []) a11y.set(`${i.rule}|${i.name}|${o.route?.name ?? ''}`, { ...i, screen: o.route?.name ?? o.title });
    missingTestIds = Math.max(missingTestIds, o.missingTestIds ?? 0);
  };
  const t0 = Date.now();
  const timing = { jevMs: 0, jevCalls: 0, observeMs: 0, actMs: 0 };
  let status = 'max_steps';
  let detail = '';
  let sameCount = 0;
  let lowConf = 0;
  let prevSig = '';
  let prevObs = null;
  let obs;
  let startRoute;

  const jev = async (state, questions) => {
    const r = await ask(state, questions);
    timing.jevMs += r.ms;
    timing.jevCalls++;
    return r.answers;
  };

  const hud = (text, tone) => driver.hud?.(text, tone);
  await hud(`Iniciando · ${goal}`);
  for (let i = 0; i < maxSteps; i++) {
    let t = Date.now();
    obs = annotate(await driver.observe(), prevObs, focus);
    // Empty tree = splash/transition: wait (up to ~10s) without spending a step.
    for (let w = 0; !obs.elements.length && w < 12; w++) {
      await sleep(700);
      obs = annotate(await driver.observe(), prevObs, focus);
    }
    timing.observeMs += Date.now() - t;
    if (i === 0) startRoute = obs.route;
    collectA11y(obs);
    prevObs = obs;
    const sig = signature(obs);
    // (Typing into fields whose value the tree hides looks like "no change"; don't flag those.)
    if (sig === prevSig && history.length && steps.at(-1)?.action !== 'type' && !history.at(-1).endsWith(')')) history[history.length - 1] += ' (no visible change)';
    sameCount = sig === prevSig ? sameCount + 1 : 0;
    prevSig = sig;
    if (sameCount >= 3) { status = 'stuck'; detail = 'Screen did not change after 3 actions'; break; }

    const inputs = obs.elements.filter((e) => INPUT_KIND.test(e.kind));
    for (const e of inputs) if (filled.has(fieldKey(e))) e.filledWith = filled.get(fieldKey(e));
    // Typing is only an option when there is somewhere to type.
    const remaining = inputs.length ? Object.keys(data).filter((k) => !typed.has(k)) : [];
    const base = { goal, hints, available_data: remaining, history: history.slice(-12), screen: screenState(obs) };
    if (!obs.elements.length) { status = 'stuck'; detail = 'No candidate elements on screen'; break; }

    // One parallel pass: done? which action? best tap target? best input target?
    const questions = {
      done: {
        type: 'noul',
        instructions: 'Has the `goal` been fully achieved, as shown by `screen` (and consistent with `history`)?',
        criteria: { true: 'Screen clearly shows the goal outcome', false: 'More actions are still needed' },
      },
      action: {
        type: 'choice',
        instructions: 'What is the single best next action to progress toward the `goal`? Follow `hints` when they apply. Do not repeat an action from `history` that had no effect.',
        criteria: actionOptions(remaining, inputs, filled),
      },
      tap_target: {
        type: 'choice',
        instructions: 'If the next action is a tap, which element should be tapped to progress toward the `goal`? Use `hints` and `history`.',
        criteria: targetCriteria(obs.elements),
      },
    };
    if (remaining.length * inputs.length > 200) {
      questions.type_target = {
        type: 'choice',
        instructions: `If the next action is filling a field with one of \`available_data\`, which input field should receive it?`,
        criteria: targetCriteria(inputs),
      };
    }
    const a = await jev(base, questions);
    const doneP = Math.round(a.done.noul * 100) / 100;
    if (a.done.noul >= 0.7) { status = 'done'; break; }

    const actionKey = a.action.choice;
    const pair = actionKey.match(/^type:(.+):(e\d+)$/);
    const action = pair || actionKey.startsWith('type_') ? 'type' : actionKey;
    const dataKey = pair ? pair[1] : action === 'type' ? actionKey.slice(5) : undefined;

    let el = pair ? inputs.find((e) => e.id === pair[2]) : null;
    let conf = a.action.confidence;
    if (action === 'tap' || (action === 'type' && !el)) {
      const pool = action === 'type' ? inputs : obs.elements;
      let pick = action === 'type' ? a.type_target : a.tap_target;
      // Low confidence from the generic question: ask again with the action fixed.
      if (!pick || pick.confidence < REFINE_BELOW) {
        const what = action === 'type' ? `type the "${dataKey}" value into` : 'tap';
        const r = await jev(base, {
          target: { type: 'choice', instructions: `Which on-screen element should we ${what} next to progress toward the \`goal\`? Use \`hints\` and \`history\`.`, criteria: targetCriteria(pool) },
        });
        pick = r.target;
      }
      el = pool.find((e) => e.id === pick.choice);
      conf = pick.confidence;
      if (conf < 0.3 && ++lowConf >= 2) {
        const top = Object.entries(pick.probabilities).sort((x, y) => y[1] - x[1]).slice(0, 3)
          .map(([id, p]) => `${describeEl(pool.find((e) => e.id === id))} p=${p.toFixed(2)}`);
        status = 'uncertain';
        detail = `Low confidence picking target. Top candidates:\n  ${top.join('\n  ')}\nAdd hints or drive manually with act.`;
        break;
      }
      if (conf >= 0.3) lowConf = 0;
    }

    const risk = riskOf(action, el, riskAllow);
    if (risk && !allowRisky) {
      status = 'needs_confirmation';
      detail = `Blocked: ${risk}. Ask the user, then re-run with allowRisky=true.`;
      break;
    }

    const label = `${action}${dataKey ? `(${dataKey})` : ''}${el ? ` ${el.kind} "${el.name}"` : ''}`;
    // Same action 3x in a row on the same screen is a loop, not progress.
    const recent = steps.slice(-2).map((x) => x.label);
    if (recent.length === 2 && recent.every((l) => l === label) && steps.slice(-2).every((x) => x.where === obs.where)) {
      status = 'stuck';
      detail = `Repeating "${label}" without reaching the goal (last done p=${doneP}). Refine the goal/hints or check the screen with observe.`;
      break;
    }
    await hud(`Passo ${steps.length + 1} · ${goal}`);
    t = Date.now();
    try {
      await driver.act({ action, el, value: dataKey ? data[dataKey] : undefined });
      if (dataKey) { typed.add(dataKey); filled.set(fieldKey(el), dataKey); }
      history.push(label);
    } catch (err) {
      history.push(`${label} FAILED: ${String(err.message).split('\n')[0]}`);
    }
    timing.actMs += Date.now() - t;
    steps.push({ action, dataKey, kind: el?.kind, name: el?.name, testId: el?.testId, ctx: el?.ctx, confidence: Math.round(conf * 100) / 100, doneP, label, where: obs.where });
    onStep?.(steps.length, label);
  }

  obs = await driver.observe();
  collectA11y(obs);
  if (status === 'stuck' || status === 'max_steps' || status === 'uncertain') {
    // Most "stuck" runs are a form waiting for a value nobody provided.
    const left = Object.keys(data).filter((k) => !typed.has(k));
    const empty = obs.elements.filter((e) => INPUT_KIND.test(e.kind) && !e.value);
    if (empty.length && !left.length) detail += `\nInput fields on screen and no unused data to fill them: ${empty.map((e) => `"${e.name}"`).join(', ')}. Pass values in data (e.g. {"cep": "..."}) if the flow needs them.`;
  }
  const captured = capture ? await driver.takeEvents() : { events: [], network: [] };
  const results = capture ? await checkAssertions(obs, assertions, captured) : [];
  const passed = status === 'done' && results.every((r) => r.pass);
  const failedN = results.filter((r) => !r.pass).length;
  if (capture) {
    await hud(passed ? `Passou · ${results.length}/${results.length} casos` : status === 'done' ? `Falhou · ${failedN} de ${results.length} casos` : status === 'needs_human' ? 'Precisa de você · captcha' : `Parou · ${status}`,
      passed ? 'ok' : status === 'needs_human' ? 'human' : 'fail');
  }
  return {
    status: passed ? 'passed' : status === 'done' ? 'failed_assertions' : status,
    detail, steps, history, assertions: results, events: captured.events, network: captured.network, logSource: captured.source,
    a11y: [...a11y.values()], missingTestIds, startRoute,
    finalScreen: obs, timing: { totalMs: Date.now() - t0, ...timing },
  };
}

function findSaved(obs, s) {
  return (s.testId && obs.elements.find((e) => e.testId === s.testId))
    || obs.elements.find((e) => e.kind === s.kind && e.name === s.name && (!s.ctx || e.ctx === s.ctx))
    || obs.elements.find((e) => e.kind === s.kind && e.name === s.name)
    || obs.elements.find((e) => e.name === s.name);
}

/**
 * Deterministic replay of saved steps. If a saved element is gone (renamed, moved),
 * Jev re-picks it once and the step is marked healed so the caller can persist it.
 */
export async function replayScenario({ driver, scenario, data = {}, allowRisky = false, riskAllow = [], skipEvents = false, heal = true, firstStepTries = 6 }) {
  if (!skipEvents) await driver.markEvents();
  const t0 = Date.now();
  const log = [];
  const steps = scenario.steps.map((s) => ({ ...s }));
  const healed = [];
  for (const [i, s] of steps.entries()) {
    let el = null;
    let obs;
    if (s.name !== undefined || s.testId) {
      for (let tries = 0, max = i === 0 ? firstStepTries : 6; tries < max && !el; tries++) {
        obs = await driver.observe();
        el = findSaved(obs, s);
        if (!el) await sleep(400);
      }
      if (!el && heal && hasJevKey()) {
        const pool = s.action === 'type' ? obs.elements.filter((e) => INPUT_KIND.test(e.kind)) : obs.elements;
        const { answers } = await ask({ goal: scenario.goal, step: `${s.action}${s.dataKey ? ` the "${s.dataKey}" value into` : ''} ${s.kind} "${s.name}"`, screen: screenState(obs) }, {
          target: {
            type: 'choice',
            instructions: 'The UI changed since this `step` was recorded. Which current element plays the same role as the recorded one? Choose "none" if it is truly gone.',
            criteria: { ...targetCriteria(pool), none: 'No equivalent element on this screen' },
          },
        });
        if (answers.target.choice !== 'none' && answers.target.confidence >= 0.5) {
          el = pool.find((e) => e.id === answers.target.choice);
          healed.push(`step ${i + 1}: ${s.kind} "${s.name}" → ${el.kind} "${el.name}" (p=${answers.target.confidence.toFixed(2)})`);
          Object.assign(s, { kind: el.kind, name: el.name, testId: el.testId, ctx: el.ctx });
        }
      }
      if (!el) {
        const captured = skipEvents ? { events: [] } : await driver.takeEvents();
        return { status: 'failed', detail: `Step ${i + 1}: element ${s.kind} "${s.name}" not found`, failedAt: i, log, healed, events: captured.events, timing: { totalMs: Date.now() - t0 } };
      }
    }
    const risk = riskOf(s.action, el, riskAllow);
    if (risk && !allowRisky) return { status: 'needs_confirmation', detail: risk, log, healed, events: [], timing: { totalMs: Date.now() - t0 } };
    await driver.act({ action: s.action, el, value: s.dataKey ? (data[s.dataKey] ?? scenario.data?.[s.dataKey]) : undefined });
    log.push(`${s.action}${s.dataKey ? `(${s.dataKey})` : ''}${el ? ` "${el.name}"` : ''}`);
  }
  if (skipEvents) return { status: 'passed', log, healed, steps, timing: { totalMs: Date.now() - t0 } };
  const obs = await driver.observe();
  const captured = await driver.takeEvents();
  const assertions = scenario.assertions ?? [];
  const results = hasJevKey() ? await checkAssertions(obs, assertions, captured) : [];
  // Steps replayed but nothing checked: say so instead of reporting a pass.
  const unverified = !assertions.length;
  return {
    status: unverified ? 'unverified' : results.every((r) => r.pass) ? 'passed' : 'failed_assertions',
    detail: unverified ? 'Scenario has no assertions; steps replayed but nothing was checked. Add assertions to the scenario file or re-run with run_scenario + saveAs.' : undefined,
    log, healed, steps, assertions: results, events: captured.events, network: captured.network,
    finalScreen: obs, timing: { totalMs: Date.now() - t0 },
  };
}
