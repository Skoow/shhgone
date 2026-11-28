import { bundled, fetchEn } from "./en-source";
import { fr } from "./fr";
import { BILINGUE, langueDuChemin } from "../app/langues";
import { plural, type Lang } from "./format";

type Dict = Record<keyof typeof fr, string>;
// Une seule langue au démarrage : le français est dans le script (langue par défaut et de repli) ;
// en production, l'anglais est un fichier à part, lu avec son empreinte seulement s'il sert
// (en-source.verified.ts). Tests, `vite dev` et démo : intégré (en-source.ts).
const dicts: Partial<Record<Lang, Dict>> = { fr };
if (bundled !== undefined) dicts.en = bundled as Dict;

/** Dictionnaire lu : exactement les clés du français, toutes des textes ; sinon refusé. */
function checkDict(x: unknown): Dict {
  if (typeof x !== "object" || x === null || Array.isArray(x)) throw new Error("dictionnaire_invalide");
  const keys = Object.keys(x);
  if (keys.length !== Object.keys(fr).length || !keys.every((k) => Object.hasOwn(fr, k) && typeof (x as Record<string, unknown>)[k] === "string"))
    throw new Error("dictionnaire_invalide");
  return x as Dict;
}

let loading: Promise<boolean> | undefined;
/** Charge une langue (vrai si elle est prête) ; un échec laisse la langue en cours. */
function loadLang(l: Lang): Promise<boolean> {
  if (dicts[l] !== undefined) return Promise.resolve(true);
  loading ??= fetchEn()
    .then((x) => {
      dicts.en = checkDict(x);
      return true;
    })
    .catch(() => {
      loading = undefined; // un nouvel essai reste possible
      return false;
    });
  return loading;
}


// Les clés à pluriel s'écrivent « base.one » / « base.other » ; on appelle t("base", { n }).
type Strip<K> = K extends `${infer B}.${"one" | "other"}` ? B : K;
export type Key = Strip<keyof typeof fr>;

/** UI §10 : la première langue du navigateur dont la langue primaire est fr ou en décide ; sinon français. */
export function detectLang(languages: readonly string[] = typeof navigator === "undefined" ? [] : navigator.languages): Lang {
  for (const l of languages) {
    const primary = l.split("-")[0]!.toLowerCase();
    if (primary === "fr" || primary === "en") return primary;
  }
  return "fr";
}

/**
 * Langue fixée par l'adresse d'une page bilingue (app/langues.ts) : « /en… » en
 * anglais, la version française en français (le serveur y a déjà envoyé un navigateur anglophone
 * vers « /en », static.go) ; null ailleurs, dans la démo et sous vitest.
 */
export function langueDeLAdresse(pathname: string, base: string = import.meta.env.BASE_URL, bilingue: boolean = BILINGUE): Lang | null {
  if (!bilingue) return null;
  const b = base.replace(/\/$/, "");
  if (b !== "" && pathname !== b && !pathname.startsWith(b + "/")) return null;
  return langueDuChemin(pathname.slice(b.length) || "/")?.lang ?? null;
}

// Sans mémorisation (aucun stockage) : la langue est recalculée à chaque visite. Plus de choix
// dans le pied de page : la langue suit le navigateur,
// sauf sur une page bilingue, où son adresse la donne (ci-dessus). `setLang` reste pour les tests
// (et un futur choix explicite).
const wanted = (typeof location === "undefined" ? null : langueDeLAdresse(location.pathname)) ?? detectLang();
let lang = $state<Lang>(dicts[wanted] !== undefined ? wanted : "fr");

function applyHtmlLang(l: Lang): void {
  if (typeof document !== "undefined") document.documentElement.lang = l;
}
// Langue voulue pas encore chargée (accueil anglais « /en ») : la page écrite au build porte déjà le
// bon lang ; ne pas le remettre à « fr » le temps du dictionnaire (le titre reprenait un instant sa
// taille française : décalage de l'accueil, et lecteurs d'écran dans la mauvaise langue).
if (lang === wanted) applyHtmlLang(lang);

export function getLang(): Lang {
  return lang;
}

/** Change de langue ; si elle n'est pas encore là, elle est lue d'abord (sinon : inchangée). */
export function setLang(l: Lang): Promise<void> {
  if (dicts[l] !== undefined) {
    lang = l;
    applyHtmlLang(l);
    return Promise.resolve();
  }
  return loadLang(l).then((ok) => {
    if (ok) setLang(l);
  });
}

/** Langue du navigateur prête (main.ts l'attend avant l'affichage : aucun texte ne change sous les yeux). */
// getLang() et non `lang` : lecture voulue de la valeur de départ, hors de toute dépendance réactive.
// Dictionnaire introuvable : on reste en français, et le lang de la page le dit.
export const langReady: Promise<void> = wanted === getLang() ? Promise.resolve() : setLang(wanted).then(() => applyHtmlLang(getLang()));

export function t(key: Key, params?: Record<string, string | number>): string {
  const d = dicts[lang] ?? fr;
  let k: string = key;
  if (typeof params?.n === "number" && Object.hasOwn(d, `${key}.${plural(lang, params.n)}`)) k = `${key}.${plural(lang, params.n)}`;
  if (!Object.hasOwn(d, k)) return key; // jamais « constructor », « __proto__ »…
  const raw = (d as Record<string, string>)[k]!;
  // Un seul passage : une valeur (nom de fichier) n'est jamais réinterprétée comme paramètre.
  return raw.replace(/\{(\w+)\}/g, (m, name: string) => (params && Object.hasOwn(params, name) ? String(params[name]) : m));
}
