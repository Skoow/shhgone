<script lang="ts">
  // Accueil v3, questions fréquentes (UI §9.1) : accordéon natif (<details name> : une seule
  // réponse ouverte), réponses tirées de la spécification (§2, §9, §18). La réponse entre en
  // fondu et montée de 6 px ; aucune hauteur animée (§20.6 point 1).
  import { t, type Key } from "../../i18n/i18n.svelte";
  import { reveal } from "../../ui/attach";
  import { ChevronDown } from "../../ui/Icon";

  const qs = ["server", "lost", "back", "scan", "copy"] as const;
</script>

<!-- Fond raccordé (.fondu, ui/base.css) ; titre centré, questions centrées dessous. -->
<section class="faq fondu filet" id="faq" aria-labelledby="faq-title">
  <div class="fh rv" {@attach reveal}>
    <h2 id="faq-title">{t("home.faq.title")}</h2>
  </div>
  <div class="qa">
    {#each qs as k (k)}
      <!-- « Ce que voit le serveur » (menu Sécurité de la barre du haut) ouvre la première question. -->
      <details name="faq" id="faq-{k}" class="rv" {@attach reveal}>
        <summary><span>{t(`home.faq.${k}.q` as Key)}</span><ChevronDown size={22} strokeWidth={1.75} aria-hidden="true" /></summary>
        <div class="a"><p>{t(`home.faq.${k}.a` as Key)}</p></div>
      </details>
    {/each}
  </div>
</section>

<style>
  .faq {
    --lueur: rgb(141 178 255 / 0.06);
    --lueur-x: 20%;
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: var(--sp-6);
    padding-block: 104px 120px;
    scroll-margin-top: 72px;
  }
  /* Une colonne centrée : le titre au-dessus, les questions dessous, sur une largeur de lecture
     (48 rem au plus) ; le texte des questions reste aligné à gauche dans la colonne. */
  .fh {
    display: grid;
    gap: var(--sp-3);
    min-width: 0;
    text-align: center;
  }
  details {
    scroll-margin-top: 96px;
  }
  @media (min-width: 1024px) {
    .faq {
      gap: var(--sp-7);
      padding-block: 136px 144px;
    }
  }
  h2 {
    margin: 0;
    text-wrap: balance;
    min-width: 0;
    overflow-wrap: break-word;
    font-size: clamp(2.25rem, 1.4rem + 2.8vw, 4rem);
    line-height: 1.02;
    font-weight: 700;
    font-stretch: 112%;
    letter-spacing: -0.035em;
  }
  /* Questions : une liste à filets (plus de cartes) ; barre menthe à gauche de la question ouverte. */
  .qa {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    justify-self: center;
    width: min(100%, 48rem);
    border-block-start: 1px solid rgb(233 236 242 / 0.16);
  }
  details {
    position: relative;
    border-block-end: 1px solid rgb(233 236 242 / 0.16);
  }
  details::after {
    content: "";
    position: absolute;
    left: 0;
    top: 18px;
    height: 28px;
    width: 3px;
    border-radius: 0 3px 3px 0;
    background: var(--accent);
    transform: scaleY(0);
    transition: transform 420ms var(--ease-settle);
  }
  details[open]::after {
    transform: scaleY(1);
  }
  summary {
    list-style: none;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--sp-4);
    min-height: 64px;
    padding: var(--sp-4) var(--sp-2) var(--sp-4) var(--sp-4);
    cursor: pointer;
    font-size: 1.125rem;
    font-weight: 580;
    -webkit-tap-highlight-color: transparent;
  }
  summary:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
    border-radius: 8px;
  }
  summary > span {
    min-width: 0;
    overflow-wrap: break-word;
  }
  summary::-webkit-details-marker {
    display: none;
  }
  summary :global(svg) {
    flex: none;
    color: var(--text-2);
    transition:
      transform 520ms var(--ease-settle),
      color var(--dur-fast) var(--ease-out);
  }
  details[open] summary :global(svg) {
    transform: rotate(180deg);
    color: var(--accent);
  }
  @media (hover: hover) {
    summary:hover :global(svg) {
      color: var(--accent);
    }
  }
  .a {
    padding: 0 var(--sp-4) 22px;
    overflow-wrap: break-word;
  }
  .a p {
    margin: 0;
    color: #aab6d3;
    max-width: 62ch;
    line-height: 1.6;
  }
  @media (prefers-reduced-motion: no-preference) {
    details[open] .a {
      animation: answer 480ms var(--ease-settle) both;
    }
  }
  @keyframes answer {
    from {
      opacity: 0;
      transform: translateY(-8px);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    details::after,
    summary :global(svg) {
      transition: none;
    }
  }
</style>
