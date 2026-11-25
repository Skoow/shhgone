// Historique de l'appareil ↔ coffre privé du compte (conception compte §21.8, §21.2.3 point 4,
// §37.11 A-G2 et A-G8). Fonctions pures : la session (session.svelte.ts) les
// applique à l'ouverture et à chaque événement de partage ou de salon.
// - Une entrée du coffre est identifiée d'un appareil à l'autre par son lien (gestion, partage,
//   invitation) ; son `id` est celui de l'appareil qui l'a créée.
// - Contenu d'une entrée : le lien, les dates, la taille, le nombre d'éléments, la sorte dominante
//   ou le libellé local (salon) ou le titre du partage (envoi : `libelle`) ; JAMAIS
//   un mot de passe, un nom d'élément ni un contenu (cleanEntry à la relecture).
//   L'état des relectures (ouvertures, « détruit ») n'est pas synchronisé : chaque appareil relit.
// - Fusion : les entrées de l'appareil absentes du coffre y entrent (seulement celles créées
//   ici) ; celles du coffre absentes de l'appareil y
//   viennent (origine « compte ») ; une entrée « compte » absente du coffre a été retirée sur un
//   autre appareil et part d'ici ; une entrée finie depuis 7 jours part du coffre.
// Limite assumée : une entrée créée sur A, retirée sur B, revient dans le coffre à la prochaine
// connexion de A si A la garde encore (pas de pierre tombale ; elle s'efface 7 jours après sa fin).
import { HISTORY_KEEP_GONE_MS, cleanEntry, endOf, linkKey, type HistoryEntry, type Sorte } from "../history/store";
import type { CoffrePrive, EntreePrivee } from "./vaults";

export type Liste = Exclude<keyof CoffrePrive, "pass">;
const LISTE: Record<Sorte, Liste> = { envoi: "envois", recu: "recus", salon_cree: "salons", salon_rejoint: "rejoints" };
const SORTE: Record<Liste, Sorte> = { envois: "envoi", recus: "recu", salons: "salon_cree", rejoints: "salon_rejoint" };
const LISTES = Object.keys(SORTE) as Liste[];

export function versCoffre(e: HistoryEntry): { liste: Liste; valeur: EntreePrivee } {
  const base = { id: e.id, cree: e.createdAt, expire: e.expiresAt };
  switch (e.sorte) {
    case "envoi":
      // Titre du partage : seulement s'il y en a un (entrées d'avant : inchangées).
      return { liste: "envois", valeur: { ...base, gestion: e.manage, taille: e.sizeBytes, elements: e.itemsCount, ouvertures_max: e.maxOpens, ...(e.label !== "" ? { libelle: e.label } : {}) } };
    case "recu":
      return { liste: "recus", valeur: { ...base, lien: e.link, taille: e.sizeBytes, elements: e.itemsCount, format: e.format } };
    default:
      // Salon créé : son lien de gestion (S_gestion, « #s ») part au coffre (§10.4).
      return { liste: LISTE[e.sorte], valeur: { ...base, invitation: e.link, libelle: e.label, ...(e.sorte === "salon_cree" && e.manage !== "" ? { gestion: e.manage } : {}) } };
  }
}

/** Entrée du coffre en entrée d'historique (origine « compte ») ; mal formée : null. */
export function deCoffre(liste: Liste, v: EntreePrivee, now: number): HistoryEntry | null {
  const sorte = SORTE[liste];
  const cree = v.cree;
  return cleanEntry({
    id: v.id,
    sorte,
    origine: "compte",
    manage: sorte === "envoi" ? v.gestion : sorte === "salon_cree" ? (v.gestion ?? "") : "",
    link: sorte === "envoi" ? "" : sorte === "recu" ? v.lien : v.invitation,
    // Envoi : titre du partage, absent des entrées d'.
    label: sorte.startsWith("salon") ? v.libelle : sorte === "envoi" ? (v.libelle ?? "") : "",
    format: sorte === "recu" ? v.format : "",
    createdAt: cree,
    sizeBytes: sorte === "envoi" || sorte === "recu" ? v.taille : 0,
    itemsCount: sorte === "envoi" || sorte === "recu" ? v.elements : 0,
    expiresAt: v.expire,
    maxOpens: sorte === "envoi" ? v.ouvertures_max : 0,
    opensUsed: 0,
    opens: [],
    state: "ready",
    lastSeenAt: typeof cree === "number" ? Math.min(now, cree) : cree,
    endedAt: 0,
    destroyedHere: false,
  });
}

const fini = (e: HistoryEntry, now: number) => {
  const end = endOf(e, now);
  return end > 0 && now - end >= HISTORY_KEEP_GONE_MS;
};

/** Ajoute une entrée de l'appareil au coffre (même lien déjà là : rien). */
export function ajouterEntree(p: CoffrePrive, e: HistoryEntry): CoffrePrive {
  const { liste, valeur } = versCoffre(e);
  const k = linkKey(e);
  if (p[liste].some((v) => deCoffre(liste, v, 0) !== null && linkKey(deCoffre(liste, v, 0)!) === k)) return p;
  if (p[liste].some((v) => v.id === e.id)) return p;
  return { ...p, [liste]: [...p[liste], valeur] };
}

/**
 * Renommage d'un envoi sur cet appareil : le titre de l'entrée du même lien prend
 * celui de `e` ; absente du coffre : ajoutée. Rien d'autre ne change.
 */
export function renommerEntree(p: CoffrePrive, e: HistoryEntry): CoffrePrive {
  const { liste, valeur } = versCoffre(e);
  const k = linkKey(e);
  let found = false;
  const next = p[liste].map((v) => {
    const x = deCoffre(liste, v, 0);
    if (x === null || linkKey(x) !== k) return v;
    found = true;
    const out: EntreePrivee = { ...v };
    delete out.libelle;
    if ("libelle" in valeur) out.libelle = valeur.libelle;
    return out;
  });
  return found ? { ...p, [liste]: next } : ajouterEntree(p, e);
}

/** Retire du coffre l'entrée du même lien. */
export function retirerEntree(p: CoffrePrive, e: HistoryEntry): CoffrePrive {
  const liste = LISTE[e.sorte];
  const k = linkKey(e);
  return { ...p, [liste]: p[liste].filter((v) => {
    const x = deCoffre(liste, v, 0);
    return x === null ? v.id !== e.id : linkKey(x) !== k;
  }) };
}

export function fusionner(
  local: readonly HistoryEntry[],
  coffre: CoffrePrive,
  o: { now: number },
): { coffre: CoffrePrive | null; importer: HistoryEntry[]; retirer: string[] } {
  let change = false;
  // Les pass des offres payantes (pass.ts) ne sont pas de l'historique : gardés tels quels.
  const garde: CoffrePrive = { salons: [], recus: [], rejoints: [], envois: [], ...(coffre.pass !== undefined ? { pass: coffre.pass } : {}) };
  const duCoffre: HistoryEntry[] = [];
  for (const l of LISTES)
    for (const v of coffre[l]) {
      const e = deCoffre(l, v, o.now);
      // Mal formée (autre version, appareil défaillant) ou finie depuis 7 jours : retirée.
      if (e === null || fini(e, o.now) || duCoffre.some((x) => linkKey(x) === linkKey(e))) {
        change = true;
        continue;
      }
      garde[l].push(v);
      duCoffre.push(e);
    }
  const cles = new Set(duCoffre.map(linkKey));
  const ici = new Set(local.map(linkKey));
  const importer = duCoffre.filter((e) => !ici.has(linkKey(e)));
  const retirer = local.filter((e) => e.origine === "compte" && !cles.has(linkKey(e))).map((e) => e.id);
  let p = garde;
  for (const e of local) {
    if (e.origine === "local" && !cles.has(linkKey(e)) && !fini(e, o.now)) {
      const next = ajouterEntree(p, e);
      if (next !== p) {
        p = next;
        cles.add(linkKey(e));
        change = true;
      }
    }
  }
  return { coffre: change ? p : null, importer, retirer };
}
