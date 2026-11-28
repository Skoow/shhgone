// Passkeys dans le navigateur (conception 2026-11-22-compte-passkey-design.md §3, §5, §9). Seul module qui parle au navigateur pour les passkeys, par navigateur.ts (seul fichier
// qui touche navigator.credentials ; dans la démo, navigateur.demo.ts : passkey simulée).
// - Options : le JSON de WebAuthn niveau 3 rendu par le serveur, converti ici (base64url →
//   octets : challenge, user.id, identifiants des passkeys, entrées PRF). Conversion locale
//   seulement, même quand parseCreationOptionsFromJSON existe : le résultat est le même partout,
//   y compris pour les entrées PRF que certains navigateurs ne convertissent pas.
// - L'entrée PRF n'est jamais prise au serveur : prf.eval.first = E_prf du moteur (passée par
//   l'appelant), quelle que soit la valeur des options.
// - Réponses : JSON construit ici avec les seuls champs que le serveur lit. clientExtensionResults
//   n'emporte que credProps.rk et prf.enabled (liste blanche) : la sortie PRF (prf.results) et
//   hmacGetSecret ne partent JAMAIS (le serveur refuse d'ailleurs une réponse qui les porte).
//   Ni transports, ni authenticatorAttachment : le serveur n'en a pas besoin.
// - Sortie PRF lue de façon tolérante (gestionnaires non conformes, 1Password) : ArrayBuffer (même
//   d'un autre contexte), toute vue (TypedArray, DataView) ou texte base64url ; exactement 32
//   octets, sinon « pas de PRF » (repli par la clé de récupération, §5.5). prf.enabled : vrai
//   seulement s'il vaut exactement true.
// - Annulation (NotAllowedError) : Error("annule"), que les écrans n'affichent pas.
// - Parcours (décision du 25 novembre, conception §19) : « defaut » (téléphone ou tablette :
//   passkey de l'appareil, options inchangées) ; « hybride » (ordinateur : passkey gardée sur le
//   téléphone, QR du navigateur ; indice WebAuthn niveau 3 `hints: ["hybrid"]` et, à la création,
//   `authenticatorAttachment: "cross-platform"` pour les navigateurs qui ignorent les indices, comme
//   le recommande la norme) ; « local » (« cet ordinateur » : `hints: ["client-device"]`, sans
//   imposer d'attachement, pour qu'un ordinateur sans passkey de plateforme garde ses autres choix).
//   Les indices ne sont que des indices : le navigateur peut les ignorer, la cérémonie reste valable.
//   Rien de cela ne part au serveur (il ne vérifie pas l'attachement).
// - Aucun appel réseau ici : les options sont chargées AVANT le clic (Safari annule une cérémonie
//   qui ne part pas du geste de l'utilisateur, conception §3).
import { b64u, unb64u } from "../engine/pure";
import { navigateurParDefaut, type Navigateur } from "./navigateur";

export type { Navigateur };

type Bytes = Uint8Array<ArrayBuffer>;
type Obj = Record<string, unknown>;

let nav: () => Navigateur = navigateurParDefaut;

/** Tests : remplace le navigateur. */
export function configurerNavigateur(n: (() => Navigateur) | null): void {
  nav = n ?? navigateurParDefaut;
}

/** Le navigateur sait faire des passkeys (sinon : message de la conception §9). */
export function passkeysDisponibles(): boolean {
  return nav().credentials !== null;
}

// --- Octets reçus du navigateur (ou d'un gestionnaire) ------------------------------------------

const etiquette = (v: unknown) => Object.prototype.toString.call(v);

/**
 * Octets d'un ArrayBuffer (même d'un autre contexte), d'une vue (TypedArray, DataView) ou d'un
 * texte base64url (bourrage toléré) ; copie neuve. Rien d'autre : null.
 */
export function octetsDe(v: unknown): Bytes | null {
  try {
    if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength)) as Bytes;
    if (v instanceof ArrayBuffer || etiquette(v) === "[object ArrayBuffer]") return new Uint8Array((v as ArrayBuffer).slice(0)) as Bytes;
    if (typeof v === "string") return unb64u(v.replace(/=+$/, ""));
  } catch {
    return null;
  }
  return null;
}

/** Sortie PRF : exactement 32 octets, sinon null (PRF absent : repli de la conception §5.5). */
export function sortiePrf(resultats: unknown): Bytes | null {
  const prf = (resultats as { prf?: { results?: { first?: unknown } } } | null)?.prf;
  const b = octetsDe(prf?.results?.first);
  if (b === null || b.length !== 32) {
    b?.fill(0);
    return null;
  }
  return b;
}

/** prf.enabled : vrai seulement s'il vaut exactement true. */
export function prfAnnonce(resultats: unknown): boolean {
  return (resultats as { prf?: { enabled?: unknown } } | null)?.prf?.enabled === true;
}

/**
 * clientExtensionResults à envoyer au serveur : liste blanche, credProps.rk et prf.enabled
 * seulement (booléens). Jamais prf.results ni hmacGetSecret.
 */
export function extensionsPourServeur(resultats: unknown): Obj {
  const out: Obj = {};
  const r = (resultats ?? {}) as { credProps?: { rk?: unknown }; prf?: { enabled?: unknown } };
  if (typeof r.credProps?.rk === "boolean") out.credProps = { rk: r.credProps.rk };
  if (typeof r.prf?.enabled === "boolean") out.prf = { enabled: r.prf.enabled };
  return out;
}

/** Retire toute sortie PRF d'un objet credential JSON (filet de sécurité avant l'envoi). */
export function sansSortiePrf(credential: Obj): Obj {
  return { ...credential, clientExtensionResults: extensionsPourServeur(credential.clientExtensionResults) };
}

// --- Options ----------------------------------------------------------------------------------

/** Où la passkey est demandée (voir l'en-tête) ; « defaut » : options inchangées. */
export type Parcours = "defaut" | "hybride" | "local";

const INDICES: Record<Parcours, readonly string[] | null> = { defaut: null, hybride: ["hybrid"], local: ["client-device"] };
const indices = (p: Parcours): { hints?: string[] } => {
  const h = INDICES[p];
  return h ? { hints: [...h] } : {};
};

const bytes = (v: unknown): Bytes => {
  if (typeof v !== "string") throw new Error("options_invalides");
  try {
    return unb64u(v);
  } catch {
    throw new Error("options_invalides");
  }
};
const descripteurs = (l: unknown) => (Array.isArray(l) ? l.map((d: Obj) => ({ type: "public-key" as const, id: bytes(d.id) })) : undefined);

/** Options de création (JSON du serveur) pour navigator.credentials.create ; nom affiché = pseudo. */
export function optionsCreation(o: Obj, pseudo: string, ePrf: Uint8Array, parcours: Parcours = "defaut"): PublicKeyCredentialCreationOptions {
  const rp = o.rp as Obj;
  const user = o.user as Obj;
  if (typeof rp !== "object" || rp === null || typeof user !== "object" || user === null || !Array.isArray(o.pubKeyCredParams)) throw new Error("options_invalides");
  const exclure = descripteurs(o.excludeCredentials);
  return {
    rp: { id: rp.id as string, name: rp.name as string },
    user: { id: bytes(user.id), name: pseudo, displayName: pseudo },
    challenge: bytes(o.challenge),
    pubKeyCredParams: (o.pubKeyCredParams as Obj[]).map((p) => ({ type: "public-key", alg: p.alg as number })),
    ...(typeof o.timeout === "number" ? { timeout: o.timeout } : {}),
    ...(exclure ? { excludeCredentials: exclure } : {}),
    authenticatorSelection: { residentKey: "required", requireResidentKey: true, userVerification: "required", ...(parcours === "hybride" ? { authenticatorAttachment: "cross-platform" as const } : {}) },
    ...indices(parcours),
    attestation: "none",
    extensions: { credProps: true, prf: { eval: { first: ePrf as Bytes } } } as AuthenticationExtensionsClientInputs,
  };
}

/** Options d'assertion (JSON du serveur) pour navigator.credentials.get. */
export function optionsAssertion(o: Obj, ePrf: Uint8Array, parcours: Parcours = "defaut"): PublicKeyCredentialRequestOptions {
  const permises = descripteurs(o.allowCredentials);
  return {
    challenge: bytes(o.challenge),
    ...(typeof o.rpId === "string" ? { rpId: o.rpId } : {}),
    ...(typeof o.timeout === "number" ? { timeout: o.timeout } : {}),
    ...(permises && permises.length > 0 ? { allowCredentials: permises } : {}),
    userVerification: "required",
    ...indices(parcours),
    extensions: { prf: { eval: { first: ePrf as Bytes } } } as AuthenticationExtensionsClientInputs,
  };
}

// --- Cérémonies --------------------------------------------------------------------------------

/** Erreur du navigateur → code : annule, deja_enregistree, webauthn_absent, webauthn_echec. */
function code(e: unknown): Error {
  const n = (e as { name?: unknown } | null)?.name;
  if (n === "NotAllowedError" || n === "AbortError") return new Error("annule");
  if (n === "InvalidStateError") return new Error("deja_enregistree");
  return new Error("webauthn_echec");
}

type Reponse = { rawId: unknown; response: Obj & { getTransports?: unknown }; getClientExtensionResults?: () => unknown; authenticatorAttachment?: unknown };

function lireReponse(c: Credential | null): { r: Reponse; id: Bytes; ext: unknown } {
  const r = c as unknown as Reponse | null;
  const id = octetsDe(r?.rawId);
  if (!r || !id || id.length < 1 || id.length > 1023 || typeof r.response !== "object" || r.response === null) throw new Error("webauthn_echec");
  let ext: unknown = {};
  try {
    ext = typeof r.getClientExtensionResults === "function" ? r.getClientExtensionResults() : {};
  } catch {
    ext = {};
  }
  return { r, id, ext };
}

function champ(o: Obj, k: string): string {
  const b = octetsDe(o[k]);
  if (!b) throw new Error("webauthn_echec");
  return b64u(b);
}

export type Creation = {
  /** RegistrationResponseJSON sans sortie PRF : prêt pour le serveur. */
  credential: Obj;
  credId: Bytes;
  /** Sortie PRF (32 octets) rendue à la création, ou null. */
  prf: Bytes | null;
  /** Le gestionnaire annonce PRF sans l'avoir rendu : un deuxième geste le donnera (§3.1, 2 bis). */
  prfAnnonce: boolean;
  rpId: string;
  /** Où le navigateur dit avoir créé la passkey (PublicKeyCredential.authenticatorAttachment) : lu ici, jamais envoyé ; null si inconnu. */
  attachement: "platform" | "cross-platform" | null;
};

/** navigator.credentials.create : appelé directement depuis le geste (aucune requête avant). */
export async function creer(options: PublicKeyCredentialCreationOptions): Promise<Creation> {
  const c = nav().credentials;
  if (!c) throw new Error("webauthn_absent");
  let cred: Credential | null;
  try {
    cred = await c.create({ publicKey: options });
  } catch (e) {
    throw code(e);
  }
  const { r, id, ext } = lireReponse(cred);
  const credential: Obj = {
    id: b64u(id),
    rawId: b64u(id),
    type: "public-key",
    response: { clientDataJSON: champ(r.response, "clientDataJSON"), attestationObject: champ(r.response, "attestationObject") },
    clientExtensionResults: extensionsPourServeur(ext),
  };
  const att = r.authenticatorAttachment;
  return { credential, credId: id, prf: sortiePrf(ext), prfAnnonce: prfAnnonce(ext), rpId: options.rp.id ?? "", attachement: att === "platform" || att === "cross-platform" ? att : null };
}

export type Assertion = {
  /** AuthenticationResponseJSON sans sortie PRF : prêt pour le serveur. */
  credential: Obj;
  credId: Bytes;
  prf: Bytes | null;
  /** Où était la passkey, si le navigateur le dit (jamais envoyé ; §19 : chemin retenu). */
  attachement: "platform" | "cross-platform" | null;
};

/** navigator.credentials.get : appelé directement depuis le geste (aucune requête avant). */
export async function obtenir(options: PublicKeyCredentialRequestOptions): Promise<Assertion> {
  const c = nav().credentials;
  if (!c) throw new Error("webauthn_absent");
  let cred: Credential | null;
  try {
    cred = await c.get({ publicKey: options });
  } catch (e) {
    throw code(e);
  }
  const { r, id, ext } = lireReponse(cred);
  const response: Obj = { clientDataJSON: champ(r.response, "clientDataJSON"), authenticatorData: champ(r.response, "authenticatorData"), signature: champ(r.response, "signature") };
  const uh = r.response.userHandle;
  if (uh !== null && uh !== undefined) response.userHandle = champ(r.response, "userHandle");
  const att = r.authenticatorAttachment;
  return { credential: { id: b64u(id), rawId: b64u(id), type: "public-key", response, clientExtensionResults: extensionsPourServeur(ext) }, credId: id, prf: sortiePrf(ext), attachement: att === "platform" || att === "cross-platform" ? att : null };
}

/**
 * Deuxième geste après une création sans sortie PRF (§3.1, 2 bis ; ajout d'une passkey) : une
 * assertion locale limitée à cette passkey, défi tiré ici (rien n'est envoyé au serveur).
 */
export async function prfApresCreation(rpId: string, credId: Uint8Array, ePrf: Uint8Array, parcours: Parcours = "defaut"): Promise<Bytes | null> {
  const a = await obtenir({
    challenge: crypto.getRandomValues(new Uint8Array(32)),
    rpId,
    allowCredentials: [{ type: "public-key", id: credId as Bytes }],
    userVerification: "required",
    ...indices(parcours),
    extensions: { prf: { eval: { first: ePrf as Bytes } } } as AuthenticationExtensionsClientInputs,
  });
  return a.prf;
}

/** Le gestionnaire oublie une passkey (signalUnknownCredential), là où l'API existe ; sinon faux. */
export async function signalerInconnue(rpId: string, credId: Uint8Array): Promise<boolean> {
  const s = nav().signalInconnue;
  if (!s) return false;
  try {
    await s({ rpId, credentialId: b64u(credId as Bytes) });
    return true;
  } catch {
    return false;
  }
}
