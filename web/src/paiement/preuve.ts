// Preuve anti-robot d'une commande (serveur : antiRobot de
// handlers_paiement.go) : défi lu dès que la commande peut servir, preuve de travail dans son
// Worker vérifié (captcha/pow), champs { altcha, hp, shown_at } rendus au plus tôt 3,1 s après
// la réception (le serveur refuse avant 3 s). Un défi sert une fois. Ne passe ni par transfer/
// ni par le moteur de chiffrement : la page Offres est une page d'information (check-dist).
import { getDemo } from "../app/demo-hooks";
import { solvePow } from "../captcha/pow";
import { lireDefi, type Preuve } from "./api";

/** Délai minimal entre la réception du défi et l'envoi (serveur : 3 s), comme transfer/client. */
const ATTENTE_MS = 3100;
/** Un défi vit 2 min ; au-delà de 1 min 45, un nouveau est lu. */
const VIE_MS = 105_000;

export class LimiteDefi extends Error {
  constructor() {
    super("limite");
  }
}

let prete: Promise<{ preuve: Preuve; receivedAt: number }> | null = null;

function lancer(): Promise<{ preuve: Preuve; receivedAt: number }> {
  const p = (async () => {
    const d = await lireDefi();
    if (d === "limite") throw new LimiteDefi();
    if (d === null) throw new Error("reseau");
    const proof = await solvePow(d.challenge);
    if (proof.kind !== "pow" || typeof proof.payload !== "string") throw new Error("reseau");
    return { preuve: { altcha: proof.payload, hp: "", shown_at: d.shownAt }, receivedAt: d.receivedAt };
  })();
  p.catch(() => undefined);
  return p;
}

/** Lit un défi et lance la preuve, s'il n'y en a pas déjà une. */
export function preparerPreuve(): void {
  if (getDemo() !== null) return; // démo : preuve factice, rien à calculer
  prete ??= lancer();
}

/** Champs anti-robot pour UNE commande ; LimiteDefi sur 429, Error("reseau") sinon. */
export async function obtenirPreuve(): Promise<Preuve> {
  if (getDemo() !== null) return { altcha: "demo", hp: "", shown_at: "demo" };
  let p = prete ?? lancer();
  prete = null;
  let r: { preuve: Preuve; receivedAt: number };
  try {
    r = await p;
  } catch (e) {
    throw e instanceof LimiteDefi ? e : new Error("reseau");
  }
  if (performance.now() - r.receivedAt > VIE_MS) {
    p = lancer();
    r = await p;
  }
  const attente = r.receivedAt + ATTENTE_MS - performance.now();
  if (attente > 0) await new Promise((ok) => setTimeout(ok, attente));
  return r.preuve;
}
