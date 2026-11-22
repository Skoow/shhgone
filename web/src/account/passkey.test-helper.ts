// Aides des tests du compte par passkey : faux serveur en mémoire (mêmes routes et mêmes formes
// JSON que server/internal/api/handlers_passkey.go, handlers_passkeys_compte.go,
// handlers_compte.go ; JSON strict sans null ; credential refusé s'il porte une sortie PRF) et
// faux authentificateur branché sur webauthn.ts (configurerNavigateur). La sortie PRF suit
// WebAuthn : HMAC-SHA-256(secret de la passkey, SHA-256(« WebAuthn PRF » ‖ 0x00 ‖ entrée)).
// Le faux serveur ne vérifie pas les signatures (c'est le rôle des tests Go et des e2e).
import { createHash, createHmac, randomFillSync } from "node:crypto";
import { b64u, unb64u } from "../engine/pure";
import type { Navigateur } from "./webauthn";

type Bytes = Uint8Array<ArrayBuffer>;
type Obj = Record<string, unknown>;
export const rnd = (n: number): Bytes => randomFillSync(new Uint8Array(n)) as Bytes; // pas crypto.getRandomValues : les tests espionnent l'appareil
const sha256 = (...xs: Uint8Array[]) => {
  const h = createHash("sha256");
  for (const x of xs) h.update(x);
  return new Uint8Array(h.digest()) as Bytes;
};
const buf = (b: Uint8Array) => b.slice().buffer as ArrayBuffer;

// --- Faux authentificateur ---------------------------------------------------------------------

/** Forme de la sortie PRF rendue au script (1Password : non conforme). */
export type FormePrf = "arraybuffer" | "uint8array" | "dataview" | "base64url" | "nombre" | "court";

export type PasskeyFausse = { id: Bytes; userHandle: Bytes; rpId: string; secret: Bytes | null };

export class FauxAuthentificateur {
  readonly passkeys: PasskeyFausse[] = [];
  /** Entrées PRF reçues (doivent être E_prf du moteur, jamais celle des options du serveur). */
  readonly entrees: Bytes[] = [];
  /** Sorties PRF rendues au script (repères : jamais au serveur). */
  readonly sorties: Bytes[] = [];
  /** Options de création reçues (pseudo dans user.name). */
  readonly creations: PublicKeyCredentialCreationOptions[] = [];
  constructor(
    public o: {
      /** « creation » : sortie rendue dès create ; « annonce » : seulement prf.enabled ; « absent » : pas de PRF. */
      prf?: "creation" | "annonce" | "absent";
      forme?: FormePrf;
      /** Le geste suivant est annulé (NotAllowedError). */
      annuler?: boolean;
    } = {},
  ) {}

  /** Sortie PRF de p pour l'entrée e. */
  sortie(p: PasskeyFausse, e: Uint8Array): Bytes | null {
    if (!p.secret) return null;
    return new Uint8Array(createHmac("sha256", p.secret).update(sha256(new TextEncoder().encode("WebAuthn PRF\0"), e)).digest()) as Bytes;
  }

  /** Change le secret PRF d'une passkey (même passkey, autre sortie : iCloud en QR, changement de gestionnaire). */
  changerSortie(p: PasskeyFausse): void {
    p.secret = rnd(32);
  }

  #forme(s: Bytes): unknown {
    switch (this.o.forme ?? "arraybuffer") {
      case "arraybuffer":
        return buf(s);
      case "uint8array":
        return s;
      case "dataview": {
        const grand = new Uint8Array(40);
        grand.set(s, 4);
        return new DataView(grand.buffer, 4, 32);
      }
      case "base64url":
        return b64u(s);
      case "nombre":
        return 42;
      case "court":
        return buf(s.slice(0, 16));
    }
  }

  #annule(): void {
    if (this.o.annuler) {
      this.o.annuler = false;
      throw Object.assign(new Error("annulé"), { name: "NotAllowedError" });
    }
  }

  navigateur(signalees: { rpId: string; credentialId: string }[] = []): Navigateur {
    return {
      credentials: {
        create: async (opts) => {
          this.#annule();
          const pk = opts.publicKey!;
          this.creations.push(pk);
          const e = (pk.extensions as { prf?: { eval?: { first?: Uint8Array } } } | undefined)?.prf?.eval?.first;
          const exclure = (pk.excludeCredentials ?? []).map((d) => b64u(new Uint8Array(d.id as ArrayBuffer)));
          if (this.passkeys.some((p) => exclure.includes(b64u(p.id)))) throw Object.assign(new Error("déjà"), { name: "InvalidStateError" });
          const p: PasskeyFausse = { id: rnd(32), userHandle: new Uint8Array(pk.user.id as ArrayBuffer) as Bytes, rpId: pk.rp.id!, secret: this.o.prf === "absent" ? null : rnd(32) };
          this.passkeys.push(p);
          const ext: Obj = { credProps: { rk: true } };
          if (this.o.prf === "absent") ext.prf = { enabled: false };
          else if (this.o.prf === "annonce") ext.prf = { enabled: true };
          else {
            if (e) this.entrees.push(new Uint8Array(e) as Bytes);
            const s = e ? this.sortie(p, e)! : null;
            if (s) this.sorties.push(s);
            ext.prf = { enabled: true, ...(s ? { results: { first: this.#forme(s) } } : {}) };
          }
          return {
            rawId: buf(p.id),
            response: { clientDataJSON: buf(new TextEncoder().encode(JSON.stringify({ type: "webauthn.create", challenge: b64u(new Uint8Array(pk.challenge as ArrayBuffer)) }))), attestationObject: buf(rnd(80)) },
            getClientExtensionResults: () => ext,
          } as unknown as Credential;
        },
        get: async (opts) => {
          this.#annule();
          const pk = opts.publicKey!;
          const permises = (pk.allowCredentials ?? []).map((d) => b64u(new Uint8Array(d.id as ArrayBuffer)));
          const p = [...this.passkeys].reverse().find((x) => permises.length === 0 || permises.includes(b64u(x.id)));
          if (!p) throw Object.assign(new Error("aucune"), { name: "NotAllowedError" });
          const e = (pk.extensions as { prf?: { eval?: { first?: Uint8Array } } } | undefined)?.prf?.eval?.first;
          if (e) this.entrees.push(new Uint8Array(e) as Bytes);
          const s = e ? this.sortie(p, e) : null;
          if (s) this.sorties.push(s);
          return {
            rawId: buf(p.id),
            response: { clientDataJSON: buf(new TextEncoder().encode(JSON.stringify({ type: "webauthn.get", challenge: b64u(new Uint8Array(pk.challenge as ArrayBuffer)) }))), authenticatorData: buf(rnd(37)), signature: buf(rnd(70)), userHandle: buf(p.userHandle) },
            getClientExtensionResults: () => (s ? { prf: { results: { first: this.#forme(s) } } } : {}),
          } as unknown as Credential;
        },
      },
      signalInconnue: async (o) => void signalees.push(o),
    };
  }
}

// --- Faux serveur ------------------------------------------------------------------------------

type PasskeyServeur = { credId: string; userHandle: string; envs: string[]; etiquette: string; be: boolean };
export type CompteFaux = { h: Bytes; pCanon: string; vR: string; envR: string; coffres: Record<"profil" | "prive", { blob: Uint8Array; gen: number }>; passkeys: PasskeyServeur[] };
type SessionFausse = { h: string; cred: string | null; recente: boolean; parRecup: boolean; sid: string; etiquette: string; persistante: boolean };

export function fauxServeur() {
  const comptes = new Map<string, CompteFaux>(); // b64u(h) → compte
  const etapes = new Map<string, { sorte: "inscription" | "connexion" | "reauth" | "ajout"; h?: Bytes; pseudo?: string }>();
  const sessions = new Map<string, SessionFausse>();
  const pseudos = new Set<string>();
  const requetes: { method: string; path: string; headers: Record<string, string>; body: Obj; brut: string }[] = [];
  const FAUSSE_ENTREE = b64u(rnd(32)); // le site doit l'ignorer (E_prf du moteur)
  const ok = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
  const err = (status: number, error: string, extra = {}) => ok({ error, ...extra }, status);
  const ouvrirSession = (h: string, cred: string | null, parRecup: boolean, persistante: boolean, etiquette: string) => {
    const t = b64u(rnd(32));
    sessions.set(t, { h, cred, recente: true, parRecup, sid: b64u(rnd(16)), etiquette, persistante });
    return t;
  };
  const sansNull = (s: string) => !/:null[,}\]]/.test(s);
  const sansSortie = (c: unknown) => !/"results"|hmacGetSecret|hmac-secret/.test(JSON.stringify(c));
  const passkeyDe = (credId: string): [CompteFaux, PasskeyServeur] | null => {
    for (const c of comptes.values()) for (const p of c.passkeys) if (p.credId === credId) return [c, p];
    return null;
  };
  const coffres = (c: CompteFaux) => ({ blob_profil: b64u(c.coffres.profil.blob as Bytes), gen_profil: c.coffres.profil.gen, blob_prive: b64u(c.coffres.prive.blob as Bytes), gen_prive: c.coffres.prive.gen });
  const options = (allow: string[]) => ({ challenge: b64u(rnd(32)), rpId: "shh.test", timeout: 300000, userVerification: "required", ...(allow.length ? { allowCredentials: allow.map((id) => ({ type: "public-key", id })) } : {}), extensions: { prf: { eval: { first: FAUSSE_ENTREE } } } });
  const creation = (h: Bytes, exclure: string[]) => ({
    rp: { id: "shh.test", name: "Shhgone" },
    user: { id: b64u(h), name: "", displayName: "" },
    challenge: b64u(rnd(32)),
    pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -8 }, { type: "public-key", alg: -257 }],
    timeout: 300000,
    ...(exclure.length ? { excludeCredentials: exclure.map((id) => ({ type: "public-key", id })) } : {}),
    authenticatorSelection: { residentKey: "required", requireResidentKey: true, userVerification: "required" },
    attestation: "none",
    extensions: { credProps: true, prf: { eval: { first: FAUSSE_ENTREE } } },
  });
  /** Limite d'enveloppes par passkey (4 au serveur ; réglable pour les tests). */
  const reglages = { enveloppesMax: 4 };

  const fetch = (async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    const headers = { ...(init.headers as Record<string, string>) };
    const brut = (init.body as string | undefined) ?? "";
    const body = brut ? (JSON.parse(brut) as Obj) : {};
    requetes.push({ method: init.method ?? "GET", path, headers, body, brut });
    if (brut && !sansNull(brut)) return err(400, "bad_request");
    const jeton = headers["X-Shh-Session"] ?? "";
    const s = sessions.get(jeton);
    const c = s ? comptes.get(s.h) : undefined;
    const r = path.replace(/^\/api\/compte\/?/, "");
    const recente = () => s?.recente === true;
    switch (`${init.method} ${r}`) {
      case "POST inscription/debut": {
        if (typeof body.altcha !== "string") return err(400, "bad_request");
        const e = b64u(rnd(32));
        const h = rnd(16);
        etapes.set(e, { sorte: "inscription", h });
        return ok({ etape: e, options: creation(h, []) });
      }
      case "POST pseudo/verifier": {
        const e = etapes.get(body.etape as string);
        if (!s && e?.sorte !== "inscription") return err(401, "session");
        const libre = !pseudos.has(body.p_canon as string);
        if (libre && e) e.pseudo = body.p_canon as string;
        return ok({ libre });
      }
      case "POST inscription/fin": {
        const e = etapes.get(body.etape as string);
        if (!e || e.sorte !== "inscription") return err(404, "not_found");
        const cr = body.credential as Obj;
        if (!sansSortie(cr) || typeof cr?.rawId !== "string") return err(400, "bad_request");
        for (const k of ["env", "etiquette", "cred_etiquette"]) if (typeof body[k] !== "string") return err(400, "bad_request");
        if ((body.env as string) !== "" && unb64u(body.env as string).length !== 60) return err(400, "bad_request");
        if (pseudos.has(body.p_canon as string)) return err(409, "pseudo_pris");
        pseudos.add(body.p_canon as string);
        const h = e.h!;
        comptes.set(b64u(h), {
          h,
          pCanon: body.p_canon as string,
          vR: body.v_r as string,
          envR: body.env_r as string,
          coffres: { profil: { blob: unb64u(body.blob_profil as string), gen: 1 }, prive: { blob: unb64u(body.blob_prive as string), gen: 1 } },
          passkeys: [{ credId: cr.rawId as string, userHandle: b64u(h), envs: body.env ? [body.env as string] : [], etiquette: body.cred_etiquette as string, be: true }],
        });
        etapes.delete(body.etape as string);
        return ok({ session: ouvrirSession(b64u(h), cr.rawId as string, false, body.persistante === true, body.etiquette as string), h: b64u(h) }, 201);
      }
      case "POST connexion/debut": {
        const e = b64u(rnd(32));
        etapes.set(e, { sorte: "connexion" });
        return ok({ etape: e, options: options([]) });
      }
      case "POST connexion/fin": {
        const e = etapes.get(body.etape as string);
        if (!e || e.sorte !== "connexion") return err(404, "not_found");
        etapes.delete(body.etape as string);
        const cr = body.credential as Obj;
        if (!sansSortie(cr)) return err(400, "bad_request");
        const t = passkeyDe(cr.rawId as string);
        const uh = (cr.response as Obj | undefined)?.userHandle;
        if (!t || uh !== t[1].userHandle) return err(403, "identifiants");
        const [cc, p] = t;
        const ses = ouvrirSession(b64u(cc.h), p.credId, false, body.persistante === true, body.etiquette as string);
        return ok({ session: ses, h: b64u(cc.h), cred_id: p.credId, enveloppes: p.envs, ...coffres(cc) });
      }
      case "POST recup": {
        const vR = b64u(sha256(unb64u(body.a_r as string)));
        const cc = [...comptes.values()].find((x) => x.vR === vR);
        if (!cc) return err(403, "identifiants");
        const ses = ouvrirSession(b64u(cc.h), null, true, body.persistante === true, body.etiquette as string);
        return ok({ session: ses, h: b64u(cc.h), env_r: cc.envR, ...coffres(cc) });
      }
      case "POST reauth/debut": {
        if (!c) return err(401, "session");
        const e = b64u(rnd(32));
        etapes.set(e, { sorte: "reauth", h: c.h });
        return ok({ etape: e, options: options(c.passkeys.map((p) => p.credId)) });
      }
      case "POST reauth/fin": {
        if (!c || !s) return err(401, "session");
        const e = etapes.get(body.etape as string);
        if (!e || e.sorte !== "reauth") return err(404, "not_found");
        etapes.delete(body.etape as string);
        const cr = body.credential as Obj;
        if (!sansSortie(cr)) return err(400, "bad_request");
        const p = c.passkeys.find((x) => x.credId === cr.rawId);
        if (!p) return err(403, "identifiants");
        s.recente = true;
        s.cred = p.credId;
        return ok({ enveloppes: p.envs });
      }
      case "GET passkeys":
        if (!c) return err(401, "session");
        return ok({ passkeys: c.passkeys.map((p) => ({ cred_id: p.credId, ajoutee: "2026-11", etiquette: p.etiquette, be: p.be, prf: p.envs.length > 0 })) });
      case "POST passkeys/debut": {
        if (!c) return err(401, "session");
        if (!recente()) return err(403, "recent");
        if (c.passkeys.length >= 10) return err(409, "passkeys_max");
        const e = b64u(rnd(32));
        etapes.set(e, { sorte: "ajout", h: c.h });
        return ok({ etape: e, options: creation(c.h, c.passkeys.map((p) => p.credId)) });
      }
      case "POST passkeys/fin": {
        if (!c) return err(401, "session");
        if (!recente()) return err(403, "recent");
        const e = etapes.get(body.etape as string);
        if (!e || e.sorte !== "ajout") return err(404, "not_found");
        etapes.delete(body.etape as string);
        const cr = body.credential as Obj;
        if (!sansSortie(cr)) return err(400, "bad_request");
        c.passkeys.push({ credId: cr.rawId as string, userHandle: b64u(c.h), envs: body.env ? [body.env as string] : [], etiquette: body.etiquette as string, be: true });
        return ok({});
      }
      case "POST passkeys/enveloppe": {
        if (!c || !s) return err(401, "session");
        if (!recente()) return err(403, "recent");
        if (typeof body.env !== "string" || unb64u(body.env).length !== 60) return err(400, "bad_request");
        const p = c.passkeys.find((x) => x.credId === s.cred);
        if (!p) return err(403, "sans_passkey");
        if (p.envs.includes(body.env)) return ok({});
        if (p.envs.length >= reglages.enveloppesMax) return err(409, "enveloppes_max");
        p.envs.push(body.env);
        return ok({});
      }
      case "POST passkeys/nommer": {
        if (!c) return err(401, "session");
        const p = c.passkeys.find((x) => x.credId === body.cred_id);
        if (!p) return err(404, "not_found");
        p.etiquette = body.etiquette as string;
        return ok({});
      }
      case "POST passkeys/retirer": {
        if (!c) return err(401, "session");
        if (!recente()) return err(403, "recent");
        if (c.passkeys.length <= 1) return err(409, "derniere");
        c.passkeys = c.passkeys.filter((p) => p.credId !== body.cred_id);
        for (const x of sessions.values()) if (x.cred === body.cred_id) x.cred = null;
        return ok({});
      }
      case "POST recup/renouveler":
        if (!c) return err(401, "session");
        if (!recente()) return err(403, "recent");
        c.vR = body.v_r as string;
        c.envR = body.env_r as string;
        return ok({});
      case "POST pseudo/libre":
        return ok({ libre: !pseudos.has(body.p_canon as string) });
      case "POST pseudo": {
        if (!c) return err(401, "session");
        if (pseudos.has(body.p_canon as string)) return err(409, "pseudo_pris");
        pseudos.delete(c.pCanon);
        pseudos.add((c.pCanon = body.p_canon as string));
        return ok({});
      }
      case "GET coffre/profil":
      case "GET coffre/prive": {
        if (!c) return err(401, "session");
        const v = c.coffres[r.slice(7) as "profil" | "prive"];
        return ok({ blob: b64u(v.blob as Bytes), gen: v.gen });
      }
      case "PUT coffre/profil":
      case "PUT coffre/prive": {
        if (!c) return err(401, "session");
        const v = c.coffres[r.slice(7) as "profil" | "prive"];
        if (body.if_gen !== v.gen) return err(409, "conflict", { gen: v.gen });
        v.blob = unb64u(body.blob as string);
        v.gen++;
        return ok({ gen: v.gen });
      }
      case "GET ":
        if (!c) return err(401, "session");
        return ok({ h: b64u(c.h), cree_le: "2026-11-14", palier: "neuf", confirme_le: "2026-11-21", limites: { salons: 1, places: 4, heures: 24 }, salons_actifs: 0, banni: false, banni_id: null, banni_jusqu: null, banni_motif: null });
      case "POST sessions/etiquette":
        if (!s) return err(401, "session");
        s.etiquette = body.etiquette as string;
        return ok({});
      case "GET sessions":
        if (!s) return err(401, "session");
        return ok({ sessions: [...sessions].filter(([, x]) => x.h === s.h).map(([t, x]) => ({ sid: x.sid, ajoutee: "2026-11", etiquette: x.etiquette, courante: t === jeton, persistante: x.persistante, par_recup: x.parRecup })) });
      case "POST sessions/fermer":
        if (!s) return err(401, "session");
        for (const [t, x] of sessions) if (x.h === s.h && (body.autres === true ? t !== jeton : x.sid === body.sid)) sessions.delete(t);
        return ok({});
      case "GET export":
        if (!c) return err(401, "session");
        return ok({ cree_le: "2026-11-14", anciennete_depuis: "2026-11-14", vu_mois: "2026-11", banni_jusqu: null, banni_motif: null, salons_actifs: 1, sessions: [{ ajoutee: "2026-11", persistante: false, par_recup: false }], passkeys: c.passkeys.map((p) => ({ ajoutee: "2026-11", be: p.be, prf: p.envs.length > 0, cle_pub: b64u(rnd(77)) })) });
      case "POST supprimer": {
        if (!c) return err(401, "session");
        if (!recente()) return err(403, "recent");
        pseudos.delete(c.pCanon);
        comptes.delete(b64u(c.h));
        for (const [t, x] of sessions) if (x.h === b64u(c.h)) sessions.delete(t);
        return ok({ salons_fermes: 2 });
      }
      case "POST deconnexion":
        if (!s) return err(401, "session");
        sessions.delete(jeton);
        return ok({});
    }
    return err(404, "not_found");
  }) as unknown as typeof globalThis.fetch;
  /** Les sessions ne sont plus récentes (5 min passées). */
  const vieillir = () => {
    for (const x of sessions.values()) x.recente = false;
  };
  return { comptes, sessions, pseudos, requetes, fetch, vieillir, reglages, FAUSSE_ENTREE };
}
