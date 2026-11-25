<script lang="ts">
  // « Fichiers » du salon (v3 §14.6) : tous les fichiers, photos, vidéos, documents et vocaux
  // échangés, du plus récent au plus ancien, filtrés par type et par membre ; pour soi,
  // « Nouveau » tant qu'on ne l'a ni ouvert ni enregistré. Tout est calculé sur l'appareil à
  // partir des messages reçus : le serveur n'apprend rien de plus. Vide au renouvellement et à la fin.
  import { t, getLang, type Key } from "../../i18n/i18n.svelte";
  import { formatBytes, formatClock } from "../../i18n/format";
  import * as S from "../../salon/salon.svelte";
  import type { Bulle } from "../../salon/conversation";
  import Segmented from "../../ui/Segmented.svelte";
  import Button from "../../ui/Button.svelte";
  import { SvelteSet } from "svelte/reactivity";

  let { onvoir }: { onvoir: (cle: string) => void } = $props();
  const vue = S.vue;
  const conv = S.conversation()!;
  const lang = $derived(getLang());
  type Filtre = "tout" | "image" | "video" | "fichier" | "vocal";
  let filtre = $state<Filtre>("tout");
  let membre = $state<number | -1>(-1);
  const filtres = $derived((["tout", "image", "video", "fichier", "vocal"] as const).map((v) => ({ value: v, label: t(`salon.files.f.${v}` as Key) })));
  const nom = (s: number) => conv.nom(s).pseudo ?? t("salon.room.participant", { n: s + 1 });
  /** Auteur d'une pièce : nom figé si son siège a été redonné depuis. */
  const auteur = (b: Bulle) => conv.nomDe(b).pseudo ?? t("salon.room.participant", { n: b.siege + 1 });
  // Sélection multiple (v3 §14.3) : « Tout sélectionner », « Télécharger (N) » en une archive .zip.
  const choix = new SvelteSet<string>();
  let enCours = $state(false);
  let message = $state("");
  async function telecharger(): Promise<void> {
    enCours = true;
    message = "";
    const e = await S.telechargerArchive(liste.filter((b) => choix.has(b.cle)));
    enCours = false;
    if (e === null) choix.clear();
    else message = t(e === "trop_gros" ? "salon.files.zip.gros" : e === "indisponible" ? "salon.piece.err.indisponible" : e === "sortie" ? "salon.piece.err.sortie" : e === "relu" ? "salon.piece.err.relu" : "salon.piece.err.lecture");
  }
  const membres = $derived((void vue.rev, [{ value: -1, label: t("salon.files.tous") }, ...[...conv.presents].sort((a, b) => a - b).map((s) => ({ value: s, label: nom(s) }))]));
  const liste = $derived.by(() => {
    void vue.rev;
    return conv.elements
      .filter((e): e is Bulle => e.k === "bulle" && e.piece !== null && !e.retire)
      .filter((b) => (filtre === "tout" || b.piece!.sorte === filtre) && (membre === -1 || b.siege === membre))
      .map((b) => ({ ...b }))
      .reverse();
  });
  function nomFichier(b: Bulle): string {
    try {
      return S.moteur()?.nettoyerNom(b.piece!.nom) || t("salon.piece.sans.nom");
    } catch {
      return t("salon.piece.sans.nom");
    }
  }
</script>

<div class="fichiers">
  <Segmented label={t("salon.files.type")} options={filtres} bind:value={filtre} columns={3} />
  <Segmented label={t("salon.files.membre")} options={membres} bind:value={membre} columns={2} />
  {#if liste.length === 0}
    <p class="vide">{t("salon.files.vide")}</p>
  {:else}
    <div class="selection">
      <Button variant="ghost" dense onpress={() => {
          if (choix.size === liste.length) choix.clear();
          else for (const b of liste) choix.add(b.cle);
        }}>{choix.size === liste.length ? t("salon.files.aucun") : t("salon.files.tout")}</Button>
      <Button variant="secondary" dense disabled={choix.size === 0 || enCours} onpress={telecharger}>{t("salon.files.zip", { n: choix.size })}</Button>
    </div>
    {#if message}<p class="vide" role="status">{message}</p>{/if}
    <ul class="liste">
      {#each liste as b (b.cle)}
        <li>
          <input type="checkbox" class="coche" checked={choix.has(b.cle)} aria-label={t("salon.files.choisir", { nom: nomFichier(b) })} onchange={(e) => (e.currentTarget.checked ? choix.add(b.cle) : choix.delete(b.cle))} />
          {#if b.piece!.sorte === "image" && S.pieces.urls[b.cle]}<img src={S.pieces.urls[b.cle]} alt="" class="vign" />{/if}
          <div class="info">
            <bdi class="n">{nomFichier(b)}</bdi>
            <span class="m">{auteur(b)} · {formatClock(b.heureMs, lang)} · {formatBytes(b.piece!.taille, lang)}{#if !b.moi && !S.fichiersOuverts.has(b.cle)} · <strong>{t("salon.files.nouveau")}</strong>{/if}</span>
          </div>
          <div class="acts">
            <Button variant="ghost" dense onpress={() => (S.fichiersOuverts.add(b.cle), S.enregistrerPiece(b))}>{t("salon.piece.enregistrer")}</Button>
            <Button variant="ghost" dense onpress={() => onvoir(b.cle)}>{t("salon.files.voir")}</Button>
          </div>
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .fichiers {
    display: grid;
    gap: var(--sp-4);
  }
  .vide {
    color: var(--text-2);
  }
  .liste {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: var(--sp-3);
  }
  li {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--sp-3);
  }
  .selection {
    display: flex;
    flex-wrap: wrap;
    gap: var(--sp-2);
  }
  .coche {
    width: 24px;
    height: 24px;
    accent-color: var(--accent);
  }
  .vign {
    width: 56px;
    height: 56px;
    object-fit: cover;
    border-radius: 8px;
  }
  .info {
    display: grid;
    min-width: 0;
    flex: 1;
  }
  .n {
    font-weight: 560;
    overflow-wrap: anywhere;
  }
  .m {
    color: var(--text-2);
    font-size: 0.8125rem;
  }
  .acts {
    display: flex;
    gap: var(--sp-1);
  }
</style>
