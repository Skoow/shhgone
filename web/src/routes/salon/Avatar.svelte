<script lang="ts">
  // Photo de profil d'un participant (v3 §7.2) : la photo qu'il a annoncée pour ce salon (pièce
  // chiffrée, déchiffrée sur l'appareil, salon.svelte.ts avatarDe), sinon l'initiale de son
  // pseudonyme sur sa couleur (avatar par défaut de la spécification). Pastille de présence
  // (v3 §14.1) : verte en ligne, rouge hors ligne ; décorative, l'état est toujours dit en texte à
  // côté (jamais la couleur seule). Décoratif en entier : aria-hidden.
  import * as S from "../../salon/salon.svelte";

  // `photo` faux : l'initiale seulement (message d'un siège redonné depuis : la photo serait celle
  // de la personne qui l'occupe maintenant).
  type Props = { siege: number; nom: string; taille?: number; enLigne?: boolean | null; photo?: boolean };
  let { siege, nom, taille = 32, enLigne = null, photo = true }: Props = $props();

  const url = $derived(photo ? (void S.vue.rev, S.avatarUrl(siege)) : null);
  const initiale = $derived([...nom.trim()][0]?.toLocaleUpperCase() ?? "");
  // Photo annoncée : lue et déchiffrée une fois (avatarDe ne relit pas une photo déjà là).
  $effect(() => {
    void S.vue.rev;
    if (photo) void S.avatarDe(siege);
  });
</script>

<span class={["avatar", { absent: enLigne === false }]} style:--t="{taille}px" aria-hidden="true">
  {#if url}<img src={url} alt="" />{:else}<span class="ini">{initiale}</span>{/if}
  {#if enLigne !== null}<span class={["point", enLigne ? "en" : "hors"]}></span>{/if}
</span>

<style>
  .avatar {
    position: relative;
    display: inline-grid;
    place-items: center;
    flex: none;
    width: var(--t);
    height: var(--t);
    border-radius: 50%;
    background: var(--pc, var(--surface-3));
    box-shadow: 0 0 0 1.5px var(--pc, var(--hair-2));
    color: var(--on-fmt);
    font-weight: 700;
    font-size: calc(var(--t) * 0.42);
    line-height: 1;
  }
  img {
    display: block;
    width: 100%;
    height: 100%;
    border-radius: 50%;
    object-fit: cover;
  }
  .absent img {
    filter: saturate(0.55);
    opacity: 0.8;
  }
  .point {
    position: absolute;
    right: -2px;
    bottom: -2px;
    width: max(10px, calc(var(--t) * 0.3));
    height: max(10px, calc(var(--t) * 0.3));
    box-sizing: border-box;
    border-radius: 50%;
    border: 2px solid var(--bg);
  }
  .point.en {
    background: var(--accent);
  }
  .point.hors {
    background: #ff5f5f;
  }
  @media (forced-colors: active) {
    .avatar {
      border: 1px solid CanvasText;
    }
    .point {
      background: CanvasText;
    }
  }
</style>
