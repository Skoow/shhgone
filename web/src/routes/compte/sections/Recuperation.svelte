<script lang="ts">
  // Clé de récupération (conception du compte par passkey §3.4, §3.5, Q10 ; monté seulement avec
  // __COMPTES__) : ce qu'elle permet, et « Créer une nouvelle clé » : nouvelle clé tirée sur
  // l'appareil, montrée une fois, un groupe retapé, puis seuls v_r et l'enveloppe partent (session
  // récente, sinon « Confirmer avec une passkey » d'abord) ; l'ancienne clé ne sert plus.
  // Après un usage de la clé, un bandeau le propose jusqu'à ce que ce soit fait.
  // « Vérifier ma clé » (rappel des 6 mois, 28 novembre) : la clé retapée est vérifiée sur
  // l'appareil (verifierCle : l'enveloppe du compte ouverte par elle), jamais envoyée ; rappel dû :
  // bandeau, et « Vous ne l'avez plus ? » mène à « Créer une nouvelle clé ».
  import { tick } from "svelte";
  import { account, confirmerParPasskey, enregistrerNouvelleCle, preparerNouvelleCle, preparerReauth, rappelCle, verifierCle } from "../../../account/session.svelte";
  import { t } from "../../../i18n/i18n.svelte";
  import { announce } from "../../../ui/announce";
  import Banner from "../../../ui/Banner.svelte";
  import Button from "../../../ui/Button.svelte";
  import CleRecup from "../CleRecup.svelte";
  import { annulee, codeDe, erreur } from "../erreurs";
  import TextField from "../../../ui/TextField.svelte";
  import VerifCle from "../VerifCle.svelte";
  import Section from "./Section.svelte";

  let vue = $state<"ferme" | "cle" | "verif" | "recent" | "fini" | "controle" | "controlee">("ferme");
  let saisie = $state("");
  let errSaisie = $state("");
  let envoi = $state(false);
  let elSaisie: HTMLInputElement | undefined = $state();

  async function controler() {
    global = errSaisie = "";
    saisie = "";
    vue = "controle";
    await tick();
    elSaisie?.focus();
  }
  async function verifier() {
    if (envoi) return;
    errSaisie = "";
    envoi = true;
    try {
      if (await verifierCle(saisie)) {
        saisie = "";
        vue = "controlee";
        announce(t("account.recovery.check.ok"));
      } else errSaisie = t("account.recovery.check.ko");
    } catch (e) {
      const x = erreur(e, "parametres");
      if (x.champ === "cle") errSaisie = x.texte;
      else global = x.texte;
    } finally {
      envoi = false;
    }
    if (errSaisie) {
      await tick();
      elSaisie?.focus();
    }
  }
  let texte = $state("");
  /** Clé copiée ou téléchargée (CleRecup) : « Revoir la clé » ne le perd pas. */
  let sauvee = $state(false);
  let global = $state("");

  async function commencer() {
    global = "";
    texte = await preparerNouvelleCle();
    sauvee = false;
    vue = "cle";
    preparerReauth().catch(() => undefined);
  }
  async function enregistrer() {
    global = "";
    try {
      await enregistrerNouvelleCle();
    } catch (e) {
      if (codeDe(e) === "recent") return void (vue = "recent");
      global = erreur(e, "parametres").texte;
      return;
    }
    texte = "";
    vue = "fini";
    announce(t("account.recovery.done"));
  }
  async function confirmer() {
    global = "";
    try {
      await confirmerParPasskey();
    } catch (e) {
      if (!annulee(e)) global = erreur(e, "parametres").texte;
      preparerReauth().catch(() => undefined);
      return;
    }
    await enregistrer();
  }
</script>

<Section id="sec-recovery" titre={t("account.section.recovery")}>
  {#if account.recupere && vue !== "fini"}<Banner kind="warn">{t("account.recovered.banner")}</Banner>{/if}
  {#if rappelCle() && vue !== "controlee" && vue !== "fini"}<div data-rappel-cle><Banner kind="warn">{t("account.recovery.reminder")}</Banner></div>{/if}
  <p class="note">{t("account.recovery.body")}</p>
  {#if vue === "ferme" || vue === "fini" || vue === "controlee"}
    {#if vue === "fini"}<p class="ok" role="status">{t("account.recovery.done")}</p>{/if}
    {#if vue === "controlee"}<p class="ok" role="status" data-cle-verifiee>{t("account.recovery.check.ok")}</p>{/if}
    {#if rappelCle() && vue === "ferme"}<p class="note">{t("account.recovery.lost")}</p>{/if}
    <div class="actions">
      {#if vue !== "controlee"}<Button onpress={controler}>{t("account.recovery.check")}</Button>{/if}
      <Button variant="secondary" onpress={commencer}>{t("account.recovery.new")}</Button>
    </div>
  {:else if vue === "controle"}
    <form
      class="form"
      onsubmit={(e) => {
        e.preventDefault();
        void verifier();
      }}
    >
      <TextField label={t("account.key.field")} hint={t("account.recovery.check.hint")} autocomplete="off" autocapitalize="characters" spellcheck="false" error={errSaisie || undefined} bind:value={saisie} bind:el={elSaisie} oninput={() => (errSaisie = "")} />
      <div class="actions">
        <Button type="submit" busy={envoi} onpress={verifier}>{t("account.recovery.check.go")}</Button>
        <Button variant="secondary" onpress={() => void (vue = "ferme")}>{t("account.recovery.check.cancel")}</Button>
      </div>
    </form>
  {:else if vue === "cle"}
    <CleRecup {texte} avertissement={t("account.recovery.notyet")} bind:sauvee onnotee={() => void (vue = "verif")} />
  {:else if vue === "verif"}
    <VerifCle {texte} bouton={t("account.recovery.save")} onjuste={enregistrer} onrevoir={() => void (vue = "cle")} />
  {:else}
    <p class="note">{t("account.reauth.needed")}</p>
    <div class="actions"><Button onpress={confirmer}>{t("account.reauth.go")}</Button></div>
  {/if}
  {#if global}<p class="err" role="alert">{global}</p>{/if}
</Section>
