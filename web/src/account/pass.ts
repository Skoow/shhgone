// Pass des offres payantes dans le coffre PRIVÉ du compte (conception du paiement §6.2, DP-8) :
// ouvert seulement avec le mot de passe (jamais par le séquestre du profil), pour retrouver une
// offre payée sur un autre appareil. À l'ouverture d'une session : les pass de l'appareil absents
// du coffre y sont écrits, ceux du coffre absents de l'appareil y sont rangés (base des pass de l'appareil,
// paiement/pass.ts). Le serveur du compte ne voit qu'un coffre chiffré de plus ; rien ne relie le
// compte au paiement chez nous (le serveur du paiement ne connaît pas le compte).
import { b64u, unb64u } from "../engine/pure";
import { garder, lirePasses, ORIGINES_PASS, paysDe, type OriginePass, type PassGarde } from "../paiement/pass";
import type { CoffrePrive, EntreePrivee } from "./vaults";

/** Entrée du coffre : identifiant de l'enregistrement de l'appareil, pass, formule et pays déclaré (note de vente). */
export function passEnEntree(g: PassGarde): EntreePrivee {
  const pays = paysDe(g.pays);
  return { id: g.id, p: b64u(g.pass), offre: g.offre, jours: g.jours, renouvelle: g.renouvelle, moyen: g.moyen, cree: g.cree, ...(pays ? { pays } : {}) };
}

/** Pass lu dans le coffre ; null s'il est mal formé (ignoré, jamais une erreur de session). */
export function passDeEntree(e: EntreePrivee): PassGarde | null {
  try {
    const pass = typeof e.p === "string" ? unb64u(e.p) : null;
    if (
      pass === null ||
      pass.length !== 32 ||
      (e.offre !== "plus" && e.offre !== "pro") ||
      (e.jours !== 30 && e.jours !== 365) ||
      typeof e.renouvelle !== "boolean" ||
      !(ORIGINES_PASS as readonly unknown[]).includes(e.moyen) ||
      !Number.isSafeInteger(e.cree)
    )
      return null;
    // Rangé depuis le coffre : une commande d'un autre appareil n'attend plus rien ici.
    const pays = paysDe(e.pays);
    return { id: e.id, pass, offre: e.offre, jours: e.jours, renouvelle: e.renouvelle, moyen: e.moyen as OriginePass, enAttente: false, cree: e.cree as number, ...(pays ? { pays } : {}) };
  } catch {
    return null;
  }
}

/** Même pass (mêmes octets), quel que soit l'identifiant. */
const meme = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Fusion : pass de l'appareil absents du coffre (rendus pour l'écriture, `null` si rien à écrire),
 * et pass du coffre absents de l'appareil (rangés ici). Les commandes encore en attente sur cet
 * appareil ne partent pas au coffre (un paiement non confirmé n'a rien à retrouver).
 */
export async function synchroniserPass(idb: IDBFactory, prive: CoffrePrive): Promise<((p: CoffrePrive) => CoffrePrive) | null> {
  const ici = await lirePasses(idb);
  const ducoffre = (prive.pass ?? []).map(passDeEntree).filter((x): x is PassGarde => x !== null);
  for (const g of ducoffre) if (!ici.some((x) => meme(x.pass, g.pass))) await garder(idb, { ...g, compte: true });
  await marquerRanges(idb, prive);
  const nouveaux = ici.filter((x) => !x.enAttente && !ducoffre.some((g) => meme(g.pass, x.pass)));
  if (nouveaux.length === 0) return null;
  return (p) => {
    const deja = (p.pass ?? []).map(passDeEntree).filter((x): x is PassGarde => x !== null);
    const ajout = nouveaux.filter((x) => !deja.some((g) => meme(g.pass, x.pass)) && !(p.pass ?? []).some((e) => e.id === x.id));
    return ajout.length === 0 ? p : { ...p, pass: [...(p.pass ?? []), ...ajout.map(passEnEntree)] };
  };
}

/**
 * Pass de l'appareil présents (mêmes octets) dans le coffre `prive` tel que le serveur l'a
 * confirmé : marqués `compte` (ils suivent le compte, paiement/pass.ts retirerPassDuCompte).
 * Rend le nombre de pass utilisables (ni en attente) qui ne sont pas encore dans le coffre : à
 * réessayer.
 */
export async function marquerRanges(idb: IDBFactory, prive: CoffrePrive): Promise<number> {
  const ducoffre = (prive.pass ?? []).map(passDeEntree).filter((x): x is PassGarde => x !== null);
  let manquent = 0;
  for (const g of await lirePasses(idb)) {
    const dedans = ducoffre.some((x) => meme(x.pass, g.pass));
    if (dedans && g.compte !== true) await garder(idb, { ...g, compte: true }, { garderEtat: true });
    if (!dedans && !g.enAttente) manquent++;
  }
  return manquent;
}

/** Arrêt du renouvellement : l'entrée du coffre (mêmes octets) ne se dit plus renouvelée. */
export function sansRenouvellement(pass: Uint8Array): (p: CoffrePrive) => CoffrePrive {
  return (p) => ({
    ...p,
    ...(p.pass ? { pass: p.pass.map((e) => (memeEntree(e, pass) ? { ...e, renouvelle: false } : e)) } : {}),
  });
}
function memeEntree(e: EntreePrivee, pass: Uint8Array): boolean {
  try {
    return typeof e.p === "string" && meme(unb64u(e.p), pass);
  } catch {
    return false;
  }
}
