<script lang="ts">
  // Fin d'une conversation du salon, dans le cadre de la conversation (même scène, même cadre que
  // Conversation.svelte) : titre, une phrase, l'heure de fin quand cette page l'a vue (jamais
  // devinée), puis les actions. Lien d'un salon fini ouvert plus tard : le serveur rend la même
  // erreur pour un salon inconnu, échu ou détruit (aucun oracle, server/internal/salon/erreurs.go) ;
  // le titre le dit donc sans trancher (« terminée ou n'existe plus »), sans date.
  // L'image (bulles qui se défont en trame) est décorative : aria-hidden.
  import { untrack, type Snippet } from "svelte";
  import { t, getLang } from "../../i18n/i18n.svelte";
  import { formatDayTime } from "../../i18n/format";
  import { followLink, href, navigate } from "../../app/router.svelte";

  type Props = { titre: string; texte: string; finLe?: number | null; creer?: boolean; children?: Snippet };
  let { titre, texte, finLe = null, creer = true, children }: Props = $props();
  const lang = $derived(getLang());
  let h1: HTMLHeadingElement | undefined = $state();
  $effect(() => {
    if (h1) untrack(() => h1?.focus({ preventScroll: true }));
  });
</script>

<div class="salon" data-termine>
  <section class="ecran" aria-labelledby="termine-t">
    <div class="trace" aria-hidden="true">
      <span class="b g"></span>
      <span class="b d"></span>
      <span class="b g court"></span>
    </div>
    <div class="texte">
      <h1 id="termine-t" tabindex="-1" bind:this={h1}>{titre}</h1>
      <p class="phrase" role="status">{texte}</p>
      {#if finLe !== null}<p class="quand"><time datetime={new Date(finLe).toISOString()}>{t("salon.termine.le", { date: formatDayTime(finLe, lang) })}</time></p>{/if}
      {@render children?.()}
      <div class="actions">
        {#if creer}<a class="b-creer" href={href("/salon/nouveau")} onclick={(e) => followLink(e, "/salon/nouveau")}>{t("salon.termine.creer")}</a>{/if}
        <button type="button" class="b-accueil" onclick={() => navigate("/")}>{t("salon.end.home")}</button>
      </div>
    </div>
  </section>
</div>

<style>
  /* Scène et cadre : ceux de Conversation.svelte (fond de la vitrine). */
  .salon {
    position: relative;
    isolation: isolate;
    margin-inline: calc(50% - 50cqw);
    margin-block-start: calc(-1 * var(--sp-5));
    /* Toute la hauteur de la fenêtre sous l'en-tête du site, le cadre au milieu. */
    display: grid;
    align-content: center;
    min-height: calc(100dvh - 64px);
    box-sizing: border-box;
    padding: var(--sp-6) clamp(16px, 4vw, 72px) var(--sp-7);
    background:
      radial-gradient(70% 60% at 20% 30%, rgb(95 227 181 / 0.08), transparent 70%),
      radial-gradient(60% 70% at 90% 90%, rgb(51 102 255 / 0.1), transparent 70%),
      var(--bg-deep);
  }
  .salon::before {
    content: "";
    position: absolute;
    inset: 0;
    z-index: -1;
    background: radial-gradient(circle, rgb(233 236 242 / 0.08) 1.1px, transparent 1.6px) 0 0 / 14px 14px;
    -webkit-mask-image: radial-gradient(80% 70% at 30% 40%, #000 20%, transparent 75%);
    mask-image: radial-gradient(80% 70% at 30% 40%, #000 20%, transparent 75%);
    pointer-events: none;
  }
  .ecran {
    display: grid;
    gap: var(--sp-6);
    width: min(100%, 640px);
    box-sizing: border-box;
    margin-inline: auto;
    padding: var(--sp-6) clamp(20px, 5vw, 56px) var(--sp-6);
    border-radius: 20px;
    background: var(--bg);
    box-shadow:
      inset 0 0 0 1px var(--hair-2),
      0 40px 80px -40px rgb(0 0 0 / 0.9);
  }
  /* Trois bulles vides qui se défont en points (la trame de l'effet « efface »). */
  .trace {
    display: grid;
    gap: var(--sp-2);
    /* Plein à gauche, en points à droite : la conversation qui s'efface. */
    -webkit-mask:
      linear-gradient(90deg, #000 18%, transparent 58%),
      radial-gradient(circle, #000 1.5px, transparent 2.1px) 0 0 / 6px 6px;
    mask:
      linear-gradient(90deg, #000 18%, transparent 58%),
      radial-gradient(circle, #000 1.5px, transparent 2.1px) 0 0 / 6px 6px;
  }
  .b {
    display: block;
    height: 40px;
    border-radius: 16px 16px 16px 6px;
    background: var(--surface-2);
  }
  .b.g {
    width: 62%;
  }
  .b.d {
    justify-self: end;
    width: 48%;
    border-radius: 16px 16px 6px 16px;
    background: var(--accent-tint);
  }
  .b.court {
    width: 36%;
  }
  .texte {
    display: grid;
    gap: var(--sp-3);
  }
  h1 {
    margin: 0;
    font-size: clamp(1.5rem, 1.2rem + 1vw, 2rem);
    font-weight: 700;
    font-stretch: var(--wd-display, 112%);
    line-height: 1.1;
    letter-spacing: -0.03em;
    text-wrap: balance;
  }
  h1:focus {
    outline: none;
  }
  .phrase {
    margin: 0;
    color: var(--text-2);
    text-wrap: pretty;
  }
  .quand {
    margin: 0;
    color: var(--text);
    font-weight: 560;
  }
  /* Contenu passé par Salon.svelte (reprendre la main, détruire) : mêmes règles que Cadre.svelte. */
  .texte :global(.note) {
    margin: 0;
    color: var(--text-2);
  }
  .texte :global(.actions) {
    display: flex;
    flex-wrap: wrap;
    gap: var(--sp-3);
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--sp-3);
    margin-top: var(--sp-3);
  }
  .b-creer,
  .b-accueil {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 48px;
    padding: 0 var(--sp-5);
    border-radius: 12px;
    font: inherit;
    font-weight: 600;
    text-decoration: none;
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
    transition:
      background-color var(--dur-fast) var(--ease-out),
      transform var(--dur-press) var(--ease-out);
  }
  .b-creer {
    border: 0;
    background: var(--accent);
    color: var(--on-accent);
  }
  .b-accueil {
    border: 1px solid var(--hair-2);
    background: rgb(255 255 255 / 0.045);
    box-shadow: var(--edge-hi);
    color: var(--text);
  }
  @media (hover: hover) {
    .b-accueil:hover {
      background: rgb(255 255 255 / 0.08);
    }
  }
  .b-creer:active,
  .b-accueil:active {
    transform: scale(0.97);
  }
  .b-creer:focus-visible,
  .b-accueil:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  @media (max-width: 899px) {
    .salon {
      margin-block-start: calc(-1 * var(--sp-3));
      align-content: start;
      min-height: calc(100dvh - 56px);
      padding: var(--sp-4) var(--sp-2) var(--sp-5);
    }
    .ecran {
      border-radius: 16px;
      padding: var(--sp-5) var(--sp-4);
      gap: var(--sp-5);
    }
    .actions > * {
      flex: 1 1 100%;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .b-creer,
    .b-accueil {
      transition: none;
    }
    .b-creer:active,
    .b-accueil:active {
      transform: none;
    }
  }
  @media (forced-colors: active) {
    .ecran {
      border: 1px solid CanvasText;
    }
    .trace {
      display: none;
    }
  }
</style>
