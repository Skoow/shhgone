<script lang="ts">
  // Clé de récupération (conception du compte par passkey §3.4, §3.5, Q10 ; monté seulement avec
  // __COMPTES__) : ce qu'elle permet, et « Créer une nouvelle clé » : nouvelle clé tirée sur
  // l'appareil, montrée une fois, un groupe retapé, puis seuls v_r et l'enveloppe partent (session
  // récente, sinon « Confirmer avec une passkey » d'abord) ; l'ancienne clé ne sert plus.
  // Après un usage de la clé, un bandeau le propose jusqu'à ce que ce soit fait.
  import { account, confirmerParPasskey, enregistrerNouvelleCle, preparerNouvelleCle, preparerReauth } from "../../../account/session.svelte";
  import { t } from "../../../i18n/i18n.svelte";
  import { announce } from "../../../ui/announce";
  import Banner from "../../../ui/Banner.svelte";
  import Button from "../../../ui/Button.svelte";
  import CleRecup from "../CleRecup.svelte";
  import { annulee, codeDe, erreur } from "../erreurs";
  import VerifCle from "../VerifCle.svelte";
  import Section from "./Section.svelte";

  let vue = $state<"ferme" | "cle" | "verif" | "recent" | "fini">("ferme");
  let texte = $state("");
  let global = $state("");

  async function commencer() {
    global = "";
    texte = await preparerNouvelleCle();
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
  <p class="note">{t("account.recovery.body")}</p>
  {#if vue === "ferme" || vue === "fini"}
    {#if vue === "fini"}<p class="ok" role="status">{t("account.recovery.done")}</p>{/if}
    <div class="actions"><Button variant="secondary" onpress={commencer}>{t("account.recovery.new")}</Button></div>
  {:else if vue === "cle"}
    <CleRecup {texte} avertissement={t("account.recovery.notyet")} onnotee={() => void (vue = "verif")} />
  {:else if vue === "verif"}
    <VerifCle {texte} bouton={t("account.recovery.save")} onjuste={enregistrer} onrevoir={() => void (vue = "cle")} />
  {:else}
    <p class="note">{t("account.reauth.needed")}</p>
    <div class="actions"><Button onpress={confirmer}>{t("account.reauth.go")}</Button></div>
  {/if}
  {#if global}<p class="err" role="alert">{global}</p>{/if}
</Section>
