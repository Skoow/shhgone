<script lang="ts">
  // Pièce d'un message (spec §39.5, v3 §4.4) : image et vocal de 16 Mo au plus
  // affichés d'office, vidéo au clic, tout fichier « Enregistrer » (octets bruts, nom nettoyé par
  // le moteur). Jamais de SVG ni de type hors liste dans la page ; adresses blob: révoquées à
  // l'effacement, au retrait et à la fin du salon (salon.svelte.ts).
  import { t, getLang } from "../../i18n/i18n.svelte";
  import { formatBytes, formatDuration } from "../../i18n/format";
  import * as S from "../../salon/salon.svelte";
  import { AFFICHE_MAX } from "../../salon/pieces";
  import type { Bulle } from "../../salon/conversation";
  import Button from "../../ui/Button.svelte";
  import { FileArchive, FileText } from "../../ui/Icon";

  let { b }: { b: Bulle } = $props();
  const p = $derived(b.piece!);
  const url = $derived(S.pieces.urls[b.cle]);
  const erreur = $derived(S.pieces.erreurs[b.cle]);
  const lang = $derived(getLang());
  const auto = $derived((p.sorte === "image" || p.sorte === "vocal") && p.taille <= AFFICHE_MAX);
  // Photo ou vidéo affichée : nom et taille en une ligne discrète sous la vignette, « Enregistrer » au bout.
  const media = $derived(!!url && (p.sorte === "image" || p.sorte === "video"));
  // Fichier (ni photo, ni vidéo, ni vocal affichés) : une ligne comme dans une messagerie,
  // icône, nom et taille, « Enregistrer » au bout.
  const fichier = $derived(p.sorte === "fichier");
  const archive = $derived(/zip|x-7z|x-rar|x-tar|gzip/.test(p.mime));
  let nom = $derived.by(() => {
    try {
      return S.moteur()?.nettoyerNom(p.nom) || t("salon.piece.sans.nom");
    } catch {
      return t("salon.piece.sans.nom");
    }
  });
  $effect(() => {
    if (auto && p.ref && !url) void S.afficherPiece(b);
  });
  const vitesses = [1, 1.5, 2] as const;
  let vitesse = $state<1 | 1.5 | 2>(1);
  let audio: HTMLAudioElement | undefined = $state();
  $effect(() => {
    if (audio) audio.playbackRate = vitesse;
  });
</script>

<div class={["piece", { media, fichier }]}>
  {#if url && p.sorte === "image"}
    <img src={url} alt={nom} class="img" onload={() => S.estVu(b) && S.accuserPiece(b, "piece_ouverte")} />
  {:else if url && p.sorte === "vocal"}
    <div class="vocal">
      <audio bind:this={audio} src={url} controls preload="metadata" onplay={() => S.accuserPiece(b, "piece_ouverte")}></audio>
      <div class="vit" role="group" aria-label={t("salon.piece.vitesse")}>
        {#each vitesses as v (v)}
          <button type="button" aria-pressed={vitesse === v} onclick={() => (vitesse = v)}>{v}×</button>
        {/each}
      </div>
    </div>
  {:else if url && p.sorte === "video"}
    <!-- svelte-ignore a11y_media_has_caption -->
    <video src={url} controls preload="metadata" class="img" onplay={() => S.accuserPiece(b, "piece_ouverte")}></video>
  {/if}
  {#if media}
    <div class="legende">
      <p class="lg"><bdi class="nom" title={nom}>{nom}</bdi><span class="sep" aria-hidden="true">·</span><span class="taille">{formatBytes(p.taille, lang)}{#if p.dureeMs} · {formatDuration(p.dureeMs / 1000, lang, { precise: true })}{/if}</span></p>
      {#if p.ref || b.moi}
        <Button variant="ghost" dense busy={S.pieces.lecture[b.cle] === true} onpress={() => S.enregistrerPiece(b)}>{t("salon.piece.enregistrer")}</Button>
      {/if}
    </div>
  {:else}
    {#if fichier}<span class="ficone" aria-hidden="true">{#if archive}<FileArchive size={20} />{:else}<FileText size={20} />{/if}</span>{/if}
    <p class="fic">
      <bdi class="nom">{nom}</bdi>
      <span class="taille">{formatBytes(p.taille, lang)}{#if p.dureeMs} · {formatDuration(p.dureeMs / 1000, lang, { precise: true })}{/if}</span>
    </p>
  {/if}
  {#if b.moi && (b.ouverts.length > 0 || b.telecharges.length > 0)}
    <!-- Accusés de nos pièces (v3 §14.2) : « Ouvert », « Téléchargé » (dans un groupe : par N / M). -->
    <p class="accuses">
      {#if b.ouverts.length > 0}<span>{b.attendus.length > 1 ? t("salon.piece.ouvert.par", { n: b.ouverts.length, total: b.attendus.length }) : t("salon.piece.ouvert")}</span>{/if}
      {#if b.telecharges.length > 0}<span>{b.attendus.length > 1 ? t("salon.piece.telecharge.par", { n: b.telecharges.length, total: b.attendus.length }) : t("salon.piece.telecharge")}</span>{/if}
    </p>
  {/if}
  {#if p.progres !== null && b.moi}
    <progress max="1" value={p.progres} aria-label={t("salon.piece.envoi", { nom })}></progress>
  {/if}
  {#if erreur}<p class="err" role="status">{t(`salon.piece.err.${erreur === "indisponible" || erreur === "sortie" || erreur === "relu" || erreur === "apercu" ? erreur : "lecture"}`)}</p>{/if}
  {#if !media}
    <div class="acts">
      {#if p.sorte === "video" && !url && p.ref}
        <Button variant="secondary" dense busy={S.pieces.lecture[b.cle] === true} onpress={() => S.afficherPiece(b)}>{t("salon.piece.lire")}</Button>
      {/if}
      {#if p.ref || b.moi}
        <Button variant="ghost" dense busy={S.pieces.lecture[b.cle] === true} onpress={() => S.enregistrerPiece(b)}>{t("salon.piece.enregistrer")}</Button>
      {/if}
    </div>
  {/if}
</div>

<style>
  .accuses {
    margin: 0;
    display: flex;
    gap: var(--sp-2);
    color: var(--text-2);
    font-size: 0.8125rem;
  }
  .piece {
    display: grid;
    gap: var(--sp-1);
    min-width: 0;
  }
  .img {
    display: block;
    max-width: 100%;
    max-height: 60vh;
    border-radius: 10px;
    background: var(--surface-3);
  }
  .vocal {
    display: grid;
    gap: var(--sp-1);
  }
  audio {
    width: min(100%, 320px);
  }
  .vit {
    display: flex;
    gap: var(--sp-1);
  }
  .vit button {
    min-width: 44px;
    min-height: 32px;
    border: 1px solid var(--line);
    border-radius: 999px;
    background: var(--surface-2);
    color: var(--text);
    cursor: pointer;
  }
  .vit button[aria-pressed="true"] {
    border-color: var(--accent);
  }
  .fic {
    margin: 0;
    display: flex;
    flex-wrap: wrap;
    gap: var(--sp-2);
  }
  .nom {
    font-weight: 560;
    overflow-wrap: anywhere;
  }
  .taille {
    color: var(--text-2);
    font-size: 0.8125rem;
  }
  .fichier {
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: center;
    column-gap: var(--sp-3);
    padding-top: 2px;
  }
  .fichier > * {
    grid-column: 1 / -1;
  }
  .fichier > .ficone {
    grid-column: 1;
    grid-row: 1;
  }
  .fichier > .fic {
    grid-column: 2;
    grid-row: 1;
    display: grid;
    gap: 0;
    min-width: 7em;
  }
  .fichier .nom {
    overflow-wrap: break-word;
  }
  .fichier > .acts {
    grid-column: 3;
    grid-row: 1;
  }
  .ficone {
    display: grid;
    place-items: center;
    width: 40px;
    height: 40px;
    border-radius: 10px;
    background: rgb(255 255 255 / 0.06);
    color: var(--text-2);
  }
  progress {
    width: 100%;
    accent-color: var(--accent);
  }
  .err {
    margin: 0;
    color: var(--warn);
    font-size: 0.8125rem;
  }
  .acts {
    display: flex;
    flex-wrap: wrap;
    gap: var(--sp-1);
  }
  /* Photo ou vidéo : la vignette donne la largeur ; la ligne du dessous (nom coupé · taille,
     « Enregistrer ») n'élargit pas la bulle (largeur 0, au moins celle de la vignette). */
  .media .img {
    min-width: min(200px, 100%);
    object-fit: contain;
  }
  .legende {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    width: 0;
    min-width: 100%;
  }
  .lg {
    display: flex;
    align-items: baseline;
    gap: 0.4em;
    flex: 1;
    min-width: 0;
    margin: 0;
    color: var(--text-2);
    font-size: 0.75rem;
    line-height: 1rem;
    white-space: nowrap;
  }
  .lg .nom {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    font-weight: 500;
  }
  .lg .sep,
  .lg .taille {
    flex: none;
    color: var(--text-3);
    font-size: inherit;
    font-variant-numeric: tabular-nums;
  }
  .legende :global(.btn) {
    flex: none;
    margin-inline-end: -8px;
  }
</style>
