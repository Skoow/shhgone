// Faux serveur du COMPTE de la démo GitHub Pages (« démo essayable » ;
// conception du compte par passkey §11, Q8) : mêmes routes et mêmes réponses que
// server/internal/api/handlers_passkey.go, handlers_passkeys_compte.go et handlers_compte.go, en
// mémoire, pour cet onglet seulement. Il voit ce que verrait le vrai serveur : identifiants des
// passkeys simulées, enveloppes de 60 octets, v_r et Env_r, coffres chiffrés, p_canon ; jamais
// la sortie PRF, la clé de récupération ni K_compte (un credential qui porte une sortie PRF est
// refusé, comme en production). Rien ne quitte l'onglet (gardé par demo/persist.ts).
// Écarts assumés avec la production (démo) : aucune signature vérifiée (passkey simulée,
// demo/passkeys.ts), ni limites horaires, ni preuve anti-robot.

export const MARK = "__SHH_DEMO__";

const RECENT_MS = 5 * 60_000;
const ETAPE_MS = 5 * 60_000;
const PASSKEYS_MAX = 10;
const ENVELOPPES_MAX = 4;

type Bytes = Uint8Array<ArrayBuffer>;

type PasskeyDemo = { credId: string; envs: string[]; etiquette: string; ajoutee: string };
export type CompteDemo = {
  h: string;
  pCanon: string;
  vR: string;
  envR: string;
  profil: { blob: string; gen: number };
  prive: { blob: string; gen: number };
  passkeys: PasskeyDemo[];
  creeLe: string;
};
type Etape = { sorte: "inscription" | "connexion" | "reauth" | "ajout"; h: string; fin: number; pseudo?: string };
type Session = { h: string; sid: string; ajoutee: string; persistante: boolean; etiquette: string; auth: number; cred: string | null; parRecup: boolean };

export type InstantaneCompte = {
  v: 2;
  comptes: [string, CompteDemo][];
  sessions: [string, Session][];
  pseudos: string[];
};

export type FauxCompteOpts = {
  now?: () => number;
  /** État retrouvé (rechargement de l'onglet). */
  restore?: InstantaneCompte | null;
  /** Appelé après chaque changement (sauvegarde de l'onglet). */
  onChange?: (s: InstantaneCompte) => void;
};

export type FauxCompte = { handle(req: Request): Promise<Response> };

const rnd = (n: number): Bytes => crypto.getRandomValues(new Uint8Array(n));
const b64u = (b: Uint8Array) => {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const unb64u = (s: string): Bytes => {
  const t = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(t + "=".repeat((4 - (t.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};
const B64U = /^[A-Za-z0-9_-]*$/;
const jour = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const mois = (ms: number) => new Date(ms).toISOString().slice(0, 7);
const sha256 = async (b: Uint8Array) => new Uint8Array(await crypto.subtle.digest("SHA-256", b as Bytes));
/** Entrée PRF que le vrai serveur met dans les options (le site la remplace par E_prf du moteur). */
const ENTREE_PRF = "pbRDyM7_l4HwnZtFQGLyBJDAEKuEIozUbIZB4MoH_WU";

class HttpErr extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(code);
  }
}
const requete = () => new HttpErr(400, "bad_request");
const hote = () => globalThis.location?.hostname ?? "localhost";

export function createFauxCompte(opts: FauxCompteOpts = {}): FauxCompte {
  const now = opts.now ?? Date.now;
  const comptes = new Map<string, CompteDemo>(opts.restore?.comptes ?? []); // h → compte
  const sessions = new Map<string, Session>(opts.restore?.sessions ?? []); // jeton → session
  const pseudos = new Set<string>(opts.restore?.pseudos ?? []);
  const etapes = new Map<string, Etape>(); // en mémoire seulement (perdues au rechargement, comme au redémarrage du serveur)

  const sauver = () => opts.onChange?.({ v: 2, comptes: [...comptes], sessions: [...sessions], pseudos: [...pseudos] });

  const chaine = (v: unknown) => {
    if (typeof v !== "string") throw requete();
    return v;
  };
  function octetsB64(v: unknown, n?: number): string {
    if (typeof v !== "string" || !B64U.test(v)) throw requete();
    if (n !== undefined && unb64u(v).length !== n) throw requete();
    return v;
  }
  const booleen = (v: unknown) => {
    if (typeof v !== "boolean") throw requete();
    return v;
  };
  const optionnel = (v: unknown, n: number) => {
    const s = chaine(v);
    if (s !== "") octetsB64(s, n);
    return s;
  };
  /** Credential sans sortie PRF (refusé sinon, comme go-webauthn configuré par le serveur). */
  function credential(v: unknown): { rawId: string; userHandle: string | null } {
    if (typeof v !== "object" || v === null || Array.isArray(v)) throw requete();
    if (/"results"|hmacGetSecret/.test(JSON.stringify(v))) throw requete();
    const c = v as { rawId?: unknown; response?: { userHandle?: unknown } };
    const rawId = octetsB64(c.rawId);
    if (rawId === "" || unb64u(rawId).length > 1023) throw requete();
    const uh = c.response?.userHandle;
    return { rawId, userHandle: typeof uh === "string" ? uh : null };
  }

  function nouvelleEtape(e: Omit<Etape, "fin">): string {
    const jeton = b64u(rnd(32));
    etapes.set(jeton, { ...e, fin: now() + ETAPE_MS });
    return jeton;
  }
  function etape(jeton: unknown, sorte: Etape["sorte"]): Etape {
    const e = typeof jeton === "string" ? etapes.get(jeton) : undefined;
    if (typeof jeton === "string") etapes.delete(jeton); // usage unique
    if (!e || e.sorte !== sorte || e.fin < now()) throw new HttpErr(404, "not_found");
    return e;
  }
  const options = (allow: string[]) => ({ challenge: b64u(rnd(32)), timeout: ETAPE_MS, rpId: hote(), ...(allow.length ? { allowCredentials: allow.map((id) => ({ type: "public-key", id })) } : {}), userVerification: "required", extensions: { prf: { eval: { first: ENTREE_PRF } } } });
  const creation = (h: string, exclure: string[]) => ({
    rp: { name: "Shhgone", id: hote() },
    user: { name: "", displayName: "", id: h },
    challenge: b64u(rnd(32)),
    pubKeyCredParams: [-7, -8, -257].map((alg) => ({ type: "public-key", alg })),
    timeout: ETAPE_MS,
    ...(exclure.length ? { excludeCredentials: exclure.map((id) => ({ type: "public-key", id })) } : {}),
    authenticatorSelection: { residentKey: "required", requireResidentKey: true, userVerification: "required" },
    attestation: "none",
    extensions: { credProps: true, prf: { eval: { first: ENTREE_PRF } } },
  });

  function ouvrirSession(h: string, persistante: boolean, etq: string, cred: string | null, parRecup: boolean): string {
    const t = b64u(rnd(32));
    sessions.set(t, { h, sid: b64u(rnd(16)), ajoutee: mois(now()), persistante, etiquette: etq, auth: now(), cred, parRecup });
    return t;
  }
  const coffres = (c: CompteDemo) => ({ blob_profil: c.profil.blob, gen_profil: c.profil.gen, blob_prive: c.prive.blob, gen_prive: c.prive.gen });
  function passkeyDe(credId: string): [CompteDemo, PasskeyDemo] {
    for (const c of comptes.values()) for (const p of c.passkeys) if (p.credId === credId) return [c, p];
    throw new HttpErr(403, "identifiants");
  }
  function laSession(req: Request): { jeton: string; s: Session; c: CompteDemo } {
    const jeton = req.headers.get("X-Shh-Session") ?? "";
    const s = sessions.get(jeton);
    const c = s && comptes.get(s.h);
    if (!s || !c) throw new HttpErr(401, "session");
    return { jeton, s, c };
  }
  const recente = (s: Session) => {
    if (now() - s.auth > RECENT_MS) throw new HttpErr(403, "recent");
  };
  const fermerSessionsDe = (h: string) => {
    for (const [t, s] of sessions) if (s.h === h) sessions.delete(t);
  };

  /** Champs de la preuve anti-robot (inscription/debut, connexion/fin, recup), comme le serveur. */
  const preuve = (b: Record<string, unknown>) => {
    chaine(b.altcha);
    chaine(b.hp);
    chaine(b.shown_at);
  };
  async function route(req: Request, r: string, b: Record<string, unknown>): Promise<unknown> {
    switch (`${req.method} ${r}`) {
      case "POST inscription/debut": {
        preuve(b);
        const h = b64u(rnd(16));
        return { etape: nouvelleEtape({ sorte: "inscription", h }), options: creation(h, []) };
      }
      case "POST inscription/fin": {
        const e = etape(b.etape, "inscription");
        const cr = credential(b.credential);
        const p = chaine(b.p_canon);
        if (p === "" || (pseudos.has(p) && e.pseudo !== p)) {
          etapes.set(b.etape as string, e); // étape gardée (comme le serveur)
          throw new HttpErr(409, "pseudo_pris");
        }
        const env = optionnel(b.env, 60);
        const c: CompteDemo = {
          h: e.h,
          pCanon: p,
          vR: octetsB64(b.v_r, 32),
          envR: octetsB64(b.env_r, 60),
          profil: { blob: octetsB64(b.blob_profil), gen: 1 },
          prive: { blob: octetsB64(b.blob_prive), gen: 1 },
          passkeys: [{ credId: cr.rawId, envs: env ? [env] : [], etiquette: optionnel(b.cred_etiquette, 64), ajoutee: mois(now()) }],
          creeLe: jour(now()),
        };
        comptes.set(e.h, c);
        pseudos.add(p);
        return { session: ouvrirSession(e.h, booleen(b.persistante), optionnel(b.etiquette, 64), cr.rawId, false), h: e.h };
      }
      case "POST connexion/debut":
        return { etape: nouvelleEtape({ sorte: "connexion", h: "" }), options: options([]) };
      case "POST connexion/fin": {
        preuve(b); // anti-robot, comme le serveur (preuve factice de la démo)
        etape(b.etape, "connexion");
        const cr = credential(b.credential);
        const [c, p] = passkeyDe(cr.rawId);
        if (cr.userHandle !== c.h) throw new HttpErr(403, "identifiants");
        return { session: ouvrirSession(c.h, booleen(b.persistante), optionnel(b.etiquette, 64), p.credId, false), h: c.h, cred_id: p.credId, enveloppes: p.envs, ...coffres(c) };
      }
      case "POST recup": {
        preuve(b);
        const vR = b64u(await sha256(unb64u(octetsB64(b.a_r, 32))));
        const c = [...comptes.values()].find((x) => x.vR === vR);
        if (!c) throw new HttpErr(403, "identifiants");
        return { session: ouvrirSession(c.h, booleen(b.persistante), optionnel(b.etiquette, 64), null, true), h: c.h, env_r: c.envR, ...coffres(c) };
      }
      case "POST pseudo/verifier": {
        const e = typeof b.etape === "string" ? etapes.get(b.etape) : undefined;
        if (e?.sorte === "inscription") {
          const p = chaine(b.p_canon);
          const libre = !pseudos.has(p);
          if (libre) e.pseudo = p; // réservé à l'étape jusqu'à son échéance
          return { libre };
        }
        break;
      }
      case "POST pseudo/libre":
        return { libre: !pseudos.has(chaine(b.p_canon)) };
    }

    // --- routes avec session ---
    const { jeton, s, c } = laSession(req);
    switch (`${req.method} ${r}`) {
      case "GET ": {
        const confirme = jour(Date.parse(c.creeLe) + 7 * 86_400_000);
        const palier = jour(now()) >= confirme ? "confirme" : "neuf";
        return {
          h: c.h,
          cree_le: c.creeLe,
          palier,
          confirme_le: confirme,
          limites: palier === "neuf" ? { salons: 1, places: 4, heures: 24 } : { salons: 3, places: 8, heures: 72 },
          salons_actifs: 0,
          banni: false,
          banni_id: null,
          banni_jusqu: null,
          banni_motif: null,
        };
      }
      case "POST reauth/debut":
        return { etape: nouvelleEtape({ sorte: "reauth", h: c.h }), options: options(c.passkeys.map((p) => p.credId)) };
      case "POST reauth/fin": {
        const e = etape(b.etape, "reauth");
        const cr = credential(b.credential);
        const p = c.passkeys.find((x) => x.credId === cr.rawId);
        if (e.h !== c.h || !p) throw new HttpErr(403, "identifiants");
        s.auth = now();
        s.cred = p.credId;
        return { enveloppes: p.envs };
      }
      case "GET passkeys":
        return { passkeys: c.passkeys.map((p) => ({ cred_id: p.credId, ajoutee: p.ajoutee, etiquette: p.etiquette, be: true, prf: p.envs.length > 0 })) };
      case "POST passkeys/debut":
        recente(s);
        if (c.passkeys.length >= PASSKEYS_MAX) throw new HttpErr(409, "passkeys_max");
        return { etape: nouvelleEtape({ sorte: "ajout", h: c.h }), options: creation(c.h, c.passkeys.map((p) => p.credId)) };
      case "POST passkeys/fin": {
        recente(s);
        etape(b.etape, "ajout");
        const cr = credential(b.credential);
        const env = optionnel(b.env, 60);
        c.passkeys.push({ credId: cr.rawId, envs: env ? [env] : [], etiquette: optionnel(b.etiquette, 64), ajoutee: mois(now()) });
        return {};
      }
      case "POST passkeys/enveloppe": {
        recente(s);
        const env = octetsB64(b.env, 60);
        const p = c.passkeys.find((x) => x.credId === s.cred);
        if (!p) throw new HttpErr(403, "sans_passkey");
        if (p.envs.includes(env)) return {};
        if (p.envs.length >= ENVELOPPES_MAX) throw new HttpErr(409, "enveloppes_max");
        p.envs.push(env);
        return {};
      }
      case "POST passkeys/nommer": {
        const p = c.passkeys.find((x) => x.credId === b.cred_id);
        if (!p) throw new HttpErr(404, "not_found");
        p.etiquette = octetsB64(b.etiquette, 64);
        return {};
      }
      case "POST passkeys/retirer": {
        recente(s);
        if (!c.passkeys.some((x) => x.credId === b.cred_id)) throw new HttpErr(404, "not_found");
        if (c.passkeys.length <= 1) throw new HttpErr(409, "derniere");
        c.passkeys = c.passkeys.filter((x) => x.credId !== b.cred_id);
        for (const v of sessions.values()) if (v.cred === b.cred_id) v.cred = null;
        return {};
      }
      case "POST recup/renouveler":
        recente(s);
        c.vR = octetsB64(b.v_r, 32);
        c.envR = octetsB64(b.env_r, 60);
        return {};
      case "GET recup/enveloppe":
        return { env_r: c.envR };
      case "GET coffre/profil":
      case "GET coffre/prive": {
        const v = r.endsWith("profil") ? c.profil : c.prive;
        return { blob: v.blob, gen: v.gen };
      }
      case "PUT coffre/profil":
      case "PUT coffre/prive": {
        const v = r.endsWith("profil") ? c.profil : c.prive;
        if (b.if_gen !== v.gen) throw new HttpErr(409, "conflict", { gen: v.gen });
        v.blob = octetsB64(b.blob);
        v.gen++;
        return { gen: v.gen };
      }
      case "POST pseudo/verifier":
        return { libre: !pseudos.has(chaine(b.p_canon)) || chaine(b.p_canon) === c.pCanon };
      case "POST pseudo": {
        const p = chaine(b.p_canon);
        if (p !== c.pCanon && pseudos.has(p)) throw new HttpErr(409, "pseudo_pris");
        pseudos.delete(c.pCanon);
        pseudos.add((c.pCanon = p));
        return {};
      }
      case "POST sessions/etiquette":
        s.etiquette = optionnel(b.etiquette, 64);
        return {};
      case "POST deconnexion":
        sessions.delete(jeton);
        return {};
      case "GET sessions":
        return {
          sessions: [...sessions]
            .filter(([, v]) => v.h === s.h)
            .map(([t, v]) => ({ sid: v.sid, ajoutee: v.ajoutee, etiquette: v.etiquette, courante: t === jeton, persistante: v.persistante, par_recup: v.parRecup })),
        };
      case "POST sessions/fermer":
        for (const [t, v] of sessions) if (v.h === s.h && (b.autres === true ? t !== jeton : v.sid === b.sid)) sessions.delete(t);
        return {};
      case "GET export":
        return {
          cree_le: c.creeLe,
          anciennete_depuis: c.creeLe,
          vu_mois: mois(now()),
          banni_jusqu: null,
          banni_motif: null,
          salons_actifs: 0,
          sessions: [...sessions.values()].filter((v) => v.h === s.h).map((v) => ({ ajoutee: v.ajoutee, persistante: v.persistante, par_recup: v.parRecup })),
          passkeys: c.passkeys.map((p) => ({ ajoutee: p.ajoutee, be: true, prf: p.envs.length > 0, cle_pub: "" })),
        };
      case "POST supprimer":
        recente(s);
        pseudos.delete(c.pCanon);
        comptes.delete(c.h);
        fermerSessionsDe(c.h);
        return { salons_fermes: 0 };
      case "GET salons":
        return { salons: [] };
    }
    throw new HttpErr(404, "not_found");
  }

  return {
    async handle(req: Request): Promise<Response> {
      const r = new URL(req.url).pathname.replace(/^.*?\/api\/compte\/?/, "");
      let b: Record<string, unknown> = {};
      try {
        if (req.method !== "GET") {
          const t = await req.text();
          if (t !== "") {
            if (/:null[,}\]]/.test(t)) throw requete(); // JSON strict, jamais de null
            const v: unknown = JSON.parse(t);
            if (typeof v !== "object" || v === null || Array.isArray(v)) throw requete();
            b = v as Record<string, unknown>;
          }
        }
        const out = await route(req, r, b);
        sauver();
        const status = r === "inscription/fin" ? 201 : 200;
        return new Response(JSON.stringify(out), { status, headers: { "Content-Type": "application/json" } });
      } catch (e) {
        const err = e instanceof HttpErr ? e : e instanceof SyntaxError ? requete() : new HttpErr(500, "internal");
        sauver();
        return new Response(JSON.stringify({ error: err.code, ...err.extra }), { status: err.status, headers: { "Content-Type": "application/json" } });
      }
    },
  };
}
