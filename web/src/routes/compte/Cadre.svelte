<script lang="ts">
  // Cadre des pages du compte (conception compte §12, §21.15) : colonne centrée de 28 rem au plus,
  // titre de l'écran (focus à l'arrivée), sous-titre, contenu. (« une
  // forme jolie ») : une carte arrondie, lueur menthe en haut, titre et sous-titre centrés.
  // Démo : la phrase de la démo (aucune passkey créée, compte de cet onglet seulement) sous le titre.
  import { untrack, type Snippet } from "svelte";
  import { getDemo } from "../../app/demo-hooks";

  type Props = { titre: string; sous?: string; children: Snippet };
  let { titre, sous, children }: Props = $props();
  let h1: HTMLHeadingElement | undefined = $state();
  $effect(() => {
    if (h1) untrack(() => h1?.focus({ preventScroll: true }));
  });
</script>

<section class="cadre" aria-labelledby="compte-titre">
  <div class="tete titre-bandeau">
    <h1 id="compte-titre" class="titre" tabindex="-1" data-large-title bind:this={h1}>{titre}</h1>
    {#if sous}<p class="sous">{sous}</p>{/if}
  </div>
  {#if getDemo()}<p class="note" data-demo-note>{getDemo()!.compteNote}</p>{/if}
  {@render children()}
</section>

<style>
  .cadre {
    position: relative;
    isolation: isolate;
    width: min(100%, 30rem);
    margin: var(--sp-6) auto var(--sp-8);
    padding: clamp(28px, 5vw, 44px) clamp(20px, 5vw, 40px) clamp(28px, 5vw, 40px);
    display: grid;
    gap: var(--sp-5);
    min-width: 0;
    border-radius: clamp(20px, 3vw, 28px);
    background:
      radial-gradient(90% 60% at 50% -10%, rgb(95 227 181 / 0.14), transparent 70%),
      linear-gradient(180deg, rgb(255 255 255 / 0.045), rgb(255 255 255 / 0.012)),
      rgb(14 17 23);
    box-shadow:
      inset 0 0 0 1px rgb(233 236 242 / 0.1),
      inset 0 1px 0 rgb(255 255 255 / 0.06),
      0 40px 80px -48px rgb(0 0 0 / 0.9);
  }
  .titre {
    margin: 0;
    font-size: clamp(1.875rem, 1.4rem + 1.6vw, 2.5rem);
    font-weight: 700;
    font-stretch: var(--wd-display, 112%);
    letter-spacing: -0.03em;
    line-height: 1.08;
    text-align: center;
    text-wrap: balance;
  }
  .titre:focus {
    outline: none;
  }
  /* Titre et sous-titre : dans le bandeau des titres (ui/base.css), centré dans le cadre. */
  .tete {
    display: grid;
    gap: var(--sp-2);
    justify-self: center;
  }
  .sous {
    margin: 0;
    color: var(--text-2);
    text-align: center;
    text-wrap: pretty;
  }
  .cadre :global(form) {
    display: grid;
    gap: var(--sp-5);
    min-width: 0;
  }
  .cadre :global(.liens) {
    display: flex;
    flex-wrap: wrap;
    gap: var(--sp-2) var(--sp-5);
    margin: 0;
    padding: 0;
    list-style: none;
  }
  /* Deux liens aux deux bords (connexion : « Mot de passe oublié » à gauche, « Créer un compte » à droite). */
  .cadre :global(.liens.split) {
    justify-content: space-between;
  }
  /* Liens en blanc, sans soulignement ; menthe au survol et au focus. */
  .cadre :global(.liens a),
  .cadre :global(a.lien),
  .cadre :global(a.lien-t) {
    display: inline-flex;
    align-items: center;
    min-height: 44px;
    color: var(--text);
    font-weight: 600;
    text-decoration: none;
    transition: color var(--dur-fast) var(--ease-out);
  }
  .cadre :global(.liens a:hover),
  .cadre :global(a.lien:hover),
  .cadre :global(a.lien-t:hover) {
    color: var(--accent);
  }
  .cadre :global(.liens a:focus-visible),
  .cadre :global(a.lien:focus-visible),
  .cadre :global(a.lien-t:focus-visible) {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
    border-radius: 4px;
  }
  /* Lien dans une phrase (« conditions d'utilisation ») : blanc et souligné, pas en gras ;
     hauteur de la ligne, pas de cible de 44 px qui décale le texte. */
  .cadre :global(a.lien-t) {
    position: relative;
    display: inline;
    min-height: 0;
    font-weight: inherit;
    text-decoration: underline;
    text-decoration-thickness: 1px;
    text-underline-offset: 3px;
  }
  /* Zone tactile de 44 px de haut sans décaler le texte : un
     pseudo-élément transparent déborde de la ligne, au-dessus et au-dessous. */
  .cadre :global(a.lien-t::after) {
    content: "";
    position: absolute;
    inset: 50% 0 auto;
    height: 44px;
    transform: translateY(-50%);
  }
  /* Autres chemins (connexion : clé de récupération, création ; inscription : « J'ai déjà un
     compte ») : séparateur « ou » (deux filets et le mot au milieu), puis des liens en forme de
     bouton secondaire, pleine largeur, icône menthe à gauche, texte centré. */
  .cadre :global(.ou) {
    display: flex;
    align-items: center;
    gap: var(--sp-3);
    margin: 0;
    color: var(--text-3);
    font-size: var(--fs-small);
  }
  .cadre :global(.ou::before),
  .cadre :global(.ou::after) {
    content: "";
    flex: 1;
    height: 1px;
    background: var(--hair-2);
  }
  .cadre :global(.autres) {
    display: grid;
    gap: var(--sp-3);
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .cadre :global(.autre) {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: var(--sp-2);
    min-height: 48px;
    padding: 0 20px;
    border: 1px solid var(--hair-2);
    border-radius: 12px;
    background: rgb(255 255 255 / 0.045);
    box-shadow: var(--edge-hi);
    color: var(--text);
    font-size: 0.9375rem;
    font-weight: 560;
    text-decoration: none;
    transition:
      background-color var(--dur-fast) var(--ease-out),
      border-color var(--dur-fast) var(--ease-out),
      color var(--dur-fast) var(--ease-out);
  }
  .cadre :global(.autre svg) {
    color: var(--accent);
  }
  @media (hover: hover) {
    .cadre :global(.autre:hover) {
      background: rgb(255 255 255 / 0.08);
      border-color: rgb(233 236 242 / 0.2);
    }
  }
  .cadre :global(.autre:focus-visible) {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  .cadre :global(.note) {
    margin: 0;
    color: var(--text-2);
  }
  .cadre :global(.actions) {
    display: flex;
    flex-wrap: wrap;
    gap: var(--sp-3);
  }
  .cadre :global(.actions > .btn) {
    flex: 1 1 auto;
  }
  @media (max-width: 599px) {
    .cadre {
      margin-block: var(--sp-3) var(--sp-6);
      gap: var(--sp-4);
    }
  }
  @media (forced-colors: active) {
    .cadre {
      border: 1px solid CanvasText;
    }
    .cadre :global(.autre) {
      border-color: ButtonText;
    }
  }
</style>
