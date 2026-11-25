<script lang="ts">
  // Sur ordinateur (décision du 25 novembre, conception du compte §18) : ce qui va se passer quand
  // le navigateur montre son QR « utiliser un téléphone ». Texte seul ; l'icône est un décor.
  import { QrCode } from "../../ui/Icon";

  let { texte }: { texte: string } = $props();
</script>

<p class="indice-qr" data-indice-qr>
  <span class="ic" aria-hidden="true"><QrCode size={20} strokeWidth={1.8} /></span>
  <span>{texte}</span>
</p>

<style>
  .indice-qr {
    display: flex;
    align-items: flex-start;
    gap: var(--sp-3);
    margin: 0;
    padding: var(--sp-3) var(--sp-4);
    border: 1px solid var(--hair-2);
    border-radius: 12px;
    background: rgb(255 255 255 / 0.03);
    color: var(--text-2);
    font-size: var(--fs-small);
    line-height: 1.5;
    text-wrap: pretty;
  }
  .ic {
    display: grid;
    flex: none;
    place-items: center;
    width: 32px;
    height: 32px;
    border-radius: 9px;
    background: var(--accent-tint);
    color: var(--accent);
  }
  @media (forced-colors: active) {
    .indice-qr {
      border-color: CanvasText;
    }
  }
</style>
