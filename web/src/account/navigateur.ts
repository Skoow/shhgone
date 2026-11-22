// Passkeys du navigateur (conception du compte par passkey §9) : SEUL fichier du site qui touche
// navigator.credentials et PublicKeyCredential (source-rules.test.ts). account/webauthn.ts
// l'utilise ; la démo le remplace par navigateur.demo.ts (passkey simulée, greffon shh-navigateur
// de vite.config.ts : aucune passkey de démo laissée dans le gestionnaire des visiteurs).
export type Navigateur = {
  credentials: { create(o: CredentialCreationOptions): Promise<Credential | null>; get(o: CredentialRequestOptions): Promise<Credential | null> } | null;
  /** PublicKeyCredential.signalUnknownCredential, là où il existe. */
  signalInconnue?: (o: { rpId: string; credentialId: string }) => Promise<void>;
};

export function navigateurParDefaut(): Navigateur {
  const pkc = (globalThis as { PublicKeyCredential?: { signalUnknownCredential?: (o: { rpId: string; credentialId: string }) => Promise<void> } }).PublicKeyCredential;
  const c = typeof pkc === "function" ? (globalThis.navigator?.credentials ?? null) : null;
  return {
    credentials: c,
    signalInconnue: typeof pkc?.signalUnknownCredential === "function" ? (o) => pkc.signalUnknownCredential!(o) : undefined,
  };
}
