// Création d'un salon sur l'appareil du créateur (spec §39.1, §39.2.1 ; spec salon v3 §3.3,
// §15.2) : K_lien et S_gestion tirés ici (32 octets aléatoires, WebCrypto), mot de passe de la
// forme générée (D41-15 : seul accepté à la création, la preuve de membre de D41-26 en dépend),
// K_mdp par Argon2id (moteur des partages, paramètres KDF_CREATE), clés du salon par le module
// du salon. Le serveur reçoit K_accès_s et J_gestion (en-têtes), V_preuve_s, le sel et les
// paramètres d'Argon2id (corps) ; jamais K_lien, S_gestion, le mot de passe ni K_mdp.
import { KDF_CREATE, b64u } from "../engine/pure";
import { passwordKeyForCreate } from "../engine/index";
import type { ClesSalon, SalonEngine } from "./engine";
import type { CorpsCreation } from "./api";

export type Duree = 1 | 6 | 12 | 24;
export const DUREES: readonly Duree[] = [1, 6, 12, 24];
/** Places : 2 à 10, créateur compris (`max_members`, §39.1) ; « Ouvert » = 10. */
export const PLACES_MIN = 2;
export const PLACES_MAX = 10;

export type Preparation = {
  kLien: Uint8Array<ArrayBuffer>;
  sGestion: Uint8Array<ArrayBuffer>;
  cles: ClesSalon;
  /** K_maître_s (preuve de membre du créateur, D41-26) : SECRET, effacé par l'appelant. */
  kMaitre: Uint8Array<ArrayBuffer>;
  /** En-têtes (base64url) : K_accès_s et J_gestion ; aucun secret de plus. */
  entetes: { acces: string; gestion: string };
  corps: Omit<CorpsCreation, "altcha" | "hp" | "shown_at">;
};

const alea = (n: number) => crypto.getRandomValues(new Uint8Array(n));

/**
 * Prépare la création : clés tirées, Argon2id fait. L'appelant garde `kLien`, `sGestion` et
 * `cles` (entrée dans le salon), puis les efface ; s'il abandonne : `oublier(p)`.
 */
export async function preparer(eng: SalonEngine, motDePasse: string, o: { ttlHours: Duree; maxMembers: number; membersCanDestroy: boolean }): Promise<Preparation> {
  if (!DUREES.includes(o.ttlHours) || !Number.isInteger(o.maxMembers) || o.maxMembers < PLACES_MIN || o.maxMembers > PLACES_MAX) throw new Error("argument_invalide");
  const kLien = alea(32);
  const sGestion = alea(32);
  const salt = alea(16);
  let kMdp: Uint8Array | undefined;
  try {
    kMdp = await passwordKeyForCreate(motDePasse, salt);
    const cles = eng.clesSalon(kLien, kMdp);
    const kMaitre = eng.cleMaitre(kLien, kMdp) as Uint8Array<ArrayBuffer>;
    const acces = eng.cleAcces(kLien);
    const j = eng.jetonGestion(sGestion);
    const entetes = { acces: b64u(acces.k as Uint8Array<ArrayBuffer>), gestion: b64u(j as Uint8Array<ArrayBuffer>) };
    acces.k.fill(0);
    acces.v.fill(0);
    j.fill(0);
    return {
      kLien,
      sGestion,
      cles,
      kMaitre,
      entetes,
      corps: {
        ttl_hours: o.ttlHours,
        max_members: o.maxMembers,
        members_can_destroy: o.membersCanDestroy,
        salt: b64u(salt),
        kdf_ops: KDF_CREATE.ops,
        kdf_mem: KDF_CREATE.mem,
        proof_v: b64u(cles.vPreuve() as Uint8Array<ArrayBuffer>),
      },
    };
  } catch (e) {
    kLien.fill(0);
    sGestion.fill(0);
    throw e;
  } finally {
    kMdp?.fill(0);
  }
}

/** Abandon : secrets effacés. */
export function oublier(p: Preparation): void {
  p.kLien.fill(0);
  p.sGestion.fill(0);
  p.kMaitre.fill(0);
  p.cles.free();
}
