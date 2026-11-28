<script lang="ts">
  // Supprimer le compte (conception compte §21.12, §21.15.4 point 12 ; suppression simplifiée). Monté seulement avec __COMPTES__, depuis
  // la page Compte. Avant de confirmer, l'écran dit ce qui sera supprimé (salons créés, compte),
  // honnêtement, ce qui ne peut pas être garanti (messages dans les salons d'autrui, partages en
  // cours qui s'effacent à leur échéance, ce que d'autres ont reçu, copies de sauvegarde) ; une offre
  // rangée dans le coffre (pass Plus ou Pro, accès offert : account/abonnements.ts) est annoncée
  // perdue pour le compte, avec sa date de fin, sans remboursement automatique, et un renouvellement
  // en cours n'est pas arrêté par la suppression (conception du paiement §5.5, §5.6 : le pass n'est
  // pas lié au compte côté serveur). Fenêtre de confirmation Oui / Non (26 novembre), puis geste de
  // passkey (session « récente », conception du compte par passkey §3.6), progression annoncée, puis la
  // fin : chaque passkey est signalée inconnue au gestionnaire là où c'est possible, et l'écran dit
  // de la supprimer aussi du gestionnaire.
  import { untrack } from "svelte";
  import { abonnements as abonnementsDuCompte, account, confirmerParPasskey, preparerReauth, supprimerTout, type Abonnement, type EtatServeur, type Progres } from "../../account/session.svelte";
  import { followLink, href, navigate } from "../../app/router.svelte";
  import { getLang, t } from "../../i18n/i18n.svelte";
  import ConfirmDialog from "../../ui/ConfirmDialog.svelte";
  import { announce } from "../../ui/announce";
  import Button from "../../ui/Button.svelte";
  import DestroyedArt from "../../ui/DestroyedArt.svelte";
  import Cadre from "./Cadre.svelte";
  import Case from "./Case.svelte";
  import { annulee, erreur } from "./erreurs";

  type Props = { etat: EtatServeur | null; onretour: () => void };
  let { etat, onretour }: Props = $props();
  let appareil = $state(true);
  let global = $state("");
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

  // Offres rangées dans le coffre privé : lecture locale (aucune requête).
  let abonnements = $state.raw<Abonnement[]>([]);
  $effect(() =>
    untrack(() => void abonnementsDuCompte().then((l) => (abonnements = l)).catch(() => undefined)),
  );
  /** Dernier jour valable (`fin` exclue) en toutes lettres. */
  const jusqua = (fin: string) => new Intl.DateTimeFormat(getLang(), { dateStyle: "long", timeZone: "UTC" }).format(new Date(Date.parse(fin + "T00:00:00Z") - 86_400_000));
  const nomOffre = (a: Abonnement) => t(a.offre === "pro" ? "paid.badge.pro" : "paid.badge.plus");
  const perte = (a: Abonnement) =>
    t(a.offert ? (a.fin ? "account.delete.sub.gift" : "account.delete.sub.gift.nodate") : a.fin ? "account.delete.sub.paid" : "account.delete.sub.paid.nodate", { offre: nomOffre(a), date: a.fin ? jusqua(a.fin) : "" });
  let confirmer = $state(false);

  const enCours = $derived(progres?.etape === "compte" ? t("account.delete.progressAccount") : "");

  async function supprimer() {
    global = "";
    try {
      await confirmerParPasskey();
    } catch (e) {
      preparerReauth().catch(() => undefined);
      return montrer(e);
    }
    try {
      for await (const p of supprimerTout({ effacerAppareil: appareil })) {
        if (p.etape === "fini") fini = p;
        else {
          progres = p;
          announce(t("account.delete.progressAccount"));
        }
      }
    } catch (e) {
      progres = null;
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
    {#if abonnements.length > 0}
      <div class="bloc" data-delete-subs>
        <h2>{t("account.delete.subs")}</h2>
        {#each abonnements as a, i (i)}
          {@render abonnement(a)}
        {/each}
      </div>
    {/if}

    <form novalidate onsubmit={(e) => e.preventDefault()}>
      <Case label={t("account.delete.device")} hint={t("account.delete.device.hint")} bind:checked={appareil} />
      <p class="note">{t("account.delete.gesture")}</p>
      {#if global}<p class="err" role="alert">{global}</p>{/if}
      {#if enCours}<p class="note" aria-busy="true">{enCours}</p>{/if}
      <div class="actions">
        <Button variant="danger" disabled={etat === null || progres !== null} aria-haspopup="dialog" onpress={() => void (confirmer = true)} data-delete-open>{t("account.delete.button")}</Button>
        <Button variant="ghost" onpress={onretour}>{t("account.delete.back")}</Button>
      </div>
    </form>
  </Cadre>
  <ConfirmDialog bind:open={confirmer} title={t("account.delete.confirm.title")} yesLabel={t("account.delete.yes")} noLabel={t("account.delete.no")} danger onyes={supprimer}>
    <p class="msg">{t("account.delete.confirm", { salons })}</p>
    {#each abonnements as a, i (i)}
      {@render abonnement(a)}
    {/each}
  </ConfirmDialog>
{/if}

{#snippet abonnement(a: Abonnement)}
  <div class="perte" data-delete-sub>
    <p class="warn">{perte(a)}</p>
    {#if !a.offert}<p class="note">{t("account.delete.sub.refund")}</p>{/if}
    {#if a.renouvelle}
      <p class="note">{t("account.delete.sub.renew.before")}<a href={href("/offres")} onclick={(e) => followLink(e, "/offres")}>{t("account.delete.sub.renew.link")}</a>{t("account.delete.sub.renew.after")}</p>
    {/if}
  </div>
{/snippet}

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
  .perte {
    display: grid;
    gap: var(--sp-1);
    padding: var(--sp-3);
    border-radius: var(--r-md, 12px);
    background: var(--warn-tint);
  }
  .perte a {
    color: var(--accent);
    text-underline-offset: 0.2em;
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
