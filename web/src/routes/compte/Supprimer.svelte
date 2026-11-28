<script lang="ts">
  // Supprimer le compte (conception compte §21.12, §21.15.4 point 12 ; suppression simplifiée). Monté seulement avec __COMPTES__, depuis
  // la page Compte. Avant de confirmer, l'écran dit ce qui sera supprimé (salons créés, compte, et
  // l'abonnement s'il y en a un), honnêtement, ce qui ne peut pas être garanti (messages dans les
  // salons d'autrui, partages en cours qui s'effacent à leur échéance, ce que d'autres ont reçu,
  // copies de sauvegarde). Décision du propriétaire du 28 novembre : supprimer le compte supprime
  // TOUJOURS l'abonnement aussi (pass Plus ou Pro, accès offert, trouvé dans le coffre privé ou sur
  // l'appareil : account/abonnements.ts), et efface toutes les données du site sur cet appareil
  // (plus de case : l'appareil revient à zéro, Mes partages créés sans compte compris). Fenêtre Oui / Non : « Êtes-vous sûr ? », et avec un abonnement « Vous allez perdre
  // votre abonnement {offre}, valable jusqu'au {date} » (rien n'est remboursé automatiquement : les
  // remboursements se font à la main, conception du paiement §5.5). Puis geste de passkey (session
  // « récente », conception du compte par passkey §3.6), et suppression.ts : renouvellement arrêté,
  // pass révoqué, compte supprimé, pass effacé. Abonnement impossible à arrêter (réseau) : rien
  // n'est supprimé, le message le dit, « Réessayer » reprend sans nouveau geste. Fin : chaque
  // passkey est signalée inconnue au gestionnaire là où c'est possible, et l'écran dit de la
  // supprimer aussi du gestionnaire.
  import { untrack } from "svelte";
  import { abonnements as abonnementsDuCompte, account, confirmerParPasskey, ErreurAbonnement, preparerReauth, supprimerTout, type Abonnement, type EtatServeur, type Progres } from "../../account/session.svelte";
  import { navigate } from "../../app/router.svelte";
  import { getLang, t } from "../../i18n/i18n.svelte";
  import ConfirmDialog from "../../ui/ConfirmDialog.svelte";
  import { announce } from "../../ui/announce";
  import Button from "../../ui/Button.svelte";
  import DestroyedArt from "../../ui/DestroyedArt.svelte";
  import Cadre from "./Cadre.svelte";
  import { annulee, erreur } from "./erreurs";

  type Props = { etat: EtatServeur | null; onretour: () => void };
  let { etat, onretour }: Props = $props();
  let global = $state("");
  /** L'abonnement n'a pas pu être arrêté : « Réessayer » reprend sans nouveau geste. */
  let reessayer = $state(false);
  let progres = $state.raw<Progres | null>(null);
  let fini = $state.raw<Extract<Progres, { etape: "fini" }> | null>(null);
  const pseudo = account.profil?.pseudo ?? "";
  const salons = $derived(etat?.salonsActifs ?? 0);

  $effect(() =>
    untrack(() => {
      preparerReauth().catch(() => undefined);
      // Cérémonie rechargée avant son échéance (5 min au serveur) : le geste n'attend jamais de requête.
      const m = setInterval(() => preparerReauth().catch(() => undefined), 240_000);
      return () => clearInterval(m);
    }),
  );

  // Offres du compte (coffre privé et appareil) : lecture locale (aucune requête).
  let abonnements = $state.raw<Abonnement[]>([]);
  $effect(() =>
    untrack(() => void abonnementsDuCompte().then((l) => (abonnements = l)).catch(() => undefined)),
  );
  /** Dernier jour valable (`fin` exclue) en toutes lettres. */
  const jusqua = (fin: string) => new Intl.DateTimeFormat(getLang(), { dateStyle: "long", timeZone: "UTC" }).format(new Date(Date.parse(fin + "T00:00:00Z") - 86_400_000));
  const nomOffre = (a: Abonnement) => t(a.offre === "pro" ? "paid.badge.pro" : "paid.badge.plus");
  const perte = (a: Abonnement) =>
    t(a.offert ? (a.fin ? "account.delete.sub.lose.gift" : "account.delete.sub.lose.gift.nodate") : a.fin ? "account.delete.sub.lose" : "account.delete.sub.lose.nodate", { offre: nomOffre(a), date: a.fin ? jusqua(a.fin) : "" });
  let confirmer = $state(false);

  const enCours = $derived(progres?.etape === "abonnement" ? t("account.delete.progressSub") : progres?.etape === "compte" ? t("account.delete.progressAccount") : "");

  async function supprimer() {
    global = "";
    reessayer = false;
    try {
      await confirmerParPasskey();
    } catch (e) {
      preparerReauth().catch(() => undefined);
      return montrer(e);
    }
    await suite();
  }
  /** Après le geste : abonnement arrêté, puis compte supprimé (suppression.ts). */
  async function suite() {
    global = "";
    reessayer = false;
    try {
      for await (const p of supprimerTout()) {
        if (p.etape === "fini") fini = p;
        else {
          progres = p;
          announce(p.etape === "abonnement" ? t("account.delete.progressSub") : t("account.delete.progressAccount"));
        }
      }
    } catch (e) {
      progres = null;
      if (e instanceof ErreurAbonnement) {
        reessayer = true;
        global = t("account.delete.sub.error");
        announce(global);
        return;
      }
      return montrer(e);
    }
    progres = null;
    announce(t("account.delete.done"));
  }
  function montrer(e: unknown) {
    if (annulee(e)) return;
    global = erreur(e, "parametres").texte;
    announce(global);
  }
</script>

{#if fini}
  <Cadre titre={t("account.delete.done")}>
    <div class="art"><DestroyedArt /></div>
    <p class="note" data-passkey-gestionnaire>{t("account.delete.passkey", { pseudo })}</p>
    <div class="actions"><Button onpress={() => navigate("/")}>{t("account.delete.home")}</Button></div>
  </Cadre>
{:else}
  <Cadre titre={t("account.delete.title")}>
    <div class="bloc">
      <h2>{t("account.delete.gone")}</h2>
      <ul>
        <li>{t("account.delete.salons", { n: salons })}</li>
        <li>{t("account.delete.account")}</li>
        <li>{t("account.delete.device.all")}</li>
        {#each abonnements as a, i (i)}
          <li data-delete-sub-item>{t("account.delete.sub.item", { offre: nomOffre(a) })}</li>
        {/each}
      </ul>
    </div>
    <div class="bloc">
      <h2>{t("account.delete.stays")}</h2>
      <ul>
        <li>{t("account.delete.stays.messages")}</li>
        <li>{t("account.delete.stays.shares")}</li>
        <li>{t("account.delete.stays.received")}</li>
        <li>{t("account.delete.stays.kept")}</li>
      </ul>
    </div>

    <form novalidate onsubmit={(e) => e.preventDefault()}>
      <p class="note">{t("account.delete.gesture")}</p>
      {#if global}<p class="err" role="alert" data-delete-error>{global}</p>{/if}
      {#if enCours}<p class="note" aria-busy="true">{enCours}</p>{/if}
      <div class="actions">
        {#if reessayer}
          <Button variant="danger" disabled={progres !== null} onpress={suite} data-delete-retry>{t("account.delete.retry")}</Button>
        {:else}
          <Button variant="danger" disabled={etat === null || progres !== null} aria-haspopup="dialog" onpress={() => void (confirmer = true)} data-delete-open>{t("account.delete.button")}</Button>
        {/if}
        <Button variant="ghost" onpress={onretour}>{t("account.delete.back")}</Button>
      </div>
    </form>
  </Cadre>
  <ConfirmDialog bind:open={confirmer} title={t("account.delete.confirm.title")} yesLabel={t("account.delete.yes")} noLabel={t("account.delete.no")} danger onyes={supprimer}>
    <p class="msg sur">{t("account.delete.sure")}</p>
    {#each abonnements as a, i (i)}
      <div class="perte" data-delete-sub>
        <p class="warn">{perte(a)}</p>
        {#if a.renouvelle}<p class="note">{t("account.delete.sub.renew")}</p>{/if}
        {#if !a.offert}<p class="note">{t("account.delete.sub.refund")}</p>{/if}
      </div>
    {/each}
    <p class="msg">{t("account.delete.confirm", { salons })}</p>
    <p class="msg" data-delete-device>{t("account.delete.device.all")}</p>
  </ConfirmDialog>
{/if}

<style>
  .bloc {
    display: grid;
    gap: var(--sp-2);
  }
  h2 {
    margin: 0;
    font-size: var(--fs-h3);
  }
  ul {
    margin: 0;
    padding-left: 1.2em;
    display: grid;
    gap: var(--sp-2);
    color: var(--text-2);
  }
  .warn {
    margin: 0;
    color: var(--warn);
    font-weight: 600;
  }
  .msg,
  .perte .note {
    margin: 0;
  }
  .sur {
    font-weight: 600;
  }
  .perte {
    display: grid;
    gap: var(--sp-1);
    padding: var(--sp-3);
    border-radius: var(--r-md, 12px);
    background: var(--warn-tint);
  }
  .err {
    margin: 0;
    color: var(--danger);
  }
  .art {
    width: min(100%, 220px);
    margin-inline: auto;
  }
</style>
