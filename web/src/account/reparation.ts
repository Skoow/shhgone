// Réparation des enveloppes PRF (conception du compte par
// passkey §5.3, §17, R6, R10). Une même passkey peut rendre une autre sortie PRF selon le chemin
// (QR hybride), la version d'iOS ou après un changement de gestionnaire : aucune de ses
// enveloppes ne s'ouvre alors. Quand K_compte a été obtenue autrement (clé locale de l'appareil,
// clé de récupération) et qu'une sortie PRF P existe pour cette passkey, l'appareil pose une
// enveloppe de plus pour P (passkeys/enveloppe : seulement pour la passkey liée à la session).
// Règles :
// - jamais d'enveloppe qui ne s'ouvre pas avec P : elle est refaite et rouverte ici avant l'envoi ;
// - une enveloppe de la passkey s'ouvre déjà avec P : rien à faire ;
// - 403 recent ou sans_passkey : une réauthentification (geste de passkey), puis on recommence
//   avec la passkey qui a signé (sa sortie PRF et ses enveloppes : la session lui est liée) ;
// - 409 enveloppes_max : ignoré sans bruit (4 enveloppes déjà, la clé locale servira) ;
// - au mieux : aucune erreur ne remonte, la connexion n'en dépend pas.
import { CompteError } from "./api";
import { enveloppePrf, ouvrirEnveloppesPrf } from "./keys";

type Bytes = Uint8Array<ArrayBuffer>;

/** Passkey de la session, sa sortie PRF (ou null) et ses enveloppes connues. */
export type Lien = { credId: Bytes; prf: Bytes | null; enveloppes: readonly Uint8Array[] };

export type Resultat = "deja" | "posee" | "sans_prf" | "plein" | "echec";

const egaux = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

export async function reparer(o: {
  h: Uint8Array;
  kCompte: Uint8Array;
  lien: Lien;
  /** POST passkeys/enveloppe avec la session liée à la passkey. */
  poser: (env: Bytes) => Promise<void>;
  /** Réauthentification (geste) ; rend la passkey qui a signé, ou null (refus, annulation). */
  reauth?: () => Promise<Lien | null>;
}): Promise<Resultat> {
  let lien = o.lien;
  for (let essai = 0; essai < 2; essai++) {
    if (!lien.prf) return "sans_prf";
    try {
      const deja = await ouvrirEnveloppesPrf(lien.prf, o.h, lien.credId, lien.enveloppes);
      if (deja) {
        const meme = egaux(deja, o.kCompte);
        deja.fill(0);
        // Une enveloppe de cette passkey ouvre une AUTRE clé : base altérée, on ne pose rien.
        return meme ? "deja" : "echec";
      }
      const env = await enveloppePrf(lien.prf, o.h, lien.credId, o.kCompte);
      const verif = await ouvrirEnveloppesPrf(lien.prf, o.h, lien.credId, [env]);
      const bonne = verif !== null && egaux(verif, o.kCompte);
      verif?.fill(0);
      if (!bonne) return "echec";
      await o.poser(env);
      return "posee";
    } catch (e) {
      if (e instanceof CompteError && e.status === 409 && e.code === "enveloppes_max") return "plein";
      if (e instanceof CompteError && e.status === 403 && (e.code === "recent" || e.code === "sans_passkey") && essai === 0 && o.reauth) {
        const l = await o.reauth().catch(() => null);
        if (!l) return "echec";
        lien = l;
        continue;
      }
      return "echec";
    }
  }
  return "echec";
}
