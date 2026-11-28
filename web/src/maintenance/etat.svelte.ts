// Maintenance programmée (deploy/maintenance.sh, D42-32 de la spécification) : le serveur dit
// l'horaire annoncé par GET /api/etat-service, lu au chargement puis toutes les quelques minutes ;
// en mode « redémarrage imminent », il refuse les nouvelles créations (503 maintenance) et le site
// désactive les boutons concernés. Rien d'autre n'est envoyé ni gardé : la requête ne porte aucune
// donnée, et la réponse ne dit que l'horaire public (à l'heure locale du visiteur à l'affichage).
// Les apps liront la même route.
import { formatClock } from "../i18n/format";
import { getLang, t } from "../i18n/i18n.svelte";
import { ecouterMaintenance } from "./signal";

export type Annonce = { debut: number; dureeMin: number; retour: number; imminente: boolean };

/** État lu (null : aucune maintenance annoncée). */
export const maintenance = $state<{ annonce: Annonce | null }>({ annonce: null });

/** Lecture toutes les 5 min ; toutes les 2 min quand une maintenance est annoncée. */
export const PERIODE_MS = 5 * 60_000;
export const PERIODE_ANNONCE_MS = 2 * 60_000;

const entier = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0;

/** Réponse de /api/etat-service, vérifiée champ par champ (null : rien, ou réponse refusée). */
export function lireEtat(o: unknown): Annonce | null {
  if (typeof o !== "object" || o === null) return null;
  const m = (o as { maintenance?: unknown }).maintenance;
  if (typeof m !== "object" || m === null) return null;
  const { debut, duree_min: dureeMin, retour, imminente } = m as Record<string, unknown>;
  if (!entier(debut) || !entier(dureeMin) || dureeMin > 1440 || !entier(retour) || retour !== debut + dureeMin * 60 || typeof imminente !== "boolean") return null;
  return { debut, dureeMin, retour, imminente };
}

/** Lit l'état du service ; une erreur (réseau, serveur ancien) laisse l'état connu tel quel. */
export async function rafraichir(f: typeof fetch = (i, o) => globalThis.fetch(i, o)): Promise<void> {
  try {
    const r = await f("/api/etat-service", { method: "GET", credentials: "same-origin", redirect: "error", cache: "no-store" });
    if (!r.ok) return;
    maintenance.annonce = lireEtat(await r.json());
  } catch {
    // Hors ligne ou serveur qui redémarre : rien à changer.
  }
}

/**
 * Lecture au chargement, puis périodique (et au retour sur l'onglet) ; rend la fonction qui
 * l'arrête. Une seule surveillance par page.
 */
export function surveiller(w: Window, f?: typeof fetch): () => void {
  let minuterie: ReturnType<typeof setTimeout> | undefined;
  let fini = false;
  let enCours = false; // une seule lecture à la fois (retour sur l'onglet pendant une lecture)
  const tour = async () => {
    if (enCours) return;
    enCours = true;
    clearTimeout(minuterie);
    try {
      await rafraichir(f);
    } finally {
      enCours = false;
    }
    if (fini) return;
    minuterie = setTimeout(tour, maintenance.annonce ? PERIODE_ANNONCE_MS : PERIODE_MS);
  };
  const visible = () => {
    if (w.document.visibilityState === "visible") void tour();
  };
  void tour();
  w.document.addEventListener("visibilitychange", visible);
  return () => {
    fini = true;
    clearTimeout(minuterie);
    w.document.removeEventListener("visibilitychange", visible);
  };
}

/** Refus 503 « maintenance » reçu d'une création : le mode imminent est connu tout de suite. */
export function noterRefus(retour: number): void {
  if (!entier(retour)) return;
  const a = maintenance.annonce;
  maintenance.annonce = a && a.retour === retour ? { ...a, imminente: true } : { debut: retour, dureeMin: 0, retour, imminente: true };
}

/** À appeler par chaque client d'API sur une réponse en erreur : un 503 « maintenance » passe le site en mode imminent. */
export function signalerMaintenance(status: number, corps: unknown): void {
  const r = retourDe(status, corps);
  if (r !== null) noterRefus(r);
}
// Les clients d'API passent par maintenance/signal.ts (sans Svelte) : l'état s'y abonne ici.
ecouterMaintenance(signalerMaintenance);

/** Créations fermées (mode « redémarrage imminent ») : les boutons concernés sont désactivés. */
export function creationsFermees(): boolean {
  return maintenance.annonce?.imminente === true;
}

/** Corps d'une réponse 503 « maintenance » : son heure de retour, sinon null. */
export function retourDe(status: number, corps: unknown): number | null {
  if (status !== 503 || typeof corps !== "object" || corps === null) return null;
  const { error, retour } = corps as Record<string, unknown>;
  return error === "maintenance" && entier(retour) ? retour : null;
}

const jour = (s: number) => new Intl.DateTimeFormat(getLang(), { weekday: "long", day: "numeric", month: "long" }).format(new Date(s * 1000));

/** Texte du bandeau (heure locale du visiteur), ou "" sans annonce. */
export function texteBandeau(a: Annonce | null = maintenance.annonce): string {
  if (!a) return "";
  if (a.imminente) return texteRefus(a.retour);
  return t("maintenance.annonce", { date: jour(a.debut), heure: formatClock(a.debut * 1000, getLang()), duree: a.dureeMin });
}

/** « Le serveur va redémarrer : réessayez après la maintenance (vers {heure}) ». */
export function texteRefus(retour: number): string {
  return t("maintenance.imminente", { heure: formatClock(retour * 1000, getLang()) });
}
