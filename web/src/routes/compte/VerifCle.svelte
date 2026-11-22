<script lang="ts">
  // Vérification de la clé notée (conception du compte par passkey §3.1, écran 4) : un groupe tiré
  // au hasard parmi les 7 (4 caractères, 3 pour le dernier), comparé sur l'appareil, saisie
  // tolérante (minuscules, I/L/O). « Revoir la clé » revient à l'écran précédent. Monté seulement
  // avec __COMPTES__. `children` : ce qui va avant le bouton (case « Rester connecté »).
  import { tick, type Snippet } from "svelte";
  import { groupeAVerifier, groupeJuste } from "../../account/session.svelte";
  import { t } from "../../i18n/i18n.svelte";
  import Button from "../../ui/Button.svelte";
  import TextField from "../../ui/TextField.svelte";

  type Props = { texte: string; bouton: string; onjuste: () => void | Promise<void>; onrevoir: () => void; children?: Snippet; erreur?: string };
  let { texte, bouton, onjuste, onrevoir, children, erreur = "" }: Props = $props();
  const k = groupeAVerifier();
  let saisie = $state("");
  let err = $state("");
  let el: HTMLInputElement | undefined = $state();

  async function valider() {
    err = "";
    if (!groupeJuste(texte, k, saisie)) {
      err = t("account.verify.err");
      await tick();
      el?.focus();
      return;
    }
    await onjuste();
  }
</script>

<form novalidate onsubmit={(e) => e.preventDefault()}>
  <TextField label={t("account.verify.label", { k })} autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength={8} error={err || erreur || undefined} bind:value={saisie} bind:el oninput={() => (err = "")} />
  {@render children?.()}
  <Button type="submit" onpress={valider}>{bouton}</Button>
</form>
<div class="actions">
  <Button variant="ghost" onpress={onrevoir}>{t("account.verify.back")}</Button>
</div>
