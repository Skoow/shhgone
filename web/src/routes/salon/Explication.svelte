<script lang="ts">
  // Page d'explication et pseudonyme (spec §39.4 point 3 ; textes corrigés : v3 §5.1, exigence C-3
  // 18) : après le mot de passe, avant le salon. Le pseudonyme suit les règles du moteur
  // (pseudoValide : longueur, caractères, une seule écriture) et l'unicité dans le salon (profils
  // déjà reçus). Le salon est déjà ouvert en arrière-plan : l'arrivée dans le groupe chiffré se
  // fait pendant la lecture.
  import { untrack } from "svelte";
  import { t, getLang } from "../../i18n/i18n.svelte";
  import { formatDuration } from "../../i18n/format";
  import { vue, entrer, pseudoPropose, photoProposee, choisirAvatar, verifierPseudo, conversation } from "../../salon/salon.svelte";
  import { pseudoLibreSalon, retenirPseudoInvite } from "../../account/session.svelte";
  import { codeDe } from "../compte/erreurs";
  import AvatarPicker from "../../ui/AvatarPicker.svelte";
  import Cadre from "../compte/Cadre.svelte";
  import TextField from "../../ui/TextField.svelte";
  import Button from "../../ui/Button.svelte";
  import Banner from "../../ui/Banner.svelte";
  import { ChevronDown } from "../../ui/Icon";

  const refuse = untrack(() => conversation()?.pseudoRefuse === true);
  let pseudo = $state(untrack(() => vue.monPseudo ?? pseudoPropose()));
  let essaye = $state(false);
  let photo = $state<Uint8Array | null>(untrack(() => photoProposee()));
  let champ: HTMLInputElement | undefined = $state();
  const reste = $derived(Math.max(0, (vue.finMs - Date.now()) / 1000));
  const duree = $derived(formatDuration(reste, getLang(), { coarse: true }));
  const verdict = $derived((void vue.rev, verifierPseudo(pseudo)));
  let errCompte = $state("");
  const erreur = $derived(errCompte || (essaye || pseudo.length > 0 ? ("code" in verdict ? t(`salon.pseudo.err.${verdict.code}`) : "") : ""));
  // Avec un compte et son vrai pseudo (20 novembre, propriétaire : un seul pseudo) : le salon
  // prend le pseudo du compte, non modifiable ici ; il se change dans le profil (3 fois par an).
  // Pseudo du compte déjà pris dans ce salon (course rare, `refuse`) : le champ se libère.
  const fige = __COMPTES__ && !refuse && untrack(() => pseudoPropose()) !== "";
  let envoi = false;

  async function go(): Promise<void> {
    essaye = true;
    errCompte = "";
    if (envoi) return;
    if (__COMPTES__ && !fige && !("code" in verdict)) {
      // Invité (ou compte qui garde le salon à part) : unique dans la conversation, et jamais le
      // pseudo d'un autre compte (décision du propriétaire, 22 novembre). Le serveur ne sait pas
      // de quel salon il s'agit ; rien n'est gardé.
      envoi = true;
      try {
        if (!(await pseudoLibreSalon(pseudo))) errCompte = t("salon.pseudo.err.compte_pris");
      } catch (e) {
        errCompte = t((e as { status?: unknown }).status === 429 || codeDe(e) === "limit" ? "salon.pseudo.err.essais" : "salon.pseudo.err.compte");
      } finally {
        envoi = false;
      }
      if (errCompte) return champ?.focus();
      retenirPseudoInvite(pseudo);
    }
    if (!entrer(pseudo)) return champ?.focus();
    if (photo) void choisirAvatar(photo);
  }
  $effect(() => {
    if (refuse) untrack(() => champ?.focus());
  });
</script>

<Cadre titre={t("salon.intro.title")}>
  {#if refuse}<Banner kind="warn">{t("salon.pseudo.err.refuse")}</Banner>{/if}
  <!-- Revue du 20 novembre (U18) : trois points essentiels visibles (chiffrement, effacement du
       salon, effacement des messages et limite des captures), les autres sous « En savoir plus »,
       toujours dans la page (aucun texte retiré) ; le champ du pseudonyme remonte. -->
  <ul class="points" data-points-essentiels>
    <li>{t("salon.intro.1")}</li>
    <li>{t("salon.intro.2", { duree })}</li>
    <li>{t("salon.intro.9")}</li>
  </ul>
  <details class="plus" data-points-plus>
    <summary><span>{t("salon.intro.more")}</span><ChevronDown size={18} aria-hidden="true" /></summary>
    <ul class="points">
      <li>{t("salon.intro.3")}</li>
      <li>{t("salon.intro.4")}</li>
      <li>{t("salon.intro.5")}</li>
      <li>{t("salon.intro.6")}</li>
      <li>{t("salon.intro.7")}</li>
      <li>{t("salon.intro.8")}</li>
      <li>{t("salon.intro.10")}</li>
    </ul>
  </details>
  <div class="form">
    <TextField
      label={t("salon.intro.pseudo")}
      hint={t("salon.intro.pseudo.hint")}
      bind:value={pseudo}
      bind:el={champ}
      readonly={fige || undefined}
      aria-readonly={fige ? "true" : undefined}
      autocomplete="off"
      autocapitalize="off"
      spellcheck={false}
      maxlength={96}
      enterkeyhint="go"
      error={erreur || undefined}
      oninput={() => (errCompte = "")}
      onkeydown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          void go();
        }
      }}
    />
    <!-- Photo pour ce salon (v3 §7.2), facultative : ré-encodée sur l'appareil, envoyée chiffrée. -->
    <!-- Un seul libellé (restes, point 8) : celui du choix de photo, nommé pour le salon. -->
    <AvatarPicker bind:photo initiale={[...pseudo.trim()][0] ?? ""} libelle={t("salon.avatar.photo")} />
    {#if fige}<p class="note" data-pseudo-fige>{t("salon.intro.pseudo.fige")}</p>{/if}
    <div class="actions"><Button onpress={go}>{t("salon.intro.enter")}</Button></div>
    {#if !vue.dansLeGroupe && !vue.createur}<p class="note" role="status">{t("salon.intro.wait")}</p>{/if}
  </div>
</Cadre>

<style>
  .points {
    margin: 0;
    padding-inline-start: 1.2em;
    display: grid;
    gap: var(--sp-2);
    color: var(--text-2);
  }
  .form {
    display: grid;
    gap: var(--sp-4);
  }
  .plus {
    margin-top: calc(-1 * var(--sp-2));
  }
  .plus summary {
    min-height: 44px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--sp-3);
    list-style: none;
    cursor: pointer;
    color: var(--text);
    font-weight: 560;
  }
  .plus summary::-webkit-details-marker {
    display: none;
  }
  .plus summary:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
    border-radius: var(--r-sm);
  }
  .plus summary :global(svg) {
    flex: none;
    color: var(--text-2);
    transition: transform var(--dur-fast) var(--ease-out);
  }
  .plus[open] summary :global(svg) {
    transform: rotate(180deg);
  }
  .plus .points {
    margin-top: var(--sp-2);
  }
  @media (prefers-reduced-motion: reduce) {
    .plus summary :global(svg) {
      transition: none;
    }
  }
</style>
