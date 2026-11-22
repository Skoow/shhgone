<script lang="ts">
  // Profil (/compte/profil ; conception compte §21.5, §21.15.3 ; plan, lot 13). Monté seulement avec
  // __COMPTES__ et une session ouverte (App.svelte, routes/compte/pages.ts).
  // - Photo facultative : ré-encodée SUR L'APPAREIL (256 × 256, 64 Ko au plus, sans métadonnées),
  //   rangée dans le coffre de profil ; « Retirer ». Le nom du fichier n'est ni gardé ni montré.
  // - Pseudo obligatoire, unique parmi les comptes : règle du salon sur l'appareil, puis
  //   « Disponible » / « Déjà pris » (pseudo/verifier) ; « Enregistrer » (une fois par 24 h).
  // - Carte « Votre compte » (ancienneté, palier, abonnement, bannissement) et note de
  //   confidentialité : le profil est séquestré, le service peut le lire (R-D1).
  import { untrack } from "svelte";
  import { account, changerPseudo, ecrireProfil, etatCompte, pseudoLibre, verifierSaisie, type EtatServeur } from "../../account/session.svelte";
  import { followLink, href, navigate } from "../../app/router.svelte";
  import { t } from "../../i18n/i18n.svelte";
  import { announce } from "../../ui/announce";
  import AvatarPicker from "../../ui/AvatarPicker.svelte";
  import Banner from "../../ui/Banner.svelte";
  import Button from "../../ui/Button.svelte";
  import { ChevronRight, Info } from "../../ui/Icon";
  import PseudoField from "../../ui/PseudoField.svelte";
  import Cadre from "./Cadre.svelte";
  import CarteCompte from "./CarteCompte.svelte";
  import { codeDe, erreur, jourLong } from "./erreurs";

  let etat = $state.raw<EtatServeur | null>(null);
  let pseudo = $state(account.profil?.pseudo ?? "");
  let photo = $state.raw<Uint8Array | null>(account.profil?.photo ?? null);
  let errPseudo = $state<string | undefined>(undefined);
  let bandeau = $state("");
  let ok = $state("");
  let el: HTMLInputElement | undefined = $state();

  $effect(() =>
    untrack(() => {
      etatCompte().then(
        (e) => (etat = e),
        (e) => (bandeau = erreur(e, "parametres").texte),
      );
    }),
  );

  const actuel = () => account.profil?.pseudo ?? "";

  async function verifier(p: string): Promise<string> {
    if (p.trim() === actuel()) return "";
    const r = await verifierSaisie({ pseudo: p });
    if (r.pseudo) return r.pseudo;
    return (await pseudoLibre(p)) ? "libre" : "pris";
  }

  async function enregistrer() {
    errPseudo = undefined;
    ok = "";
    if (pseudo.trim() === actuel()) return;
    try {
      await changerPseudo(pseudo);
    } catch (e) {
      const c = codeDe(e);
      // Prochain changement possible (3 par an au plus, 20 novembre) : date tirée de l'attente.
      const apres = (e as { retryAfterS?: number }).retryAfterS ?? 0;
      errPseudo = c === "limit" ? t("account.profile.limit", { date: jourLong(new Date(Date.now() + apres * 1000).toISOString().slice(0, 10)) }) : erreur(e, "parametres").texte;
      announce(errPseudo);
      el?.focus();
      return;
    }
    ok = t("account.profile.saved");
    announce(ok);
  }

  async function photoChangee(p: Uint8Array | null) {
    bandeau = "";
    try {
      await ecrireProfil({ photo: p });
    } catch (e) {
      photo = account.profil?.photo ?? null; // rien n'a été écrit : l'aperçu revient au coffre
      bandeau = erreur(e, "parametres").texte;
    }
  }
</script>

<Cadre titre={t("account.profile.title")}>
  {#if bandeau}<Banner kind="danger">{bandeau}</Banner>{/if}
  {#if account.erreur === "coffre_illisible"}<Banner kind="danger">{t("account.err.coffre")}</Banner>{/if}

  <AvatarPicker grand bind:photo initiale={pseudo.trim()} onchange={photoChangee} />

  <form novalidate onsubmit={(e) => e.preventDefault()}>
    <PseudoField bind:value={pseudo} {verifier} error={errPseudo} bind:el onsaisie={() => ((errPseudo = undefined), (ok = ""))} />
    {#if ok}<p class="ok" role="status">{ok}</p>{/if}
    <div class="actions"><Button type="submit" variant="secondary" onpress={enregistrer}>{t("account.profile.save")}</Button></div>
  </form>

  <CarteCompte {etat} />

  <p class="note conf">
    <Info size={18} strokeWidth={1.75} aria-hidden="true" />
    <span>{t("account.profile.privacy")} <a class="lien" href={href("/securite")} onclick={(e) => followLink(e, "/securite")}>{t("account.profile.more")}</a></span>
  </p>

  <div class="actions">
    <Button variant="secondary" onpress={() => navigate("/compte")}>
      {t("account.profile.settings")}
      {#snippet icon()}<ChevronRight size={18} strokeWidth={1.75} />{/snippet}
    </Button>
  </div>
</Cadre>

<style>
  .ok {
    margin: 0;
    color: var(--accent);
    font-weight: 560;
  }
  .conf {
    display: flex;
    gap: var(--sp-2);
    align-items: flex-start;
  }
  .conf :global(svg) {
    flex: none;
    margin-top: 2px;
  }
  .conf .lien {
    display: inline;
    min-height: 0;
  }
</style>
