/**
 * Test cases are required: a run without checks only proves Jev thought it reached the goal.
 * An assertion is vague when it has nothing observable left once filler and "it works" words
 * are removed ("Funciona", "Login works", "Everything OK", "No errors").
 */
const VAGUE = new Set(`
  it it's its the a an and is are be should must will everything all feature flow app page screen
  works work working worked ok okay fine correct correctly properly good success successful successfully
  pass passes passed expected as no errors error issues problems
  o os as e é está esta estão deve devem tudo todo funciona funcionando funcionar funcionou
  passa passou sucesso certo correto corretamente bem esperado como sem erro erros problema problemas
  deu fluxo tela página pagina
`.split(/\s+/).filter(Boolean));

// "Login works", "Checkout funciona": one subject plus a verdict is still not observable.
const VERDICT = /^(works?|working|worked|ok|okay|fine|passes|passed|funciona\w*|passa|passou|certo|correto|sucesso)$/;

export function vagueAssertions(assertions = []) {
  return assertions.filter((a) => {
    const words = (a.toLowerCase().normalize('NFC').match(/[\p{L}\p{N}'$/._-]+/gu) ?? []).map((w) => w.replace(/[.]+$/, ''));
    const concrete = words.filter((w) => !VAGUE.has(w));
    return concrete.length === 0 || (concrete.length === 1 && words.some((w) => VERDICT.test(w)));
  });
}

export const ASSERTION_HELP =
  'Each assertion must be an observable fact at the end of the run: text or element on screen, or an HTTP call ' +
  '(e.g. "Cupom aplicado appears in the order summary", "A POST to /orders returned 2xx", "No error message is shown"). ' +
  'Derive them from feature_context (new strings, testIDs, endpoints).';
