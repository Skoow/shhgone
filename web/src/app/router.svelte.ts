// Routeur interne (UI §9). Il lit le chemin, sous « /s » seulement, la FORME du « # »
// (spec §32 : « #m<43> » gestion, sinon ouverture) sans jamais en garder le contenu : la clé est
// lue une fois par readLink (app/link.ts), puis retirée de l'adresse. Un « # » à la racine (ancienne
// forme, refusée) n'ouvre rien : l'accueil le retire de l'adresse.
import { flushSync } from "svelte";
import { MANAGE_FRAGMENT } from "../engine/pure";
import type { Lang } from "../i18n/format";
import { getLang } from "../i18n/i18n.svelte";
import { BILINGUE, PAGES_BILINGUES, cheminEn, langueDuChemin } from "./langues";
import { runTransition } from "../ui/viewTransition";
import { createLeaveGuard } from "./leave-guard";

/**
 * Marque de l'entrée d'historique d'une ouverture déverrouillée (aucun secret) : un
 * rechargement de cette entrée, sans « # », revient à l'écran d'ouverture : état « reopen »
 * si l'onglet garde l'octroi (spec §41.4), sinon « Lien incomplet » (Terminer, destruction,
 * 30 min d'inactivité…). Une autre entrée (accueil) reste l'accueil.
 */
export const REOPEN_MARK = "shhOg";
export function markReopen(h: History): void {
  h.replaceState({ [REOPEN_MARK]: true }, "", shownPath(location.pathname));
}

/**
 * Adresse affichée une fois le lien lu (« /s » n'est
 * montré que quand il sert) : la page « /s » remplace son adresse par l'accueil (« / ») après
 * avoir lu et retiré le « # ». Un rechargement de « / » marqué (markReopen) repart vers « /s »
 * (moveToLinkPage), où l'écran d'ouverture retrouve l'octroi de l'onglet (spec §41.4). Toute
 * autre adresse est rendue telle quelle.
 */
export function shownPath(pathname: string): string {
  const base = import.meta.env.BASE_URL.replace(/\/$/, "");
  return pathname === base + "/s" || pathname === base + "/s.html" ? base + "/" : pathname;
}
const reopenHere = () =>
  typeof history !== "undefined" && (history.state as Record<string, unknown> | null)?.[REOPEN_MARK] === true;

/** Pages d'information (pied de page) : chemin → route. */
export type InfoRoute = "securite" | "confidentialite" | "conditions" | "mentions" | "signaler" | "verifier" | "contact";
export const INFO_PATHS: Readonly<Record<string, InfoRoute>> = {
  "/securite": "securite",
  "/confidentialite": "confidentialite",
  "/conditions": "conditions",
  "/mentions-legales": "mentions",
  "/signaler": "signaler",
  // « Vérifier cette version » (spec §28.4) : section de la page Sécurité, ouverte à son titre
  // (pages/PagesApp.svelte) ; adresse gardée, citée par les Releases, le README et la spec.
  "/verifier": "verifier",
  "/contact": "contact",
};

/** Pages du compte, seulement si __COMPTES__ : chemin → route. */
export type CompteRoute = "compte" | "inscription" | "connexion" | "recuperation";

/**
 * Pages du salon, seulement si __SALONS__ (site avec compte, hors démo) : « /salon »
 * (lien d'invitation « #c… », salon prêt, conversation ; aucun secret dans le chemin) et
 * « /salon/nouveau » (création, compte exigé). Relue par TestAppRoutesMatchClientRouter
 * (server/cmd/shhdrop), comparée à salonRoutes, servies en 200 avec SHH_SALONS=1 et SHH_COMPTES=1.
 */
export type SalonRoute = "salon" | "salonnouveau" | "salons";
const SALON_PATHS: Readonly<Record<string, SalonRoute>> = {
  "/salon": "salon",
  "/salon/nouveau": "salonnouveau",
  // « Mes salons » (28 novembre, décision du propriétaire) : les salons créés, liste de l'appareil
  // et du compte, aucun secret dans l'adresse.
  "/salons": "salons",
};
// Relue par TestAppRoutesMatchClientRouter (server/cmd/shhdrop) et comparée à compteRoutes du
// serveur, qui ne les sert en 200 qu'avec SHH_COMPTES=1 (sinon 404, comme toute page inconnue).
const COMPTE_PATHS: Readonly<Record<string, CompteRoute>> = {
  "/compte": "compte",
  "/compte/inscription": "inscription",
  "/compte/connexion": "connexion",
  "/compte/recuperation": "recuperation",
  // Ancienne page Profil, réunie à la page Compte (25 novembre) : adresse remplacée (ANCIENNES).
  "/compte/profil": "compte",
};

export type Route = {
  /** envoyer : page d'envoi (composeur, même vide), où mène « Commencer » (retours DROP). */
  name: "home" | "envoyer" | "envois" | "open" | "manage" | InfoRoute | "offres" | "offert" | CompteRoute | SalonRoute | "notfound";
};

/**
 * Seul paramètre d'adresse du site (conception compte §10.4) : « ?suite=salon », exactement,
 * posé par « Créer un salon » sans session. Aucune donnée : il dit seulement où revenir après la
 * connexion. Toute autre requête est ignorée (jamais lue, jamais recopiée).
 */
export function suite(search: string): "salon" | null {
  return search === "?suite=salon" ? "salon" : null;
}

export function match(pathname: string, hash = "", base: string = import.meta.env.BASE_URL, reopen = false, comptes: boolean = __COMPTES__, salons: boolean = __SALONS__, bilingue: boolean = BILINGUE): Route {
  const prefix = base.endsWith("/") ? base.slice(0, -1) : base; // "" ou "/shhdrop"
  let p = pathname;
  if (prefix !== "") {
    if (p === prefix) p = "/";
    else if (p.startsWith(prefix + "/")) p = p.slice(prefix.length);
    else return { name: "notfound" };
  }
  // Version anglaise d'une page bilingue (« /en », « /en/securite », app/langues.ts) : même
  // route que la version française ; « /en/… » d'une autre page est introuvable.
  if (p === "/en" || p.startsWith("/en/")) {
    const fr = langueDuChemin(p);
    if (fr === null || !bilingue) return { name: "notfound" };
    p = fr.chemin;
  }
  if (p === "/") {
    // Ouverture déverrouillée rechargée sous « / » (adresse montrée, shownPath) : retour à « /s ».
    if (hash === "" && reopen) return { name: "open" };
    return { name: "home" };
  }
  // Liens sous « /s » : ouverture et gestion, dans leur
  // propre page (s.html). Sans fragment de la bonne forme : l'écran d'ouverture dit « Lien
  // incomplet » (ou rouvre, après un rechargement de l'ouverture déverrouillée).
  if (p === "/s" || p === "/s.html") {
    if (MANAGE_FRAGMENT.test(hash)) return { name: "manage" };
    return { name: "open" };
  }
  // Pages d'information : aussi sous le nom de leur fichier (« /securite.html », pages séparées).
  const page = p.endsWith(".html") ? p.slice(0, -5) : p;
  const info = Object.hasOwn(INFO_PATHS, page) ? INFO_PATHS[page] : undefined;
  if (info !== undefined) return { name: info };
  if (p === "/offres") return { name: "offres" };
  if (p === "/offres.html") return { name: "offres" };
  // Retour de la page hébergée du prestataire de paiement (conception du paiement §2) : la page
  // des Offres, qui affiche l'état du paiement ; aucune donnée dans l'adresse.
  if (p === "/offres/retour") return { name: "offres" };
  // Accès offert par l'exploitant (conception du paiement, « Accès offerts ») : écran de
  // l'application (le compte y est ouvert) qui range le pass qui suit « # », lu puis effacé de
  // l'adresse (ui/OffersGift.svelte).
  if (p === "/offres/offert") return { name: "offert" };
  if (p === "/envoyer") return { name: "envoyer" };
  // « Mes partages » (spec §33, D42-30) : liste locale, aucun secret dans l'adresse.
  if (p === "/envois") return { name: "envois" };
  // Pages du compte : sans __COMPTES__ (défaut, démo), la même 404 qu'une adresse inconnue.
  const compte = comptes && Object.hasOwn(COMPTE_PATHS, p) ? COMPTE_PATHS[p] : undefined;
  if (compte !== undefined) return { name: compte };
  // Salon : sans __SALONS__ (démo, site sans compte), la même 404.
  const salon = salons && Object.hasOwn(SALON_PATHS, p) ? SALON_PATHS[p] : undefined;
  if (salon !== undefined) return { name: salon };
  // « /s/ » reste réservé aux futurs liens universels (spec §16) : aucune route aujourd'hui.
  return { name: "notfound" };
}

export const router = $state<{ current: Route }>({
  current: typeof location === "undefined" ? { name: "home" } : match(location.pathname, location.hash, undefined, reopenHere()),
});

/**
 * Anciennes adresses (25 novembre) : « /compte/profil » (Profil réuni à la page Compte ;
 * « /envois » est de nouveau « Mes partages » depuis le 26 novembre, D42-30). Remplacées dans la barre d'adresse, sans
 * nouvelle entrée d'historique du navigateur ; la route est déjà la bonne (match).
 */
export const ANCIENNES: Readonly<Record<string, string>> = { "/compte/profil": "/compte" };
function remplacerAncienne(): void {
  if (typeof location === "undefined" || typeof history === "undefined") return;
  const prefix = import.meta.env.BASE_URL.replace(/\/$/, "");
  const p = location.pathname.startsWith(prefix + "/") ? location.pathname.slice(prefix.length) : location.pathname;
  const vers = Object.hasOwn(ANCIENNES, p) ? ANCIENNES[p] : undefined;
  if (vers !== undefined) history.replaceState(history.state, "", href(vers) + location.hash);
}

// Ne réaffecte que si la route change : un popstate sans effet (lien vers la page courante,
// « # » retiré) ne relance ni les effets ni le focus.
function sync(): void {
  remplacerAncienne();
  const next = match(location.pathname, location.hash, undefined, reopenHere());
  if (next.name !== router.current.name) router.current = next;
}

/** Garde du bouton Retour et des liens internes pendant un envoi et sur « Lien prêt » (app/leave-guard.ts). */
export const leaveGuard = typeof window === "undefined" ? null : createLeaveGuard(window);

// Retour du système (geste, bouton) : même glissement, vers la droite, sur téléphone.
if (typeof window !== "undefined")
  window.addEventListener("popstate", () => {
    if (leaveGuard?.onPop()) return; // envoi en cours ou lien affiché : confirmé ou absorbé
    // Un « # » (lien collé, clé) se lit tout de suite, sans transition : l'écran qui le lit et
    // le gestionnaire hashchange d'App doivent voir la route à jour dans le même tour.
    const moves = match(location.pathname, location.hash, undefined, reopenHere()).name !== router.current.name;
    if (moves && phone() && location.hash === "") void runTransition(() => flushSync(sync), { back: true });
    else sync();
  });

const base = () => import.meta.env.BASE_URL;

/**
 * Pages servies par leur propre fichier HTML (pages séparées) : le
 * serveur répond « securite.html » à « /securite ». Entre l'application (index.html) et ces
 * pages, un lien charge l'autre page (navigation complète) ; à l'intérieur de l'une ou de
 * l'autre, rien ne change.
 */
export const PAGE_ROUTES: ReadonlySet<Route["name"]> = new Set<Route["name"]>(["securite", "confidentialite", "conditions", "mentions", "signaler", "verifier", "contact", "offres"]);
/** Écrans de la page « /s » (s.html) : ouverture et gestion d'un partage. */
export const LINK_ROUTES: ReadonlySet<Route["name"]> = new Set<Route["name"]>(["open", "manage"]);
type Entry = "app" | "pages" | "s";
let entry: Entry = "app";
/** Appelé une fois par le point d'entrée des pages d'information (src/pages/main.ts) et de /s (src/open/main.ts). */
export function setEntry(e: Entry): void {
  entry = e;
}
const entryOf = (name: Route["name"]): Entry => (PAGE_ROUTES.has(name) ? "pages" : LINK_ROUTES.has(name) ? "s" : "app");
/** Vrai si `path` est servi par un autre fichier HTML que la page courante. */
export function otherEntry(path: string): boolean {
  return entryOf(match(href(path), "").name) !== entry;
}

/**
 * Entrée « / » d'une ouverture déverrouillée (markReopen), rechargée : remplacée,
 * sans nouvelle entrée d'historique, par « /s » (où l'écran d'ouverture retrouve l'octroi de
 * l'onglet). Rend vrai si la page part ; l'appelant n'affiche alors rien.
 */
export function moveToLinkPage(loc: Pick<Location, "pathname" | "hash" | "replace">, reopen: boolean = reopenHere()): boolean {
  const name = match(loc.pathname, loc.hash, undefined, reopen).name;
  // Déjà sur « /s » (serveur sans s.html, qui rendrait index.html) : jamais de boucle.
  const onS = loc.pathname === href("/s") || loc.pathname === href("/s.html");
  if (!LINK_ROUTES.has(name) || entry !== "app" || onS) return false;
  loc.replace(href("/s"));
  return true;
}

/**
 * Chemin de la page courante, pour « aria-current » : sans « .html » (une page d'information
 * peut être ouverte sous le nom de son fichier) ; au rendu du build (pas de location), celui de
 * la route courante.
 */
export function currentPath(): string {
  if (typeof location !== "undefined") return location.pathname.replace(/\.html$/, "");
  const n = router.current.name;
  const info = Object.keys(INFO_PATHS).find((k) => INFO_PATHS[k] === n);
  return href(info ?? (n === "offres" ? "/offres" : "/"));
}

/**
 * Adresse complète d'un chemin de l'application (préfixe de dépôt en démo). Page bilingue en
 * anglais (app/langues.ts) : sa version « /en… », pour rester dans la langue affichée.
 */
export function href(path: string, lang: Lang = getLang(), bilingue: boolean = BILINGUE): string {
  const p = bilingue && PAGES_BILINGUES.includes(path) ? cheminEn(lang, path) : path;
  return base().replace(/\/$/, "") + p;
}

/**
 * Chemin interne seulement : « /… », sans « // », « \ », « # » ni « ? » (aucun secret ne transite
 * ici) ; seule exception, « ?suite=salon » sur la connexion et l'inscription (suite()).
 */
export function navigate(path: string, opts: { back?: boolean } = {}): void {
  const nu = path.replace(/^(\/compte\/(?:connexion|inscription))\?suite=salon$/, "$1");
  if (!/^\/(?!\/)[^\\#?]*$/.test(nu)) throw new Error("chemin interne attendu");
  // Envoi en cours ou « Lien prêt » pas encore copié : la même confirmation que le Retour.
  const leave = leaveGuard?.leave() ?? { go: true, replace: false };
  if (!leave.go) return;
  // L'autre fichier HTML (application ↔ page d'information) : chargement complet.
  if (otherEntry(nu)) {
    if (leave.replace) location.replace(href(path));
    else location.assign(href(path));
    return;
  }
  const go = () => {
    if (leave.replace) history.replaceState(null, "", href(path));
    else history.pushState(null, "", href(path));
    sync();
    if (typeof window.scrollTo === "function") window.scrollTo(0, 0);
  };
  // Téléphone : l'écran glisse (en arrière : vers la droite ; fondu en mouvement réduit).
  if (phone()) void runTransition(() => flushSync(go), { back: opts.back });
  else go();
}
const phone = () => typeof matchMedia === "function" && matchMedia("(max-width: 899px)").matches;

/** Gestionnaire de clic pour un <a href> interne : navigation sans rechargement, sauf clic modifié. */
export function followLink(e: MouseEvent, path: string): void {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  navigate(path);
}

// Au chargement : une ancienne adresse est remplacée tout de suite (ANCIENNES).
remplacerAncienne();
