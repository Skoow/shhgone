// Démo GitHub Pages (greffon shh-navigateur de vite.config.ts) : remplace navigateur.ts. La passkey
// est simulée par src/demo/passkeys.ts (crochet `passkeys` de app/demo-hooks.ts) : aucun appel à
// navigator.credentials dans le build de la démo (scripts/check-dist.mjs --demo).
import { getDemo } from "../app/demo-hooks";
import type { Navigateur } from "./navigateur";

export type { Navigateur };

export function navigateurParDefaut(): Navigateur {
  return (getDemo()?.passkeys as Navigateur | undefined) ?? { credentials: null };
}
