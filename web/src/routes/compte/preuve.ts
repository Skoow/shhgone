// Preuve anti-robot de l'inscription (conception compte §8.8 ; conception du compte par passkey
// §3.1 : calculée dès l'ouverture de la page, avant inscription/debut) : défi lu, preuve de
// travail dans son Worker, puis les champs { altcha, hp, shown_at } au plus
// tôt 3,1 s après la réception (proofForm). Un défi sert une fois ; échu (2 min) ou bientôt
// échu : un nouveau est lu. Aucune clé n'existe encore à ce moment : la clé du compte n'est
// tirée qu'après, par account/session.svelte.ts.
import { getDemo } from "../../app/demo-hooks";
import { solvePow } from "../../captcha/pow";
import { PREPARED_MIN_LEFT_MS, prepareCaptcha, proofForm, type CaptchaProof, type PreparedCaptcha } from "../../index";

type Preuve = { altcha: string; hp: string; shown_at: string };
let prete: { cap: Promise<PreparedCaptcha>; proof: Promise<CaptchaProof> } | null = null;

const origine = () => location.origin;

function lancer() {
  const cap = prepareCaptcha(origine());
  const proof = cap.then((c) => solvePow(c.challenge));
  proof.catch(() => undefined);
  prete = { cap, proof };
}

/** Champs anti-robot pour UNE requête ; erreurs : celles de prepareCaptcha (réseau, limite). */
export async function obtenirPreuve(): Promise<Preuve> {
  // Démo (compte essayable) : son faux serveur n'exige aucune preuve, comme pour un partage.
  if (getDemo() !== null) return { altcha: "demo", hp: "", shown_at: "demo" };
  if (prete === null) lancer();
  let p = prete!;
  prete = null;
  let cap: PreparedCaptcha;
  try {
    cap = await p.cap;
  } catch {
    lancer(); // défi illisible (coupure) : un seul nouvel essai
    p = prete!;
    prete = null;
    cap = await p.cap;
  }
  if (cap.expiresAt - performance.now() < PREPARED_MIN_LEFT_MS) {
    lancer();
    p = prete!;
    prete = null;
    cap = await p.cap;
  }
  return proofForm(cap, origine(), await p.proof);
}
