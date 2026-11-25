<script lang="ts">
  // Page « /salon » : lien d'invitation « #c… » lu une fois puis retiré de la barre
  // (spec §5.3), mot de passe, page d'explication et pseudonyme, salon prêt (créateur),
  // conversation, fin. Aucun secret dans l'adresse ni dans le titre de l'onglet.
  import { onMount, untrack } from "svelte";
  import { t, getLang } from "../../i18n/i18n.svelte";
  import { formatDuration } from "../../i18n/format";
  import { navigate } from "../../app/router.svelte";
  import { lireFragment } from "../../salon/liens";
  import { vue, ouvrirInvitation, ouvrirGestion, detruireParGestion, oublierGestion, deverrouiller, oublier, reveiller, reprendreLaMain, detruireApresDelogement } from "../../salon/salon.svelte";
  import InlineConfirm from "../../ui/InlineConfirm.svelte";
  import Cadre from "../compte/Cadre.svelte";
  import TextField from "../../ui/TextField.svelte";
  import Button from "../../ui/Button.svelte";
  import Banner from "../../ui/Banner.svelte";
  import Pret from "./Pret.svelte";
  import Explication from "./Explication.svelte";
  import Conversation from "./Conversation.svelte";

  const lang = $derived(getLang());
  let mdp = $state("");
  let champ: HTMLInputElement | undefined = $state();
  const reste = $derived(Math.max(0, (vue.finMs - Date.now()) / 1000));

  /** Lien collé dans la barre (ou ouvert) : lu, puis retiré de l'adresse et de l'historique. */
  function lireLien(): void {
    const f = lireFragment(location.hash);
    if (location.hash !== "") history.replaceState(null, "", location.pathname);
    if (f?.sorte === "c") void ouvrirInvitation(f.cle).finally(() => f.cle.fill(0));
    else if (f?.sorte === "s") void ouvrirGestion(f.cle).finally(() => f.cle.fill(0));
  }

  onMount(() => {
    if (location.hash !== "") untrack(lireLien);
    const vis = () => {
      if (document.visibilityState === "visible") reveiller();
    };
    document.addEventListener("visibilitychange", vis);
    window.addEventListener("online", reveiller);
    return () => {
      document.removeEventListener("visibilitychange", vis);
      window.removeEventListener("online", reveiller);
    };
  });

  // Quitter la page pendant la conversation : le navigateur prévient (spec §39.1).
  $effect(() => {
    if (vue.etape !== "conversation" && vue.etape !== "explication" && vue.etape !== "pret") return;
    const garde = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", garde);
    return () => window.removeEventListener("beforeunload", garde);
  });
  // Page quittée (navigation interne) : tout est oublié.
  $effect(() => () => {
    oublier();
    oublierGestion();
  });

  async function continuer(): Promise<void> {
    if (mdp === "") {
      champ?.focus();
      return;
    }
    const ok = await deverrouiller(mdp);
    if (ok) mdp = "";
    else champ?.focus();
  }

  const erreur = $derived.by(() => {
    const e = vue.erreur;
    if (!e) return "";
    if (e.code === "bad_password") return t("salon.join.err.bad", { n: e.essais });
    return t(`salon.join.err.${e.code}`);
  });

  /** Créateur délogé : destruction depuis l'écran de fin (lien de gestion encore sur l'appareil). */
  let echecFin = $state(false);
  async function detruireFin(): Promise<void> {
    echecFin = !(await detruireApresDelogement()) && vue.detruireFin === "possible";
  }

  function fin(): string {
    const r = vue.fin ?? "introuvable";
    if (r === "remplace" && vue.createur) return t("salon.end.remplace.createur");
    return t(`salon.end.${r}`);
  }
</script>

<svelte:window onhashchange={lireLien} />

{#if vue.etape === "conversation"}
  <Conversation />
{:else if vue.etape === "explication"}
  <Explication />
{:else if vue.etape === "pret"}
  <Pret />
{:else if vue.etape === "motdepasse"}
  <Cadre titre={t("salon.join.title")} sous={t("salon.join.lede", { duree: formatDuration(reste, lang, { coarse: true }) })}>
    <div class="form">
      <TextField
        label={t("salon.join.password")}
        type="password"
        name="shh-unlock"
        autocomplete="one-time-code"
        autocapitalize="off"
        spellcheck={false}
        enterkeyhint="go"
        bind:value={mdp}
        bind:el={champ}
        error={erreur || undefined}
        onkeydown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void continuer();
          }
        }}
      />
      <div class="actions"><Button onpress={continuer}>{t("salon.join.go")}</Button></div>
      <p class="note">{t("salon.join.private")}</p>
    </div>
  </Cadre>
{:else if vue.etape === "fin"}
  <Cadre titre={t("salon.end.title")}>
    <p class="note" role="status">{fin()}</p>
    {#if vue.reprise}<div class="actions"><Button onpress={() => reprendreLaMain()}>{t("salon.end.reprendre")}</Button></div>{/if}
    {#if vue.reprise && vue.detruireFin === "possible"}
      <div class="actions">
        <InlineConfirm label={t("salon.gestion.detruire")} message={t("salon.gestion.detruire.confirm")} confirmLabel={t("salon.gestion.detruire")} kind="danger" triggerVariant="danger" onconfirm={detruireFin} />
      </div>
      {#if echecFin}<p class="note" role="alert">{t("salon.end.detruire.err")}</p>{/if}
    {:else if vue.reprise && vue.detruireFin === "lien"}
      <p class="note">{t("salon.end.detruire.sans")}</p>
    {/if}
    <div class="actions"><Button variant="secondary" onpress={() => navigate("/")}>{t("salon.end.home")}</Button></div>
  </Cadre>
{:else if vue.etape === "gestion" && vue.gestionSeule}
  <!-- Lien de gestion ouvert seul : il ne fait entrer personne (v3 §15.2, 32). -->
  <Cadre titre={t("salon.gestionseule.title")} sous={t("salon.gestionseule.sub", { n: vue.gestionSeule.present, duree: formatDuration(reste, lang, { coarse: true }) })}>
    <p class="note">{t("salon.gestionseule.entrer")}</p>
    <div class="actions">
      <InlineConfirm label={t("salon.gestion.detruire")} message={t("salon.gestion.detruire.confirm")} confirmLabel={t("salon.gestion.detruire")} kind="danger" triggerVariant="danger" onconfirm={async () => void (await detruireParGestion())} />
    </div>
  </Cadre>
{:else if vue.etape === "chargement"}
  <Cadre titre={t("salon.join.title")}><p class="note" aria-busy="true">…</p></Cadre>
{:else}
  <Cadre titre={vue.erreur ? t("salon.join.title") : t("salon.join.empty.title")}>
    {#if vue.erreur}
      <Banner kind="danger">{erreur}</Banner>
    {:else}
      <p class="note">{t("salon.join.empty.body")}</p>
    {/if}
    <div class="actions"><Button variant="secondary" onpress={() => navigate("/")}>{t("salon.end.home")}</Button></div>
  </Cadre>
{/if}

<style>
  .form {
    display: grid;
    gap: var(--sp-4);
  }
</style>
