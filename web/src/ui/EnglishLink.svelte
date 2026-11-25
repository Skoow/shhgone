<script lang="ts" module>
  // Fermeture gardée en mémoire seulement, pour la vie de la page (aucun stockage navigateur,
  // source-rules.test.ts) : le bandeau ne revient pas en changeant d'écran dans l'application.
  let ferme = $state(false);
</script>

<script lang="ts">
  // Bandeau « English version » (bandeau au lieu d'une pastille
  // flottante) : sur la version française d'une page bilingue
  // (app/langues.ts), un navigateur anglophone voit, en haut de page, un lien vers la version
  // « /en… ». L'adresse donne la langue de ces pages (référencement : jamais de renvoi
  // automatique) ; ce bandeau garde le confort des anglophones. Dans le flux, au-dessus de la
  // barre du site : il ne recouvre rien. Fermable ; rien n'est envoyé ni gardé.
  import { BILINGUE, cheminEn, langueDuChemin } from "../app/langues";
  import { detectLang, getLang } from "../i18n/i18n.svelte";
  import { X } from "./Icon";

  let {
    bilingue = BILINGUE,
    chemin = typeof location === "undefined" ? null : location.pathname,
    base = import.meta.env.BASE_URL,
    navigateur = typeof navigator === "undefined" ? [] : navigator.languages,
  }: { bilingue?: boolean; chemin?: string | null; base?: string; navigateur?: readonly string[] } = $props();

  const cible = $derived.by(() => {
    if (!bilingue || chemin === null || getLang() !== "fr" || detectLang(navigateur) !== "en") return null;
    const b = base.replace(/\/$/, "");
    const p = b !== "" && chemin.startsWith(b) ? chemin.slice(b.length) || "/" : chemin;
    const l = langueDuChemin(p);
    return l?.lang === "fr" ? b + cheminEn("en", l.chemin) : null;
  });
</script>

{#if cible && !ferme}
  <div class="en-bar" lang="en" role="region" aria-label="English version" data-english-bar>
    <p>This page is in French.</p>
    <a class="en-link" href={cible} lang="en" hreflang="en" data-english-link>English version</a>
    <button type="button" class="fermer" aria-label="Close" onclick={() => (ferme = true)} data-english-close>
      <X size={20} aria-hidden="true" />
    </button>
  </div>
{/if}

<style>
  .en-bar {
    position: relative;
    z-index: 41;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: var(--sp-3);
    min-height: 48px;
    padding: 0 4px 0 16px;
    padding-inline-start: max(16px, env(safe-area-inset-left));
    background: var(--surface-2);
    border-bottom: 1px solid var(--line);
    color: var(--text-2);
    font-size: var(--fs-small);
  }
  p {
    margin: 0;
  }
  .en-link {
    display: inline-flex;
    align-items: center;
    min-height: 44px;
    padding: 0 4px;
    color: var(--text);
    font-weight: 600;
    text-decoration: underline;
    text-underline-offset: 3px;
  }
  .fermer {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 44px;
    height: 44px;
    margin-inline-start: auto;
    padding: 0;
    border: 0;
    border-radius: 10px;
    background: transparent;
    color: var(--text-2);
    cursor: pointer;
  }
  /* Le texte et le lien restent centrés ; la croix à droite. */
  .en-bar::before {
    content: "";
    width: 44px;
    margin-inline-end: auto;
    flex: none;
  }
  p,
  .en-link {
    white-space: nowrap;
  }
  /* Téléphone : texte et lien à gauche (plus de contrepoids à la croix), sur une ligne. */
  @media (max-width: 480px) {
    .en-bar::before {
      display: none;
    }
  }
  @media (max-width: 340px) {
    p {
      display: none;
    }
  }
  @media (hover: hover) {
    .fermer:hover {
      background: rgb(255 255 255 / 0.06);
      color: var(--text);
    }
  }
  .en-link:focus-visible,
  .fermer:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  @media (forced-colors: active) {
    .en-bar {
      border-bottom-color: CanvasText;
    }
  }
</style>
