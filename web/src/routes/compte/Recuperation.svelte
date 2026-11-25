<script lang="ts">
  // Récupération par la clé (/compte/recuperation ; conception du compte par passkey §3.3 c,
  // §3.4, §5.4). Page montée seulement si __COMPTES__ (App.svelte).
  // 1. La clé (collage permis ; contrôle sur l'appareil avant tout envoi : « Clé mal recopiée »),
  //    « Rester connecté » ; seul A_r part (route recup) : jamais la clé.
  // 2. « Créez une passkey sur cet appareil » : la cérémonie d'ajout est chargée dès la session
  //    ouverte (récente), le clic appelle navigator.credentials.create sans requête avant.
  //    « Plus tard » reste possible (la personne a peut-être ses passkeys sur un autre appareil).
  import { tick } from "svelte";
  import { account, ajouterPasskey, deuxiemeGesteAjout, ouvrirAvecCle, passkeysDisponibles, preparerAjout } from "../../account/session.svelte";
  import { navigate, suite } from "../../app/router.svelte";
  import { t } from "../../i18n/i18n.svelte";
  import { announce } from "../../ui/announce";
  import Banner from "../../ui/Banner.svelte";
  import Button from "../../ui/Button.svelte";
  import TextField from "../../ui/TextField.svelte";
  import Cadre from "./Cadre.svelte";
  import Case from "./Case.svelte";
  import { annulee, erreur } from "./erreurs";

  const apres = suite(location.search);
  const dispo = passkeysDisponibles();

  let vue = $state<"cle" | "passkey" | "second" | "fini">(account.etat === "ouvert" ? "fini" : "cle");
  let cle = $state("");
  let errCle = $state("");
  let rester = $state(false);
  let bandeau = $state("");
  let envoi = $state(false);
  let pret = $state(false);
  let ajoutee = $state(false);
  let elCle: HTMLInputElement | undefined = $state();

  async function ouvrir() {
    errCle = "";
    bandeau = "";
    envoi = true;
    try {
      await ouvrirAvecCle(cle, rester);
    } catch (e) {
      const x = erreur(e, "cle");
      if (x.champ === "cle") {
        errCle = x.texte;
        await tick();
        elCle?.focus();
      } else bandeau = x.texte;
      return;
    } finally {
      envoi = false;
    }
    cle = "";
    announce(t("account.connected"));
    if (!dispo) return void (vue = "fini");
    vue = "passkey";
    pret = (await preparerAjout().catch(() => "echec")) === "pret";
  }

  // Le geste : aucune requête avant navigator.credentials.create.
  async function creer() {
    bandeau = "";
    try {
      const r = await ajouterPasskey("");
      if (r === "second") return void (vue = "second");
      ajoutee = true;
      vue = "fini";
      announce(t("account.passkeys.added"));
    } catch (e) {
      if (!annulee(e)) bandeau = erreur(e, "parametres").texte;
      pret = (await preparerAjout().catch(() => "echec")) === "pret";
    }
  }
  async function second() {
    try {
      await deuxiemeGesteAjout();
    } catch (e) {
      bandeau = erreur(e, "parametres").texte;
      return;
    }
    ajoutee = true;
    vue = "fini";
    announce(t("account.passkeys.added"));
  }
  const continuer = () => navigate(apres === "salon" && __SALONS__ ? "/salon/nouveau" : "/");
</script>

<Cadre forme="panneaux" titre={vue === "cle" ? t("account.recover.title") : vue === "fini" ? t("account.connected.title") : t("account.recover.passkey.title")} sous={vue === "cle" ? t("account.recover.sub") : undefined}>
  {#if bandeau}<Banner kind="danger">{bandeau}</Banner>{/if}

  {#if vue === "cle"}
    <form novalidate onsubmit={(e) => e.preventDefault()}>
      <TextField label={t("account.key.field")} hint={t("account.key.field.hint")} autocomplete="off" autocapitalize="characters" spellcheck="false" error={errCle || undefined} bind:value={cle} bind:el={elCle} oninput={() => (errCle = "")} />
      <Case label={t("account.stay")} bind:checked={rester} />
      <Button type="submit" onpress={ouvrir}>{envoi ? t("account.verifying") : t("account.key.open")}</Button>
    </form>
  {:else if vue === "passkey"}
    <p class="note">{t("account.recover.passkey.body")}</p>
    <div class="actions">
      <Button busy={!pret} disabled={!pret} onpress={creer}>{t("account.passkeys.create")}</Button>
      <Button variant="ghost" onpress={() => void (vue = "fini")}>{t("account.later")}</Button>
    </div>
  {:else if vue === "second"}
    <p class="note">{t("account.second.body")}</p>
    <div class="actions"><Button onpress={second}>{t("account.second.go")}</Button></div>
  {:else}
    {#if ajoutee}<p class="note" role="status">{t("account.passkeys.added")}</p>{/if}
    {#if account.recupere}<p class="note" data-recupere>{t("account.recovered.banner")}</p>{/if}
    <div class="actions"><Button onpress={continuer}>{t("account.continue")}</Button></div>
  {/if}
</Cadre>
