<script lang="ts">
  // Supprimer le compte (conception compte §21.12, §21.15.4 point 12 ; décision du propriétaire du
  // 14 novembre, suppression simplifiée ; plan, lot 13). Monté seulement avec __COMPTES__, depuis
  // les paramètres. Avant de confirmer, l'écran dit ce qui sera supprimé (salons créés, partages
  // connus, compte) et, honnêtement, ce qui ne peut pas être garanti (messages dans les salons
  // d'autrui, partages oubliés qui s'effacent à leur échéance, ce que d'autres ont reçu, copies de
  // sauvegarde) ; un pass en cours est annoncé perdu. Geste de passkey (session « récente »,
  // conception du compte par passkey §3.6), confirmation sur place, progression annoncée, puis la
  // fin : chaque passkey est signalée inconnue au gestionnaire là où c'est possible, et l'écran dit
  // de la supprimer aussi du gestionnaire.
  import { untrack } from "svelte";
  import { account, confirmerParPasskey, partagesASupprimer, preparerReauth, supprimerTout, type EtatServeur, type Progres } from "../../account/session.svelte";
  import { navigate } from "../../app/router.svelte";
  import { t } from "../../i18n/i18n.svelte";
  import { announce } from "../../ui/announce";
  import Button from "../../ui/Button.svelte";
  import DestroyedArt from "../../ui/DestroyedArt.svelte";
  import InlineConfirm from "../../ui/InlineConfirm.svelte";
  import Cadre from "./Cadre.svelte";
  import Case from "./Case.svelte";
  import { annulee, erreur } from "./erreurs";

  type Props = { etat: EtatServeur | null; onretour: () => void };
  let { etat, onretour }: Props = $props();
  let partages = $state<number | null>(null);
  let appareil = $state(true);
  let global = $state("");
  let progres = $state.raw<Progres | null>(null);
  let fini = $state.raw<Extract<Progres, { etape: "fini" }> | null>(null);
  const pass = account.profil?.pass ?? null;
  const pseudo = account.profil?.pseudo ?? "";
  const salons = $derived(etat?.salonsActifs ?? 0);

  $effect(() =>
    untrack(() => {
      preparerReauth().catch(() => undefined);
      partagesASupprimer().then(
        (n) => (partages = n),
        () => (partages = 0),
      );
      // Cérémonie rechargée avant son échéance (5 min au serveur) : le geste n'attend jamais de requête.
      const m = setInterval(() => preparerReauth().catch(() => undefined), 240_000);
      return () => clearInterval(m);
    }),
  );

  const enCours = $derived(progres?.etape === "partages" ? t("account.delete.progress", { fait: progres.fait, total: progres.total }) : progres?.etape === "compte" ? t("account.delete.progressAccount") : "");

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
          announce(p.etape === "partages" ? t("account.delete.progress", { fait: p.fait, total: p.total }) : t("account.delete.progressAccount"));
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
    {#if fini.partagesEchoues > 0}<p class="note">{t("account.delete.failed", { n: fini.partagesEchoues })}</p>{/if}
    <div class="actions"><Button onpress={() => navigate("/")}>{t("account.delete.home")}</Button></div>
  </Cadre>
{:else}
  <Cadre titre={t("account.delete.title")}>
    <div class="bloc">
      <h2>{t("account.delete.gone")}</h2>
      <ul>
        <li>{t("account.delete.salons", { n: salons })}</li>
        <li>{t("account.delete.shares", { n: partages ?? "…" })}</li>
        <li>{t("account.delete.account")}</li>
      </ul>
    </div>
    <div class="bloc">
      <h2>{t("account.delete.stays")}</h2>
      <ul>
        <li>{t("account.delete.stays.messages")}</li>
        <li>{t("account.delete.stays.unknown")}</li>
        <li>{t("account.delete.stays.received")}</li>
        <li>{t("account.delete.stays.kept")}</li>
      </ul>
      {#if pass}<p class="warn">{t("account.delete.pass")}</p>{/if}
    </div>

    <form novalidate onsubmit={(e) => e.preventDefault()}>
      <Case label={t("account.delete.device")} hint={t("account.delete.device.hint")} bind:checked={appareil} />
      <p class="note">{t("account.delete.gesture")}</p>
      {#if global}<p class="err" role="alert">{global}</p>{/if}
      {#if enCours}<p class="note" aria-busy="true">{enCours}</p>{/if}
      <div class="actions">
        <InlineConfirm
          label={t("account.delete.button")}
          message={t("account.delete.confirm", { salons, partages: partages ?? 0 })}
          confirmLabel={t("account.delete.yes")}
          kind="danger"
          triggerVariant="danger"
          disabled={etat === null || progres !== null}
          onconfirm={supprimer}
        />
        <Button variant="ghost" onpress={onretour}>{t("account.delete.back")}</Button>
      </div>
    </form>
  </Cadre>
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
