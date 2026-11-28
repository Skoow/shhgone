// Relais des refus « maintenance » (D42-32), sans Svelte : les clients d'API (transfert, compte,
// salon, paiement) l'appellent sur chaque réponse en erreur ; l'état affiché (etat.svelte.ts,
// chargé par l'en-tête du site) s'y abonne. Ainsi le client de transfert (src/index.ts) reste
// utilisable hors de l'interface (scripts, tests de bout en bout sous Node) : il ne tire plus les
// runes de Svelte.
type Ecouteur = (status: number, corps: unknown) => void;
let ecouteur: Ecouteur | null = null;

/** À appeler par chaque client d'API sur une réponse en erreur (sans effet hors du site). */
export function signalerMaintenance(status: number, corps: unknown): void {
  ecouteur?.(status, corps);
}

/** Abonnement de l'état affiché (un seul). */
export function ecouterMaintenance(f: Ecouteur): void {
  ecouteur = f;
}
