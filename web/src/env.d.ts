/// <reference types="vite/client" />

declare module "*.svelte" {
  import type { Component } from "svelte";
  const component: Component<any>;
  export default component;
}

/** Version du site (hash court du commit, vite.config.ts) ; absente sous vitest. */
declare const __SHH_BUILD__: string | undefined;

/** Compte par e-mail (vite.config.ts, comptesActifs) : false par défaut et dans la démo ; false sous vitest. */
declare const __COMPTES__: boolean;

/** Salon (plan C-3) : vrai en production avec le compte (création exigée par D42-26), faux dans la démo (pas de serveur du salon) ; faux sous vitest. */
declare const __SALONS__: boolean;

/** Pages bilingues écrites au build sous « /en » (app/langues.ts) : vrai hors démo ; faux sous vitest. */
declare const __BILINGUE__: boolean;

// Cadre PDF isolé : le worker de pdf.js, chargé sur le fil principal (UI §13).
declare module "pdfjs-dist/build/pdf.worker.mjs" {
  export const WorkerMessageHandler: unknown;
}

// Moteur WebAssembly (greffon shh-engine, vite.config.ts). Production : adresses et empreintes
// SRI du .wasm et du script du Worker d'Argon2id. Démo : le .wasm en base64 (`wasm`).
declare module "virtual:shh-engine" {
  export const src: string;
  export const integrity: string;
  export const workerSrc: string;
  export const workerIntegrity: string;
  export const wasm: string;
}

// Worker de la preuve de travail (greffon shh-pow, vite.config.ts), production seulement : adresse
// et empreinte SRI de assets/pow-worker-EMPREINTE.js.
declare module "virtual:shh-pow" {
  export const src: string;
  export const integrity: string;
}

// Dictionnaire anglais (greffon shh-lang, vite.config.ts), production seulement : adresse et
// empreinte SRI de assets/locale-en-EMPREINTE.js.
declare module "virtual:shh-lang" {
  export const src: string;
  export const integrity: string;
}

// Module WebAssembly du salon (greffon shh-salon, vite.config.ts). Production : adresse et
// empreinte SRI de assets/salon-EMPREINTE.wasm. Démo : le .wasm en base64 (`wasm`), dans un
// morceau chargé à part (le pseudo du compte de la démo, 19 novembre).
declare module "virtual:shh-salon" {
  export const src: string;
  export const integrity: string;
  export const wasm: string;
}

// Module WebAssembly des jetons anonymes (greffon shh-jetons, vite.config.ts, conception du
// paiement §7) : adresse et empreinte SRI de assets/jetons-EMPREINTE.wasm (vides dans la démo).
declare module "virtual:shh-jetons" {
  export const src: string;
  export const integrity: string;
}
