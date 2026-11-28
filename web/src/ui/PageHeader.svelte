<script lang="ts">
  // En-tête de page commun (passe de finition du 25 novembre) : titre h1, chapeau facultatif,
  // lignes en plus (compteurs, note) et action à droite, dans le bandeau des titres
  // (.titre-bandeau, ui/base.css). Une seule échelle, deux tailles :
  //   - « display » : pages à lire (informations, Offres), grand titre ; centré sur téléphone et
  //     tablette, aligné à gauche à partir de 1100 px (comme avant) ;
  //   - « screen » : écrans d'outil (Mes partages, Mes salons, Suivi), titre plus court,
  //     toujours aligné à gauche ; l'action passe dessous, pleine largeur, sur téléphone.
  // Le titre prend le focus à l'arrivée (tabindex -1, sans anneau) et porte data-large-title
  // (titre réduit dans la barre du téléphone, AppShell).
  import type { Snippet } from "svelte";

  type Props = {
    id: string;
    title: string;
    lede?: string;
    size?: "display" | "screen";
    /** Lignes sous le chapeau (compteurs, note « en cours de rédaction »…). */
    children?: Snippet;
    /** Action principale de l'écran, à droite sur ordinateur. */
    actions?: Snippet;
    titleEl?: HTMLHeadingElement | undefined;
  };
  let { id, title, lede, size = "screen", children, actions, titleEl = $bindable() }: Props = $props();
</script>

<header class={["ph", "titre-bandeau", size]}>
  <div class="tx">
    <h1 {id} class="title" tabindex="-1" data-large-title bind:this={titleEl}>{title}</h1>
    {#if lede}<p class="lede">{lede}</p>{/if}
    {@render children?.()}
  </div>
  {#if actions}<div class="act">{@render actions()}</div>{/if}
</header>

<style>
  .ph {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    justify-content: space-between;
    gap: var(--sp-4) var(--sp-6);
    margin-block-start: clamp(16px, 3vw, 32px);
  }
  .tx {
    display: grid;
    gap: var(--sp-3);
    min-width: 0;
    flex: 1 1 28rem;
  }
  .title {
    margin: 0;
    min-width: 0;
    max-width: 22ch;
    font-weight: 700;
    font-stretch: var(--wd-display, 112%);
    overflow-wrap: break-word;
    text-wrap: balance;
  }
  .title:focus {
    outline: none;
  }
  .lede {
    margin: 0;
    max-width: 62ch;
    color: #b5c0da;
    text-wrap: pretty;
  }
  .tx > :global(p:not(.lede)) {
    margin: 0;
  }
  .act {
    display: flex;
    flex-wrap: wrap;
    gap: var(--sp-3);
  }

  /* Écrans d'outil. */
  .screen .title {
    font-size: clamp(2rem, 1.5rem + 2vw, 3rem);
    line-height: 1.05;
    letter-spacing: -0.03em;
  }
  .screen .lede {
    font-size: 1.0625rem;
    line-height: 1.55;
  }

  /* Pages à lire. */
  .display {
    justify-content: center;
    text-align: center;
  }
  .display .tx {
    justify-items: center;
    gap: var(--sp-4);
  }
  .display .title {
    max-width: 20ch;
    font-size: clamp(2.25rem, 1.3rem + 3.6vw, 4.25rem);
    line-height: 1.02;
    letter-spacing: -0.035em;
  }
  .display .lede {
    max-width: 58ch;
    font-size: clamp(1.0625rem, 1rem + 0.35vw, 1.25rem);
    line-height: 1.6;
  }
  @media (min-width: 1100px) {
    .ph {
      margin-block-start: var(--sp-6);
    }
    .display {
      justify-content: space-between;
      text-align: start;
    }
    .display .tx {
      justify-items: start;
      gap: var(--sp-5);
    }
    .display .title {
      max-width: 22ch;
      font-size: clamp(3.5rem, 1.5rem + 3vw, 5rem);
    }
    .display .lede {
      max-width: 62ch;
    }
  }
  /* Téléphone : l'action de l'écran passe sous le titre, pleine largeur, sous le pouce. */
  @media (max-width: 899px) {
    .screen .act {
      flex: 1 1 100%;
    }
    .screen .act :global(.btn) {
      flex: 1;
    }
  }
</style>
