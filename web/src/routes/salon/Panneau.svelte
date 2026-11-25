<script lang="ts">
  // Panneau « Paramètres du salon » (participants, règle d'effacement, gestion, quitter) : ouvert
  // par le bouton de l'en-tête de la conversation, fermé par la croix, Échap ou un clic à côté.
  // <dialog> modal natif (comme ui/Sheet.svelte) : inertie du reste de la page, focus piégé,
  // Échap ; le focus revient au bouton qui l'a ouvert. Ordinateur : panneau latéral à droite, de
  // toute la hauteur ; téléphone et tablette : feuille du bas. Mouvement coupé sous mouvement réduit.
  import type { Snippet } from "svelte";
  import { t } from "../../i18n/i18n.svelte";
  import { X } from "../../ui/Icon";
  import IconButton from "../../ui/IconButton.svelte";

  type Props = { open: boolean; id: string; title: string; children: Snippet };
  let { open = $bindable(false), id, title, children }: Props = $props();

  let dlg: HTMLDialogElement | undefined = $state();
  let opener: Element | null = null;

  $effect(() => {
    if (!dlg) return;
    if (open && !dlg.open) {
      opener = document.activeElement;
      dlg.showModal();
    } else if (!open && dlg.open) dlg.close();
  });

  function closed(): void {
    open = false;
    const back = opener;
    opener = null;
    if (back instanceof HTMLElement && back.isConnected) back.focus();
  }

  function cote(e: MouseEvent): void {
    // Clic sur le fond (::backdrop) : la cible est le <dialog> lui-même, hors de son cadre.
    if (e.target !== dlg || !dlg) return;
    const r = dlg.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) dlg.close();
  }
</script>

<dialog bind:this={dlg} {id} class="panneau" aria-labelledby="{id}-t" onclose={closed} onclick={cote}>
  {#if open}
    <div class="tete">
      <h2 id="{id}-t">{title}</h2>
      <IconButton label={t("common.close")} onpress={() => dlg?.close()}><X size={20} strokeWidth={1.75} /></IconButton>
    </div>
    <div class="corps">{@render children()}</div>
  {/if}
</dialog>

<style>
  .panneau {
    box-sizing: border-box;
    position: fixed;
    inset: 0 0 0 auto;
    width: min(400px, 100vw);
    max-width: 100vw;
    height: 100dvh;
    max-height: 100dvh;
    margin: 0;
    padding: 0;
    border: 0;
    border-radius: 20px 0 0 20px;
    background: var(--surface-1);
    color: var(--text);
    box-shadow:
      inset 1px 0 0 var(--hair-2),
      -24px 0 64px -24px rgb(0 0 0 / 0.7);
    overflow: hidden;
    overscroll-behavior: contain;
  }
  .panneau[open] {
    display: flex;
    flex-direction: column;
    animation: entre 320ms var(--ease-view);
  }
  .panneau::backdrop {
    background: rgb(4 5 8 / 0.55);
  }
  .panneau[open]::backdrop {
    animation: fond 320ms var(--ease-view);
  }
  .tete {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--sp-3);
    padding: var(--sp-4) var(--sp-4) var(--sp-3) var(--sp-5);
    box-shadow: 0 1px 0 var(--hair);
  }
  .tete h2 {
    margin: 0;
    min-width: 0;
    font-size: var(--fs-title, 1.25rem);
    overflow-wrap: anywhere;
  }
  .tete > :global(button) {
    flex-shrink: 0;
  }
  .corps {
    flex: 1;
    min-height: 0;
    overflow: auto;
    overscroll-behavior: contain;
    padding: var(--sp-4) var(--sp-5) calc(var(--sp-6) + env(safe-area-inset-bottom, 0px));
  }
  @keyframes entre {
    from {
      opacity: 0;
      transform: translateX(32px);
    }
  }
  @keyframes fond {
    from {
      opacity: 0;
    }
  }
  /* Téléphone et tablette : feuille ancrée en bas, avec sa poignée (comme ui/Sheet.svelte). */
  @media (max-width: 899px) {
    .panneau {
      inset: auto 0 0 0;
      width: 100%;
      height: auto;
      max-height: 88dvh;
      border-radius: 20px 20px 0 0;
      box-shadow:
        inset 0 1px 0 var(--hair-2),
        0 -24px 64px -24px rgb(0 0 0 / 0.7);
    }
    .panneau::before {
      content: "";
      position: absolute;
      top: 8px;
      left: 50%;
      width: 36px;
      height: 4px;
      margin-left: -18px;
      border-radius: 2px;
      background: rgb(233 236 242 / 0.22);
    }
    .panneau[open] {
      animation-name: monte;
    }
    .tete {
      padding: var(--sp-5) var(--sp-3) var(--sp-3) var(--sp-4);
    }
    .corps {
      padding-inline: max(var(--sp-4), env(safe-area-inset-left, 0px)) max(var(--sp-4), env(safe-area-inset-right, 0px));
    }
  }
  @keyframes monte {
    from {
      transform: translateY(100%);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .panneau[open],
    .panneau[open]::backdrop {
      animation: fond var(--dur-instant) linear;
    }
  }
  @media (forced-colors: active) {
    .panneau {
      border: 1px solid CanvasText;
    }
  }
</style>
