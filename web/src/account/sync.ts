// « Mes partages » de l'appareil ↔ coffre privé du compte (spec §33, D42-30 ; conception compte
// §21.8, §37.11 A-G2 et A-G8). Fonctions pures : la session (session.svelte.ts) les applique à
// l'ouverture et à chaque ajout ou retrait fait sur l'appareil.
// - Listes du coffre (format d'avant le 25 novembre, inchangé) : `envois` { id, cree, expire,
//   gestion, taille, elements, ouvertures_max, libelle? } et `salons` { id, cree, expire,
//   invitation, libelle, gestion }. `recus` et `rejoints` (liens reçus et salons rejoints, plus
//   gardés) sont vidés.
// - Une entrée est identifiée d'un appareil à l'autre par son lien de gestion ; son `id` est celui
//   de l'appareil qui l'a créée. JAMAIS le lien de partage ni le mot de passe (nettoyer à la
//   relecture). L'état des relectures (ouvertures, « détruit ») n'est pas synchronisé : chaque
//   appareil relit.
// - Fusion : les entrées créées ici et absentes du coffre y entrent ; celles du coffre absentes de
//   l'appareil y viennent (origine « compte ») ; une entrée « compte » absente du coffre a été
//   retirée sur un autre appareil et part d'ici ; une entrée finie depuis 7 jours part du coffre.
// Limite assumée : une entrée créée sur A, retirée sur B, revient dans le coffre à la prochaine
// connexion de A si A la garde encore (pas de pierre tombale ; elle s'efface 7 jours après sa fin).
import { cleDe, nettoyer, perime, type Partage } from "../storage/partages";
import type { CoffrePrive, EntreePrivee } from "./vaults";

type Liste = "envois" | "salons";
const listeDe = (p: Pick<Partage, "sorte">): Liste => (p.sorte === "envoi" ? "envois" : "salons");

export function versCoffre(p: Partage): EntreePrivee {
  const base = { id: p.id, cree: p.creeLe, expire: p.echeance, gestion: p.gestion };
  if (p.sorte === "envoi") return { ...base, taille: p.taille, elements: p.elements, ouvertures_max: p.ouverturesMax, ...(p.nom !== "" ? { libelle: p.nom } : {}) };
  return { ...base, invitation: p.invitation, libelle: "" };
}

/** Entrée du coffre en entrée de l'appareil (origine « compte ») ; mal formée : null. */
export function deCoffre(liste: Liste, v: EntreePrivee, now: number): Partage | null {
  const envoi = liste === "envois";
  return nettoyer({
    id: v.id,
    sorte: envoi ? "envoi" : "salon",
    origine: "compte",
    gestion: v.gestion,
    invitation: envoi ? "" : v.invitation,
    nom: envoi ? (v.libelle ?? "") : "",
    taille: envoi ? v.taille : 0,
    elements: envoi ? v.elements : 0,
    creeLe: v.cree,
    echeance: v.expire,
    ouvertures: 0,
    ouverturesMax: envoi ? v.ouvertures_max : 0,
    etat: "actif",
    vuLe: typeof v.cree === "number" ? Math.min(now, v.cree) : v.cree,
    finLe: 0,
    detruitIci: false,
  });
}

const cleCoffre = (liste: Liste, v: EntreePrivee): string | null => {
  const p = deCoffre(liste, v, 0);
  return p === null ? null : cleDe(p);
};

/** Ajoute une entrée de l'appareil au coffre (même lien de gestion ou même id déjà là : rien). */
export function ajouterEntree(c: CoffrePrive, p: Partage): CoffrePrive {
  const l = listeDe(p);
  const k = cleDe(p);
  if (c[l].some((v) => v.id === p.id || cleCoffre(l, v) === k)) return c;
  return { ...c, [l]: [...c[l], versCoffre(p)] };
}

/** Retire du coffre l'entrée du même lien de gestion. */
export function retirerEntree(c: CoffrePrive, p: Partage): CoffrePrive {
  const l = listeDe(p);
  const k = cleDe(p);
  return { ...c, [l]: c[l].filter((v) => {
    const x = cleCoffre(l, v);
    return x === null ? v.id !== p.id : x !== k;
  }) };
}

export function fusionner(local: readonly Partage[], coffre: CoffrePrive, now: number): { coffre: CoffrePrive | null; importer: Partage[]; retirer: string[] } {
  // Listes plus gardées (liens reçus, salons rejoints) : vidées.
  let change = coffre.recus.length > 0 || coffre.rejoints.length > 0;
  const garde: CoffrePrive = { salons: [], recus: [], rejoints: [], envois: [], ...(coffre.pass !== undefined ? { pass: coffre.pass } : {}) };
  const duCoffre: Partage[] = [];
  for (const l of ["envois", "salons"] as const)
    for (const v of coffre[l]) {
      const p = deCoffre(l, v, now);
      // Mal formée (autre version, appareil défaillant), finie depuis 7 jours ou en double : retirée.
      if (p === null || perime(p, now) || duCoffre.some((x) => cleDe(x) === cleDe(p))) {
        change = true;
        continue;
      }
      garde[l].push(v);
      duCoffre.push(p);
    }
  const cles = new Set(duCoffre.map(cleDe));
  const ici = new Set(local.map(cleDe));
  const importer = duCoffre.filter((p) => !ici.has(cleDe(p)));
  const retirer = local.filter((p) => p.origine === "compte" && !cles.has(cleDe(p))).map((p) => p.id);
  let c = garde;
  for (const p of local) {
    if (p.origine !== "local" || cles.has(cleDe(p)) || perime(p, now)) continue;
    const next = ajouterEntree(c, p);
    if (next !== c) {
      c = next;
      cles.add(cleDe(p));
      change = true;
    }
  }
  return { coffre: change ? c : null, importer, retirer };
}
