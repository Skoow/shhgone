<script lang="ts">
  // Carte « Votre compte » (conception compte §11, §21.15.3 ; monté seulement avec
  // __COMPTES__) : ancienneté (« Membre »), palier et limites (du serveur, GET /api/compte),
  // abonnement, bannissement avec sa date et son motif. Les limites du palier confirmé
  // (3 salons, 10 places) sont celles du serveur (conception §11), rappelées ici pour un compte
  // récent, qui ne les reçoit pas encore.
  // Trois états : chargement (squelette), état reçu, ou erreur (`erreur`) avec « Réessayer ».
  // L'erreur est dite DANS la carte : avant le 25 novembre, elle partait dans un bandeau en haut
  // de page et la carte restait en squelette pour toujours (« comme en chargement »).
  // Abonnement (28 novembre ; bug : la carte disait toujours « Gratuit », elle lisait `profil.pass`,
  // que rien n'écrit) : lu comme la suppression du compte, dans le coffre privé et la base des pass
  // de l'appareil (abonnements()), lecture locale seulement : aucune requête ne relie le pass au
  // compte. Seule cette carte parle de l'abonnement dans l'espace compte (décision du propriétaire).
  // Gestion ici (28 novembre) : abonnement qui se renouvelle → « Arrêter l'abonnement », fenêtre
  // Oui / Non (un mois commencé est dû : rien n'est remboursé), puis arreterAbonnement (POST
  // /api/paiement/resilier avec le pass, sans session) ; la carte dit alors « ne sera pas
  // renouvelé ». Paiement unique, crypto, accès offert : pas de bouton. Échec : message, « Réessayer ».
  import { abonnements, account, arreterAbonnement, type Abonnement, type EtatServeur } from "../../account/session.svelte";
  import ConfirmDialog from "../../ui/ConfirmDialog.svelte";
  import { announce } from "../../ui/announce";
  import { followLink, href } from "../../app/router.svelte";
  import { getLang, t, type Key } from "../../i18n/i18n.svelte";
  import Banner from "../../ui/Banner.svelte";
  import Button from "../../ui/Button.svelte";
  import { jourLong } from "./erreurs";

  type Props = { etat: EtatServeur | null; erreur?: string; onretry?: () => void };
  let { etat, erreur = "", onretry }: Props = $props();

  // Relu quand le coffre privé change (ouverture de session, pass rangé) ; une lecture dépassée est ignorée.
  let offres = $state.raw<Abonnement[]>([]);
  let lecture = 0;
  function relire(): void {
    const n = ++lecture;
    abonnements()
      .then((l) => void (n === lecture && (offres = l)))
      .catch(() => undefined);
  }
  $effect(() => {
    void account.prive;
    relire();
  });
  let confirmer = $state(false);
  let arret = $state<"rien" | "encours" | "ok" | "erreur">("rien");
  async function arreter(): Promise<void> {
    const a = offre;
    if (!a) return;
    arret = "encours";
    const r = await arreterAbonnement(a.id).catch(() => "erreur" as const);
    arret = r;
    announce(t(r === "ok" ? "account.card.stop.done" : "account.card.stop.err"));
    if (r === "ok") relire();
  }
  const offre = $derived(offres[0]);
  /** Dernier jour valable (`fin` exclue) en toutes lettres. */
  const jusqua = (fin: string) => new Intl.DateTimeFormat(getLang(), { dateStyle: "long", timeZone: "UTC" }).format(new Date(Date.parse(fin + "T00:00:00Z") - 86_400_000));
  function libelle(a: Abonnement): string {
    const base = t(a.offre === "pro" ? "paid.badge.pro" : "paid.badge.plus");
    const nom = a.offert ? t("account.card.gift", { offre: base }) : base;
    const l = a.fin ? t("account.card.sub", { offre: nom, date: jusqua(a.fin) }) : t("account.card.sub.nodate", { offre: nom });
    return a.renouvelle ? `${l} · ${t("account.card.renew")}` : a.arrete ? `${l} · ${t("account.card.stopped")}` : l;
  }

  /** « 2026-11-14 » → « 14 novembre 2026 » (toujours avec l'année). */
  function jourAvecAnnee(iso: string): string {
    const d = new Date(`${iso}T00:00:00Z`);
    return Number.isNaN(d.getTime()) ? iso : new Intl.DateTimeFormat(getLang(), { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(d);
  }
</script>

<div class="carte" aria-busy={etat === null && !erreur ? "true" : undefined} data-carte-compte>
  <p class="titre">{t("account.card.title")}</p>
  {#if etat}
    <p>{t("account.card.since", { date: jourAvecAnnee(etat.creeLe) })}</p>
    <p class="val">
      {#if etat.palier === "neuf"}
        {t("account.card.neuf", { salons: etat.limites.salons, places: etat.limites.places, heures: etat.limites.heures, date: etat.confirmeLe ? jourLong(etat.confirmeLe) : "" })}
      {:else}
        {t("account.card.confirme", { salons: etat.limites.salons, places: etat.limites.places })}
      {/if}
    </p>
    {#if etat.banniJusqu}
      <Banner kind="warn">{t("account.banned", { date: jourLong(etat.banniJusqu), motif: t(`report.cat.${etat.banniMotif ?? 10}` as Key), id: etat.banniId ?? "" })}</Banner>
    {/if}
  {:else if erreur}
    <p class="err" role="alert" data-carte-erreur>{erreur}</p>
    {#if onretry}<div><Button variant="secondary" dense onpress={onretry}>{t("account.card.retry")}</Button></div>{/if}
  {:else}
    <p class="sq" aria-hidden="true"></p>
    <p class="sq court" aria-hidden="true"></p>
  {/if}
  <!-- Abonnement : coffre privé et appareil (lecture locale), jamais au serveur ; toujours montré. -->
  <p class="plan" data-carte-offre={offre ? offre.offre : "gratuit"}>
    <span class={{ offre: !!offre }} data-carte-offre-texte>{offre ? libelle(offre) : t("account.card.free")}</span>
    <a class="lien" href={href("/offres")} onclick={(e) => followLink(e, "/offres")}>{t("account.offers")}</a>
  </p>
  {#if offre?.renouvelle}
    <div class="arret">
      {#if arret === "erreur"}
        <p class="err" role="alert" data-carte-arret-erreur>{t("account.card.stop.err")}</p>
        <Button variant="secondary" dense onpress={arreter} data-carte-arret-reessayer>{t("account.card.stop.retry")}</Button>
      {:else}
        <Button variant="secondary" dense disabled={arret === "encours"} aria-haspopup="dialog" onpress={() => void (confirmer = true)} data-carte-arret>{t("account.card.stop")}</Button>
      {/if}
    </div>
  {:else if arret === "ok"}
    <p class="val" role="status" data-carte-arret-fait>{t("account.card.stop.done")}</p>
  {/if}
</div>

{#if offre}
  <ConfirmDialog bind:open={confirmer} title={t("account.card.stop.title")} yesLabel={t("account.card.stop.yes")} noLabel={t("account.card.stop.no")} danger onyes={arreter}>
    <p data-carte-arret-texte>
      {offre.fin
        ? t("account.card.stop.body", { offre: t(offre.offre === "pro" ? "paid.badge.pro" : "paid.badge.plus"), date: jusqua(offre.fin) })
        : t("account.card.stop.body.nodate", { offre: t(offre.offre === "pro" ? "paid.badge.pro" : "paid.badge.plus") })}
    </p>
  </ConfirmDialog>
{/if}

<style>
  .carte {
    display: grid;
    gap: var(--sp-2);
    padding: var(--sp-4);
    border-radius: var(--r-lg);
    background: var(--surface-1);
    box-shadow: inset 0 0 0 1px var(--hair);
    min-width: 0;
  }
  p {
    margin: 0;
  }
  .titre {
    font-weight: 600;
  }
  .val {
    color: var(--text-2);
    font-size: var(--fs-small);
    line-height: var(--lh-small);
  }
  .err {
    color: var(--danger);
    font-size: var(--fs-small);
  }
  .plan {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--sp-2) var(--sp-4);
  }
  .offre {
    font-weight: 600;
  }
  .arret {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--sp-2) var(--sp-3);
  }
  .sq {
    height: 1em;
    border-radius: 6px;
    background: var(--surface-2);
  }
  .sq.court {
    width: 60%;
  }
</style>
