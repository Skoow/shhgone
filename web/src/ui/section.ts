// Défilement vers une section de l'accueil depuis n'importe quel écran, sans « # » dans
// l'adresse (le « # » est réservé aux clés). Depuis une autre entrée (pages d'information,
// offres), la page se recharge : la section voulue passe alors par sessionStorage, le temps
// d'un chargement, et l'accueil la reprend au montage.
import { tick } from "svelte";
import { navigate, otherEntry, router } from "../app/router.svelte";
import { reducedMotion } from "./motion";

const CLE = "shh-section";
const ATTENTE_MS = 2000;

type Cible = { id: string; faq: boolean };

/** Attend que l'élément existe (écran monté, transition finie), au plus ATTENTE_MS. */
async function trouver(id: string): Promise<HTMLElement | null> {
  const fin = performance.now() + ATTENTE_MS;
  for (;;) {
    const el = document.getElementById(id);
    if (el) return el;
    if (performance.now() > fin) return null;
    await new Promise((r) => requestAnimationFrame(() => r(null)));
  }
}

async function defiler({ id, faq }: Cible): Promise<void> {
  await tick();
  const el = await trouver(id);
  if (!el) return;
  if (faq && el instanceof HTMLDetailsElement) el.open = true;
  // Une image après, pour passer après le retour en haut de la navigation.
  await new Promise((r) => requestAnimationFrame(() => r(null)));
  el.scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth", block: "start" });
  const cible = faq ? el.querySelector<HTMLElement>("summary") : el.querySelector<HTMLElement>("h2");
  cible?.focus({ preventScroll: true });
}

/** Va à la section `id` de l'accueil ; `faq` : ouvre la question (élément <details>). */
export async function allerSection(id: string, faq = false): Promise<void> {
  const c: Cible = { id, faq };
  if (router.current.name !== "home") {
    if (otherEntry("/")) {
      try {
        sessionStorage.setItem(CLE, JSON.stringify(c));
      } catch {
        // Stockage refusé : l'accueil s'ouvre en haut.
      }
      navigate("/");
      return;
    }
    navigate("/");
  }
  await defiler(c);
}

/** À l'accueil, au montage : reprend la section demandée avant un rechargement. */
export function reprendreSection(): void {
  let c: Cible | null = null;
  try {
    const brut = sessionStorage.getItem(CLE);
    sessionStorage.removeItem(CLE);
    const v = brut ? (JSON.parse(brut) as unknown) : null;
    if (v && typeof v === "object" && typeof (v as Cible).id === "string" && /^[a-z0-9-]{1,40}$/.test((v as Cible).id)) {
      c = { id: (v as Cible).id, faq: (v as Cible).faq === true };
    }
  } catch {
    return;
  }
  if (c) void defiler(c);
}
