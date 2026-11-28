// Preuve anti-robot des pages du compte (décision du 26 novembre ; conception du compte par
// passkey §3.1, §3.2, §3.4, §6.4) : inscription/debut (avant le geste), connexion/fin (après le
// geste) et recup. Le défi est lu et résolu en tâche de fond dès l'ouverture de l'écran
// (preparerPreuve), dans le Worker de captcha/pow ; il est renouvelé sans bruit avant son échéance
// tant que l'écran reste ouvert. obtenirPreuve rend les champs { altcha, hp, shown_at } au plus
// tôt 3,1 s après la réception (proofForm). Un défi sert une fois ; échu ou bientôt échu, un nouveau
// est lu. Rien ne se passe ici entre un geste et navigator.credentials : l'inscription envoie sa
// preuve avant le geste, la connexion la demande après la cérémonie (session.svelte.ts). Aucune
// clé n'existe à ce moment : la clé du compte n'est tirée qu'après, par account/session.svelte.ts.
import { getDemo } from "../../app/demo-hooks";
import { solvePow } from "../../captcha/pow";
import { CAPTCHA_MIN_MS, PREPARED_MIN_LEFT_MS, prepareCaptcha, proofForm, type CaptchaProof, type PreparedCaptcha } from "../../index";

type Preuve = { altcha: string; hp: string; shown_at: string };
type Prete = {
  cap: Promise<PreparedCaptcha>;
  proof: Promise<CaptchaProof>;
  arret: AbortController;
  /** Défi lu (instant de réception, horloge monotone) et preuve calculée ; null avant. */
  resolue: { cap: PreparedCaptcha; recu: number } | null;
  /** Lecture ou calcul échoué : relancé au prochain preparerPreuve. */
  echec: boolean;
};
let prete: Prete | null = null;

/** Renouvelée quand il lui reste moins de 45 s (un défi vit 2 min) : prête au clic sans attente. */
const RENOUVELER_RESTE_MS = 45_000;

const origine = () => location.origin;

function lancer(): Prete {
  prete?.arret.abort();
  const arret = new AbortController();
  let recu = 0;
  const cap = prepareCaptcha(origine()).then((c) => ((recu = performance.now()), c));
  const p: Prete = { cap, proof: cap.then((c) => solvePow(c.challenge, arret.signal)), arret, resolue: null, echec: false };
  Promise.all([cap, p.proof]).then(
    ([c]) => void (p.resolue = { cap: c, recu }),
    () => void (p.echec = true),
  );
  prete = p;
  return p;
}

/**
 * Lit un défi et lance son calcul en tâche de fond, s'il n'y en a pas déjà un encore valable
 * (à l'affichage d'un écran du compte, puis à intervalle régulier tant qu'il est ouvert).
 */
export function preparerPreuve(): void {
  if (getDemo() !== null) return; // démo : preuve factice, rien à calculer
  const r = prete?.resolue;
  if (prete === null || prete.echec || (r && r.cap.expiresAt - performance.now() < RENOUVELER_RESTE_MS)) lancer();
}

/** La preuve est calculée et peut partir sans attendre (sinon l'écran dit « Vérification en cours… »). */
export function preuvePrete(): boolean {
  if (getDemo() !== null) return true;
  const r = prete?.resolue;
  const t = performance.now();
  return !!r && r.cap.expiresAt - t >= PREPARED_MIN_LEFT_MS && t - r.recu >= CAPTCHA_MIN_MS;
}

/** Champs anti-robot pour UNE requête ; erreurs : celles de prepareCaptcha (réseau, limite) ou du calcul. */
export async function obtenirPreuve(): Promise<Preuve> {
  // Démo (compte essayable) : son faux serveur n'exige aucune preuve, comme pour un partage.
  if (getDemo() !== null) return { altcha: "demo", hp: "", shown_at: "demo" };
  let p = prete ?? lancer();
  prete = null;
  let cap: PreparedCaptcha;
  try {
    cap = await p.cap;
  } catch {
    p = lancer(); // défi illisible (coupure) : un seul nouvel essai
    prete = null;
    cap = await p.cap;
  }
  if (cap.expiresAt - performance.now() < PREPARED_MIN_LEFT_MS) {
    p = lancer();
    prete = null;
    cap = await p.cap;
  }
  return proofForm(cap, origine(), await p.proof);
}
