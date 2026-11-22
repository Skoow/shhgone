// Passkey SIMULÉE de la démo GitHub Pages (conception du compte par passkey §11, Q8 : une vraie
// passkey de la démo resterait dans le gestionnaire de la personne, enregistrée pour
// skoow.github.io). Joue navigator.credentials pour account/webauthn.ts (branché par
// account/navigateur.demo.ts, greffon shh-navigateur de vite.config.ts) : aucune feuille du
// système, aucune passkey créée. Sortie PRF calculée comme WebAuthn le définit
// (HMAC-SHA-256(secret de la passkey, SHA-256(« WebAuthn PRF » ‖ 0x00 ‖ entrée)), WebCrypto),
// pour que la clé de récupération, les enveloppes et les coffres soient les vrais (moteur).
// Les secrets simulés restent dans cet onglet (gardés par demo/persist.ts), comme ceux d'un
// authentificateur.

export const MARK = "__SHH_DEMO__";

type Bytes = Uint8Array<ArrayBuffer>;
type PasskeySimulee = { id: string; userHandle: string; secret: string };

const b64u = (b: Uint8Array) => {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const unb64u = (s: string): Bytes => {
  const t = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(t + "=".repeat((4 - (t.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0)) as Bytes;
};
const octets = (v: BufferSource | undefined): Bytes => (v === undefined ? new Uint8Array(0) : ArrayBuffer.isView(v) ? new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength)) : new Uint8Array((v as ArrayBuffer).slice(0))) as Bytes;
const buf = (b: Uint8Array) => b.slice().buffer as ArrayBuffer;
const json = (o: unknown) => buf(new TextEncoder().encode(JSON.stringify(o)));

async function sortie(secret: string, entree: Bytes): Promise<ArrayBuffer> {
  const sel = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array([...new TextEncoder().encode("WebAuthn PRF\0"), ...entree])));
  const k = await crypto.subtle.importKey("raw", unb64u(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", k, sel);
}
const entreePrf = (e: AuthenticationExtensionsClientInputs | undefined) => (e as { prf?: { eval?: { first?: BufferSource } } } | undefined)?.prf?.eval?.first;

/** Authentificateur simulé ; `restore` / `onChange` : passkeys gardées pour l'onglet. */
export function passkeysSimulees(o: { restore?: PasskeySimulee[] | null; onChange?: (l: PasskeySimulee[]) => void } = {}) {
  let liste: PasskeySimulee[] = o.restore ?? [];
  const changer = (l: PasskeySimulee[]) => {
    liste = l;
    o.onChange?.(liste);
  };
  return {
    credentials: {
      async create(opts: CredentialCreationOptions): Promise<Credential> {
        const pk = opts.publicKey!;
        const exclues = new Set((pk.excludeCredentials ?? []).map((d) => b64u(octets(d.id))));
        if (liste.some((p) => exclues.has(p.id))) throw Object.assign(new Error("déjà enregistrée"), { name: "InvalidStateError" });
        const p: PasskeySimulee = { id: b64u(crypto.getRandomValues(new Uint8Array(16))), userHandle: b64u(octets(pk.user.id)), secret: b64u(crypto.getRandomValues(new Uint8Array(32))) };
        changer([...liste, p]);
        const e = entreePrf(pk.extensions);
        const ext = { credProps: { rk: true }, prf: { enabled: true, ...(e ? { results: { first: await sortie(p.secret, octets(e)) } } : {}) } };
        return {
          rawId: buf(unb64u(p.id)),
          response: { clientDataJSON: json({ type: "webauthn.create", challenge: b64u(octets(pk.challenge)) }), attestationObject: buf(new Uint8Array(1)) },
          getClientExtensionResults: () => ext,
        } as unknown as Credential;
      },
      async get(opts: CredentialRequestOptions): Promise<Credential> {
        const pk = opts.publicKey!;
        const permises = new Set((pk.allowCredentials ?? []).map((d) => b64u(octets(d.id))));
        const p = [...liste].reverse().find((x) => permises.size === 0 || permises.has(x.id));
        if (!p) throw Object.assign(new Error("aucune passkey simulée"), { name: "NotAllowedError" });
        const e = entreePrf(pk.extensions);
        const ext = e ? { prf: { results: { first: await sortie(p.secret, octets(e)) } } } : {};
        return {
          rawId: buf(unb64u(p.id)),
          response: { clientDataJSON: json({ type: "webauthn.get", challenge: b64u(octets(pk.challenge)) }), authenticatorData: buf(new Uint8Array(37)), signature: buf(new Uint8Array(1)), userHandle: buf(unb64u(p.userHandle)) },
          getClientExtensionResults: () => ext,
        } as unknown as Credential;
      },
    },
    /** signalUnknownCredential : la passkey simulée est oubliée. */
    signalInconnue: async ({ credentialId }: { rpId: string; credentialId: string }) => changer(liste.filter((p) => p.id !== credentialId)),
  };
}

export type PasskeysSimulees = ReturnType<typeof passkeysSimulees>;
export type { PasskeySimulee };
