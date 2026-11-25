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
  for (const g of ducoffre) if (!ici.some((x) => meme(x.pass, g.pass))) await garder(idb, g);
  const nouveaux = ici.filter((x) => !x.enAttente && !ducoffre.some((g) => meme(g.pass, x.pass)));
  if (nouveaux.length === 0) return null;
  return (p) => {
    const deja = (p.pass ?? []).map(passDeEntree).filter((x): x is PassGarde => x !== null);
    const ajout = nouveaux.filter((x) => !deja.some((g) => meme(g.pass, x.pass)) && !(p.pass ?? []).some((e) => e.id === x.id));
    return ajout.length === 0 ? p : { ...p, pass: [...(p.pass ?? []), ...ajout.map(passEnEntree)] };
  };
}
