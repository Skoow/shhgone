// Note de vente faite sur l'appareil, après un paiement reçu (conception du paiement §9.3, S4).
// Rien ne part au serveur : la note est assemblée ici, à partir du pass gardé sur cet appareil
// (offre, durée, moyen, pays déclaré, date de commande), de l'état du pass (fin de la période)
// et du régime de TVA publié par le serveur (GET /api/paiement, aucun secret). Le serveur ne
// garde ni identité, ni montant, ni pays, et n'apprend pas qu'une note a été faite.
//
// Mentions du vendeur qui dépendent (nom, adresse, SIREN, numéro de TVA,
// numéro de la série continue) : « [À COMPLÉTER] » tant qu'il ne les a pas fournies (conception
// §13). Limite écrite : une série de numéros continue exige un registre tenu par le vendeur ;
// la note porte une référence unique tirée sur l'appareil, pas un numéro de cette série.
//
// Document HTML autonome : aucune ressource externe, aucun script, toutes les valeurs échappées,
// en français (langue des mentions légales), imprimable en PDF depuis le navigateur. Pas de CSP
// dans le fichier : la règle de check-dist (aucune balise CSP dans un build de production, trace
// de la démo) l'interdit ; rien dans la note n'en a besoin (aucun code, aucune adresse).
import { PAID } from "../limits";
import type { Moyen, OffrePayante, Tva } from "./api";

/** Mentions du vendeur fournies par (conception §13) ; « [À COMPLÉTER] » sinon. */
export const VENDEUR = {
  nom: "[À COMPLÉTER : nom ou dénomination du vendeur]",
  adresse: "[À COMPLÉTER : adresse du vendeur]",
  siren: "[À COMPLÉTER : SIREN]",
  tva: "[À COMPLÉTER : numéro de TVA intracommunautaire]",
  numero: "[À COMPLÉTER : numéro de la série continue des factures du vendeur]",
} as const;

export type NoteDonnees = {
  /** Identifiant de l'enregistrement du pass sur l'appareil (aléatoire, sans lien avec le pass). */
  id: string;
  offre: OffrePayante;
  jours: 30 | 365;
  renouvelle: boolean;
  moyen: Moyen;
  /** Pays déclaré à la commande ; absent pour un pass d'un ancien enregistrement. */
  pays?: string;
  /** Date de la commande (millisecondes). */
  cree: number;
  /** Dernier jour du pass, exclu (AAAA-MM-JJ, UTC), donné par le serveur. */
  fin: string;
  tva: Tva;
  /** Date de la note (millisecondes). */
  maintenant: number;
};

/** Prix TTC en centimes : celui de la page Offres (le serveur facture le même, offres.go). */
export function prixTTC(offre: OffrePayante, jours: 30 | 365): number {
  return (jours === 30 ? PAID[offre].month : PAID[offre].year) * 100;
}

/**
 * HT = arrondi au plus proche (moitié vers le haut) de TTC × 10 000 / (10 000 + taux), TVA =
 * TTC − HT : la règle du serveur (tva.go, Ventiler), en entiers. Taux en points de base.
 */
export function ventiler(ttc: number, taux: number): { ht: number; tva: number } {
  const d = 10000 + taux;
  const ht = Math.floor((ttc * 10000 * 2 + d) / (2 * d));
  return { ht, tva: ttc - ht };
}

const eur = (c: number) => `${Math.floor(c / 100)},${String(c % 100).padStart(2, "0")} €`;
const jour = (ms: number) => new Intl.DateTimeFormat("fr-FR", { dateStyle: "long", timeZone: "UTC" }).format(new Date(ms));
const taux = (bp: number) => `${(bp / 100).toLocaleString("fr-FR", { maximumFractionDigits: 2 })} %`;
const echapper = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const NOMS: Record<OffrePayante, string> = { plus: "Shhgone Plus", pro: "Shhgone Pro" };
const MOYENS: Record<Moyen, string> = { carte: "carte bancaire (Stripe)", paypal: "PayPal", crypto: "cryptomonnaie (NOWPayments)" };
const JOUR_MS = 86400000;

/** Référence unique de la note, tirée sur l'appareil (pas un numéro de la série continue). */
export const reference = (d: Pick<NoteDonnees, "id" | "cree">) =>
  `SG-${new Date(d.cree).toISOString().slice(0, 10).replaceAll("-", "")}-${d.id.replace(/[^A-Za-z0-9]/g, "").slice(0, 10).toUpperCase()}`;

/** Nom du fichier téléchargé. */
export const nomFichier = (d: Pick<NoteDonnees, "maintenant">) => `note-de-vente-shhgone-${new Date(d.maintenant).toISOString().slice(0, 10)}.html`;

/** Lignes de la note (texte, sans HTML) : testées telles quelles, puis mises en page. */
export function lignes(d: NoteDonnees): { titre: string; vendeur: string[]; vente: [string, string][]; mentions: string[] } {
  const ttc = prixTTC(d.offre, d.jours);
  const finMs = Date.parse(d.fin + "T00:00:00Z");
  const debutMs = finMs - d.jours * JOUR_MS;
  const bp = d.tva.regime === "franchise" ? 0 : d.pays !== undefined ? d.tva.taux[d.pays] : d.tva.regime === "france" ? d.tva.taux.FR : undefined;
  const v = bp === undefined ? null : ventiler(ttc, bp);
  const vente: [string, string][] = [
    ["Numéro", VENDEUR.numero],
    ["Référence", reference(d)],
    ["Date de la note", jour(d.maintenant)],
    ["Date de la commande", jour(d.cree)],
    ["Client", "particulier ; Shhgone ne recueille pas son identité (nom porté à sa demande seulement)"],
    ["Désignation", `${NOMS[d.offre]}, ${d.jours} jours${d.renouvelle ? (d.jours === 30 ? ", renouvelé chaque mois" : ", renouvelé chaque année") : ""}`],
    ["Période", `du ${jour(debutMs)} au ${jour(finMs - JOUR_MS)} inclus`],
    ["Quantité", "1"],
    ["Moyen de paiement", MOYENS[d.moyen]],
    ["Pays déclaré", d.pays ?? "[non connu sur cet appareil]"],
  ];
  if (d.tva.regime === "franchise") {
    vente.push(["Prix HT", eur(ttc)], ["TVA", "0,00 €"], ["Total TTC", eur(ttc)]);
  } else if (v === null || bp === undefined) {
    vente.push(["Prix HT", "[À COMPLÉTER : selon le pays du client]"], ["TVA", "[À COMPLÉTER : taux du pays du client]"], ["Total TTC", eur(ttc)]);
  } else {
    vente.push(["Prix unitaire HT", eur(v.ht)], [`TVA (${taux(bp)})`, eur(v.tva)], ["Total TTC", eur(ttc)]);
  }
  const mentions = [
    d.tva.regime === "franchise"
      ? "TVA non applicable, art. 293 B du CGI."
      : d.tva.regime === "oss"
        ? "TVA du pays du client (guichet unique OSS)."
        : "TVA française.",
    "Paiement reçu : rien ne reste dû.",
    d.renouvelle ? "Chaque renouvellement est une nouvelle vente ; cette note ne porte que sur la période indiquée." : "Sans renouvellement automatique.",
    "Note établie sur l'appareil du client à partir de sa commande ; le vendeur tient son propre registre des ventes.",
  ];
  const vendeur = [VENDEUR.nom, VENDEUR.adresse, `SIREN : ${VENDEUR.siren}`, ...(d.tva.regime === "franchise" ? [] : [`TVA intracommunautaire : ${VENDEUR.tva}`])];
  return { titre: "Note de vente", vendeur, vente, mentions };
}

/** Document HTML autonome (aucune ressource externe, aucun script). */
export function noteHtml(d: NoteDonnees): string {
  const l = lignes(d);
  const lignesVente = l.vente.map(([k, v]) => `<tr><th scope="row">${echapper(k)}</th><td>${echapper(v)}</td></tr>`).join("\n");
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${echapper(l.titre)} ${echapper(reference(d))}</title>
<style>
body { font: 15px/1.5 system-ui, sans-serif; color: #111; background: #fff; max-width: 42rem; margin: 2rem auto; padding: 0 1rem; }
h1 { font-size: 1.4rem; margin: 0 0 1rem; }
table { border-collapse: collapse; width: 100%; margin: 1rem 0; }
th, td { text-align: left; vertical-align: top; padding: .35rem .5rem; border-bottom: 1px solid #ddd; }
th { width: 40%; font-weight: 600; }
.vendeur { margin: 0; }
ul { padding-left: 1.2rem; }
</style>
</head>
<body>
<h1>${echapper(l.titre)}</h1>
<p class="vendeur">${l.vendeur.map(echapper).join("<br>")}</p>
<table>
${lignesVente}
</table>
<ul>
${l.mentions.map((m) => `<li>${echapper(m)}</li>`).join("\n")}
</ul>
</body>
</html>
`;
}

/** Téléchargement sur l'appareil (lien <a download> sur un Blob, révoqué après une minute). */
export function telechargerNote(d: NoteDonnees): void {
  const url = URL.createObjectURL(new Blob([noteHtml(d)], { type: "text/html;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = nomFichier(d);
  a.rel = "noopener";
  a.hidden = true;
  document.body.append(a);
  try {
    a.click();
  } finally {
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}
