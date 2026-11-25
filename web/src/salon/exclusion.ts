// Exclusion et nouvelle invitation (spec §39.13 ; spec salon v3 §3.6.1).
// Chez le créateur seulement :
//   (a) nouvelle invitation tirée ici : K_lien' (32 octets aléatoires), mot de passe généré,
//       sel, K_mdp' (Argon2id), clés du salon, K_maître_s' ; rien de l'ancienne n'y entre ;
//   (b) la rotation est préparée dans le client (clé gardée, pas encore envoyée), puis
//       `POST exclure` (siège et `nonce_arrivée` de l'exclu, ou aucun : nouveau lien seul) :
//       le serveur révoque l'exclu, remplace l'accès et émet le 0x09 ;
//   (c) à ce 0x09, chaque membre marque l'arrivée exclue et le plus petit siège en ligne la
//       retire du groupe MLS ; le créateur envoie ensuite, dans le groupe, `{ k: "rotation", n,
//       cle: K_maître_s' }` (jamais le lien, K_lien', K_mdp' ni le mot de passe) ; le moteur
//       ne l'accepte que de lui, à l'époque courante, sans feuille exclue ;
//   (d) chacun refonde le groupe sous les nouvelles clés (client.ts, #adopter) ; l'exclu n'a
//       aucune feuille ni aucun secret du nouveau groupe, ni la nouvelle enveloppe.
// L'ancien lien et l'ancien mot de passe ne font plus entrer personne ; le créateur montre la
// nouvelle invitation, à donner par deux moyens différents aux personnes à faire entrer.
import { KDF_CREATE } from "../engine/pure";
import { generatePassword, passwordKeyForCreate } from "../engine/index";
import * as api from "./api";
import type { ClientSalon } from "./client";
import type { SalonEngine } from "./engine";

export type NouvelleInvitation = { kLien: Uint8Array<ArrayBuffer>; mdp: string };

/**
 * Exclut `siege` (ou change seulement l'invitation, sans `siege`) : rend la nouvelle invitation
 * (K_lien' à mettre dans le lien affiché, puis à effacer par l'appelant). Erreurs : SalonError
 * (403 forbidden, 409 stale…), Error("reseau"). En cas d'échec, rien n'a changé pour personne.
 */
export async function exclure(n: api.Net, eng: SalonEngine, c: ClientSalon, siege?: number): Promise<NouvelleInvitation> {
  const nonce = siege === undefined ? undefined : c.nonceDe(siege);
  if (siege !== undefined && (!nonce || siege === 0)) throw new Error("argument_invalide");
  const kLien = crypto.getRandomValues(new Uint8Array(32));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const mdp = generatePassword();
  const kMdp = await passwordKeyForCreate(mdp, salt);
  const j = c.jetonGestion();
  if (!j) throw new Error("forbidden");
  try {
    // Un numéro déjà servi (créateur revenu sans avoir vu tous les 0x09) : 409, numéro suivant.
    for (let r = c.dernierR + 1, essais = 0; ; r++, essais++) {
      const cles = eng.clesSalon(kLien, kMdp);
      const kMaitre = eng.cleMaitre(kLien, kMdp);
      const acces = eng.cleAcces(kLien);
      const vPreuve = cles.vPreuve();
      c.preparerRotation(r, cles, kMaitre, kLien);
      kMaitre.fill(0);
      try {
        await api.exclure(n, j, { siege, nonce, r, kAccesNouvelle: acces.k, vPreuve, salt, kdfOps: KDF_CREATE.ops, kdfMem: KDF_CREATE.mem });
        return { kLien, mdp };
      } catch (e) {
        c.annulerRotation();
        if (!(e instanceof api.SalonError && e.code === "stale" && essais < 8)) throw e;
      } finally {
        acces.k.fill(0);
        acces.v.fill(0);
      }
    }
  } catch (e) {
    kLien.fill(0);
    throw e;
  } finally {
    kMdp.fill(0);
    j.fill(0);
  }
}

