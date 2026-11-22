// Remplaçant de pages.ts sans __COMPTES__ (greffon shh-comptes de vite.config.ts) : aucune page,
// aucun import. App.svelte ne les montre jamais sans le drapeau (match() ne rend pas ces routes).
import type { Component } from "svelte";

const absente = (() => {
  throw new Error("compte_absent");
}) as unknown as Component;
export const Connexion = absente;
export const Inscription = absente;
export const Recuperation = absente;
export const restaurer = async (): Promise<void> => undefined;
export const seDeconnecter = async (): Promise<void> => undefined;
export const ecouterAutresOnglets = (): (() => void) => () => undefined;
export const verifierAuRetour = async (): Promise<void> => undefined;
export const Accueil = absente;
export const Parametres = absente;
export const Profil = absente;
export const connecte = (): boolean => false;
export const supprime = (): boolean => false;
