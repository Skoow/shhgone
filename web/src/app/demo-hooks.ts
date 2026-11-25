// Crochets de la démo GitHub Pages (UI §14.3). Seul point par lequel les écrans voient la
// démo : ils n'importent jamais `src/demo/` (règle de sources). En production, `setDemo`
// n'est jamais appelé (le module de démo n'est pas dans le build) et `getDemo()` rend null.
import type { Component } from "svelte";
import type { CaptchaProof } from "../index";

export type DemoHooks = {
  /** Preuve factice que seul le faux serveur accepte (anti-robot désactivé en démo). */
  solveCaptcha: (challenge: unknown) => Promise<CaptchaProof>;
  /** Navigue dans l'application (pushState, sans rechargement) vers un lien de partage. */
  openAsRecipient(link: string): void;
  /** Phrase ajoutée à « Lien invalide » (langue courante). */
  readonly invalidLinkNote: string;
  /** Écarts de protection de la démo par rapport à la production (page Sécurité, langue courante). */
  readonly securityGaps: string;
  /** Mention sous le lien de « Lien prêt » (langue courante) : le lien de démo ne marche que dans cet onglet. */
  readonly readyNote: string;
  /** Compte essayable : passkey simulée (demo/passkeys.ts), lue par account/navigateur.demo.ts seulement. */
  readonly passkeys: unknown;
  /** Phrase des pages du compte (langue courante) : rien n'est envoyé, le compte vit dans cet onglet. */
  readonly compteNote: string;
  /** Bouton de l'inscription (langue courante) : « Simuler la passkey », aucune passkey n'étant créée. */
  readonly signupPasskey: string;
  /** Phrase visible du pied de page (langue courante) : GitHub héberge la démo et voit l'adresse IP. */
  readonly hostNote: string;
  /** Bandeau permanent, rendu dans l'emplacement `banner` de AppShell. */
  Banner: Component;
};

let hooks: DemoHooks | null = null;

export function getDemo(): DemoHooks | null {
  return hooks;
}

/** Appelé par installDemo seulement, une fois, avant le montage de l'application. */
export function setDemo(h: DemoHooks): void {
  if (hooks !== null) throw new Error("démo déjà installée");
  hooks = h;
}
