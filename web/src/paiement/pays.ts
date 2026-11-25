// Pays de résidence proposé d'avance sur la page Offres (« sans avoir
// besoin de l'écrire »). Deviné SUR L'APPAREIL d'après le fuseau horaire du système, puis la
// région de la langue du navigateur ; aucune requête, aucune adresse IP, rien n'est gardé. Ce
// n'est qu'une valeur de départ : la personne la voit et la change si besoin (pays déclaré, §9.1).
// Fuseaux des 27 États membres, métropole seulement (les régions ultrapériphériques ont une autre
// TVA, ou aucune : rien n'y est proposé d'avance).
const FUSEAUX: Readonly<Record<string, string>> = {
  "Europe/Vienna": "AT",
  "Europe/Brussels": "BE",
  "Europe/Sofia": "BG",
  "Asia/Nicosia": "CY",
  "Asia/Famagusta": "CY",
  "Europe/Nicosia": "CY",
  "Europe/Prague": "CZ",
  "Europe/Berlin": "DE",
  "Europe/Copenhagen": "DK",
  "Europe/Tallinn": "EE",
  "Europe/Madrid": "ES",
  "Europe/Helsinki": "FI",
  "Europe/Paris": "FR",
  "Europe/Athens": "GR",
  "Europe/Zagreb": "HR",
  "Europe/Budapest": "HU",
  "Europe/Dublin": "IE",
  "Europe/Rome": "IT",
  "Europe/Vilnius": "LT",
  "Europe/Luxembourg": "LU",
  "Europe/Riga": "LV",
  "Europe/Malta": "MT",
  "Europe/Amsterdam": "NL",
  "Europe/Warsaw": "PL",
  "Europe/Lisbon": "PT",
  "Europe/Bucharest": "RO",
  "Europe/Stockholm": "SE",
  "Europe/Ljubljana": "SI",
  "Europe/Bratislava": "SK",
};

/**
 * Pays proposé d'avance, s'il fait partie de `permis` (les pays où CE serveur vend), sinon "".
 * `fuseau` et `langues` sont lus du navigateur par défaut (paramètres pour les tests).
 */
export function paysProbable(permis: readonly string[], fuseau?: string, langues?: readonly string[]): string {
  let tz = fuseau;
  if (tz === undefined) {
    try {
      tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch {
      tz = "";
    }
  }
  const parTz = FUSEAUX[tz ?? ""];
  if (parTz && permis.includes(parTz)) return parTz;
  const ls = langues ?? (typeof navigator !== "undefined" ? navigator.languages ?? [navigator.language] : []);
  for (const l of ls) {
    let r: string | undefined;
    try {
      r = new Intl.Locale(l).region;
    } catch {
      r = undefined;
    }
    if (r && permis.includes(r)) return r;
  }
  return "";
}
