<script module lang="ts">
  // Ancre de section dans l'adresse (« /#faq », « /#comment ») : lue au chargement du module,
  // avant que l'application ne retire tout « # » de la barre (App.svelte, le « # » est réservé aux
  // clés) ; l'accueil y défile une fois monté. Liste fermée : aucun autre fragment n'est lu.
  const ANCRES = ["faq", "comment"] as const;
  const ancre = typeof location === "undefined" ? null : (ANCRES.find((a) => location.hash === `#${a}`) ?? null);
  // Plus d'entrée animée : l'accueil est écrit au build et affiché avant le
  // script (référencement) ; le titre s'affiche d'emblée dans son état final.

  /** D'où viennent les fichiers remis à `onfiles` (composer.add). */
  export type Source = "fichiers" | "photo" | "video" | "depot";
  /** Actions qui ouvrent une interface dans la page. */
  export type Action = "media" | "vocal" | "texte";
</script>

<script lang="ts">
  // Accueil : sur-titre, titre, phrase, deux
  // boutons (« Choisir des fichiers » ouvre le sélecteur du composeur ; « Ouvrir un salon »,
  // bientôt), ligne de méta lue dans limits.ts ; l'infographie animée à côté (ordinateur) ou
  // dessous (téléphone) ; puis « Comment ça marche », « Pensé pour la
  // confidentialité », « Offres » et les questions. Voile de dépôt pleine page : un dépôt ouvre
  // le composeur avec ses fichiers. Un clic sur le verre n'ouvre rien.
  // Page d'envoi (`compact`) : trois assurances ; le Salon est avec les actions du composeur.
  import type { Snippet } from "svelte";
  import { dragDepth, dragHasFiles, filesFromDrop } from "../flows/intake";
  import { formatBytes } from "../i18n/format";
  import { t, getLang } from "../i18n/i18n.svelte";
  import { CONTENT_MAX, MAX_ITEMS } from "../limits";
  import DropOverlay from "../ui/DropOverlay.svelte";
  import { Camera, MessagesSquare, Mic, Upload } from "../ui/Icon";
  import Vessel from "../ui/Vessel.svelte";
  import Faq from "./home/Faq.svelte";
  import Sections from "./home/Sections.svelte";
  import { reprendreSection } from "../ui/section";
  import { onMount } from "svelte";

  // Section demandée depuis une autre page (rechargement complet) : ui/section.ts.
  onMount(reprendreSection);
  onMount(() => {
    if (ancre === null) return;
    requestAnimationFrame(() => document.getElementById(ancre)?.scrollIntoView({ block: "start" }));
  });

  type Props = {
    /** Vrai dès qu'un élément est ajouté : le titre se replie (UI §9.1), le reste de l'accueil part. */
    compact?: boolean;
    /** Le composeur, posé dans le réceptacle. Sans lui, le réceptacle vide. */
    children?: Snippet;
    /** Fichiers choisis ou déposés (composer.add) ; `folders` : dossiers déposés, refusés. */
    onfiles?: (files: File[], source: Source, folders: string[]) => void;
    /** Faux pendant un envoi : le glisser-déposer n'ouvre pas le voile et n'ajoute rien (S9). */
    active?: boolean;
    /** « Choisir des fichiers » (héros) : ouvre directement le sélecteur de fichiers du composeur. */
    onpick?: () => void;
    /** « Ou créez sur place » (héros) : page d'envoi, ce geste déjà choisi. */
    onmake?: (g: "media" | "vocal" | "room") => void;
  };
  let { compact = false, children, onfiles, active = true, onpick, onmake }: Props = $props();
  // Onglet caché : les boucles d'ambiance de l'accueil (titre en trame, panneau chiffré) s'arrêtent.

  // « puis plus rien. » effacé vers la dernière lettre (proposition G) : affiché
  // d'emblée dans cet état, sans entrée ni extinction animée ; chaque lettre plus pâle que la précédente, le point final invisible. La phrase
  // entière reste lue d'un bloc (copie sr-only, K8).

  /**
   * Seconde ligne du titre (après la dernière virgule, « puis », « then ») : chaque lettre et son
   * rang (`k`), qui décale son effacement en trame.
   */
  const words = $derived.by(() => {
    const list = t("hero.title").split(/ +/);
    let breath = -1;
    list.forEach((w, i) => {
      if (w.endsWith(",") && i < list.length - 1) breath = i;
    });
    // « puis » reste plein, seuls « plus rien. » se défont (maquette « La trame »).
    const hl = (i: number) => breath >= 0 && i > breath + 1;
    let seen = 0;
    // Seconde ligne colorée (référence) : « puis plus rien. ».
    return list.map((w, i) => ({
      w,
      hl: hl(i),
      br: breath >= 0 && i === breath + 1,
      letters: hl(i)
        ? [...w].map((c) => {
            const k = seen++;
            return { c, k };
          })
        : [],
    }));
  });

  const nLetters = $derived(words.reduce((n, w) => n + w.letters.length, 0));
  /**
   * État figé de chaque lettre de « plus rien. » (plus d'animation,
   * le titre reste effacé) : du début à la fin, points blancs serrés, points blancs, points menthe,
   * puis points qui s'envolent (maquette « La trame »). Calculé sur la position, toute langue.
   */
  const stage = (k: number) => {
    const f = nLetters > 1 ? k / (nLetters - 1) : 1;
    return f < 0.12 ? "s1" : f < 0.45 ? "s2" : f < 0.78 ? "s3" : "s4";
  };

  // Accroche coupée autour des mots mis en avant (sans HTML dans les textes).
  const lede = $derived.by(() => {
    const marks: Record<string, string> = { "\u0000": t("hero.lede.voice"), "\u0001": t("hero.lede.notes"), "\u0002": t("hero.lede.room") };
    // Salon en service (__SALONS__) : plus de « bientôt ».
    return t(__SALONS__ ? "hero.lede2.salon" : "hero.lede2", { voice: "\u0000", notes: "\u0001", room: "\u0002" })
      .split(/(\u0000|\u0001|\u0002)/)
      .map((p) => (p in marks ? { b: marks[p]! } : { s: p }));
  });

  // Ligne de méta : la limite gratuite vient de limits.ts (jamais écrite dans les textes).
  // « 2 Go » n'est écrit qu'une fois, sous le bouton du cadre.
  const meta = $derived([t("hero.meta.free"), t("home.fact.account"), t("hero.meta.erase")]);

  function give(list: File[], source: Source, folders: string[] = []) {
    if (list.length > 0 || folders.length > 0) onfiles?.(list, source, folders);
  }

  // UI §9.2.2 : glisser de fichiers sur toute la page ; compteur contre le clignotement ;
  // fermeture au dépôt, à Échap, à la fin du glisser. Les dossiers sont refusés, pas aplatis.
  const depth = dragDepth();
  let over = $state(false);
  function close() {
    depth.reset();
    over = false;
  }
  function dragenter(e: DragEvent) {
    if (!active || !dragHasFiles(e)) return;
    e.preventDefault();
    over = depth.enter(e);
  }
  function dragover(e: DragEvent) {
    if (!dragHasFiles(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
  }
  function dragleave(e: DragEvent) {
    if (!dragHasFiles(e)) return;
    over = depth.leave(e);
  }
  function drop(e: DragEvent) {
    if (!active || !dragHasFiles(e)) return;
    e.preventDefault();
    close();
    void filesFromDrop(e.dataTransfer!).then(({ files, folders }) => give(files, "depot", folders));
  }
</script>


<svelte:window
  ondragenter={dragenter}
  ondragover={dragover}
  ondragleave={dragleave}
  ondrop={drop}
  ondragend={close}
  onkeydown={(e) => e.key === "Escape" && over && close()}
/>

<div class={["home", { compact }]}>
  <section class="hero" aria-labelledby="hero-title">
    {#if compact}
      <!-- Page d'envoi : un titre pour les lecteurs
           d'écran (« Votre envoi » est le titre visible). Les assurances (gratuit, sans compte,
           effacement) ne sont dites qu'une fois, sous le héros de l'accueil (25 novembre). -->
      <h1 id="hero-title" tabindex="-1" class="sr-only">{t("send.h1")}</h1>
    {:else}
        <div class="pitch">
          <h1 id="hero-title" tabindex="-1">
            <!-- K8 : phrase entière pour les lecteurs d'écran, copie animée cachée. -->
            <span class="sr-only">{t("hero.title")}</span>
            <span class="words" aria-hidden="true">
              {#each words as { w, hl, br, letters }, i (i)}{#if br}<br />{/if}<span class={["w", { hl }]}
                  >{#if letters.length}{#each letters as { c, k }, j (j)}<span class="l {stage(k)}" data-c={c}><span class="g">{c}</span></span>{/each}{:else}{w}{/if}</span
                >{" "}{/each}
            </span>
          </h1>
          <!-- Accroche : « fichiers » en général, et ce qu'on ne devine pas sans bouton
               exprès mis en avant : vocaux, notes, salon de discussion. -->
          <p class="lede" data-lede>
            {#each lede as p, i (i)}{#if "b" in p}<b class="hl">{p.b}</b>{:else}{p.s}{/if}{/each}
          </p>
        </div>
        <!-- Cadre d'envoi : la zone de dépôt (titre, « Choisir des fichiers ») puis
             « Ou créez sur place » : Photo ou vidéo, Vocal, Salon, sur une ligne. Chaque bouton mène à
             la page d'envoi avec son geste déjà choisi (Salon : bientôt, mis en avant là-bas). -->
      <div class={["ctas", "box", { over }]} data-ctas>
        <!-- Zone de dépôt : pointillé menthe autour du titre et du bouton. -->
        <div class="drop">
          <span class="up" aria-hidden="true"><Upload size={22} strokeWidth={2.2} /></span>
          <p class="bx-t" aria-hidden="true">{t("hero.box.title")}</p>
          <button type="button" class="pick" data-pick onclick={() => onpick?.()}>
            <Upload size={20} strokeWidth={2.2} aria-hidden="true" />
            <span>{t("hero.pick")}</span>
          </button>
          <p class="bx-s num">{t("hero.box.limits", { n: MAX_ITEMS, size: formatBytes(CONTENT_MAX, getLang()) })}</p>
        </div>
        <div class="bx-r" role="group" aria-labelledby="hero-make">
          <p class="bx-h" id="hero-make">{t("hero.make")}</p>
          <div class="mk3">
            <button type="button" class="mk" data-make="media" onclick={() => onmake?.("media")}><Camera size={22} strokeWidth={1.9} aria-hidden="true" /><span>{t("nav.share.media.t")}</span></button>
            <button type="button" class="mk" data-make="vocal" onclick={() => onmake?.("vocal")}><Mic size={22} strokeWidth={1.9} aria-hidden="true" /><span>{t("nav.share.vocal.t")}</span></button>
            <!-- Salon : création avec __SALONS__ ; « bientôt » sinon (démo, site sans compte). -->
            <button type="button" class={["mk", { soon: !__SALONS__ }]} data-make="room" aria-describedby={__SALONS__ ? undefined : "hero-room-soon"} onclick={() => onmake?.("room")}
              ><MessagesSquare size={22} strokeWidth={1.9} aria-hidden="true" /><span>{t("nav.room")}</span>{#if !__SALONS__}<span class="pill">{t("foot.soon")}</span>{/if}</button
            >
            {#if !__SALONS__}<span id="hero-room-soon" class="sr-only">{t("tabs.soon.chat")}</span>{/if}
          </div>
        </div>
      </div>
        <ul class="meta" aria-label={t("home.facts.label")} data-meta>
          {#each meta as m, i (i)}<li>{m}</li>{/each}
        </ul>
      <!-- L'infographie animée a sa propre section, avec ses étapes ; le cadre
           d'envoi est à droite du titre (maquette « La trame »). -->
    {/if}
  </section>

  <!-- Plus de bande d'engagements : la sécurité et la confidentialité sont dites
       dans leurs pages. -->

  <!-- Le composeur (page d'envoi) seulement : plus de carte de dépôt « Glissez vos fichiers ici »
       sur l'accueil (doublon de « Choisir des fichiers » ; le dépôt sur toute la page
       reste possible). -->
  {#if children}
    <div class="compose" data-slot="compose">
      <Vessel empty={false} drop={over}>
        {@render children()}
      </Vessel>
    </div>
  {/if}

  {#if !compact}
    <Sections />
    <Faq />
  {/if}
</div>

<DropOverlay open={over} />

<style>
  .home {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
  }

  /* ---------- Héros : texte centré, infographie dessous (téléphone), à droite (ordinateur) ---------- */
  .hero {
    position: relative;
    isolation: isolate;
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: var(--sp-6);
    padding-block: var(--sp-4) var(--sp-6);
  }
  /* Halo : menthe et bleu derrière l'infographie, lumière fixe (rien ne bouge). */
  .home:not(.compact) .hero::before {
    content: "";
    position: absolute;
    z-index: -1;
    inset: -80px 0 0;
    pointer-events: none;
    background:
      radial-gradient(38% 46% at 74% 42%, rgb(95 227 181 / 0.08), transparent 70%),
      radial-gradient(30% 40% at 62% 62%, rgb(95 227 181 / 0.05), transparent 70%);
  }
  /* Les points du titre s'envolent vers la droite : jamais de défilement horizontal. */
  .home:not(.compact) .hero {
    overflow-x: clip;
  }
  .pitch {
    display: grid;
    justify-items: start;
    gap: var(--sp-4);
    min-width: 0;
  }
  .pitch > * {
    max-width: 100%;
  }
  h1 {
    margin: 0;
    font-size: clamp(2.5rem, 0.8rem + 3.7vw, 5.5rem);
    line-height: 0.98;
    font-weight: 700;
    font-stretch: var(--wd-display);
    letter-spacing: -0.04em;
    max-width: 13ch;
    /* Texte agrandi sur téléphone : un mot plus large que l'écran se coupe au lieu de déborder. */
    overflow-wrap: break-word;
    min-width: 0;
    text-wrap: balance;
    view-transition-name: hero-title;
    /* Les points de « n. » partent vers la droite : coupés au bord du titre, jamais hors de l'écran. */
    overflow-x: clip;
  }
  h1:focus {
    outline: none;
  }
  .w {
    display: inline-block;
  }
  .lede {
    margin: 0;
    max-width: 48ch;
    overflow-wrap: break-word;
    color: #aab6d3;
    font-size: 1.0625rem;
    line-height: 1.55;
    text-wrap: pretty;
  }
  /* Cadre d'envoi : la zone de dépôt, en pointillé menthe, entoure le titre et le
     bouton ; les trois gestes « Ou créez sur place » sur une ligne dessous. */
  .box {
    display: grid;
    gap: var(--sp-3);
    width: 100%;
    max-width: 44rem;
    padding: var(--sp-3);
    border-radius: var(--r-2xl);
    background: linear-gradient(180deg, rgb(255 255 255 / 0.045), rgb(255 255 255 / 0.015)), rgb(17 20 27 / 0.9);
    box-shadow:
      inset 0 0 0 1px rgb(233 236 242 / 0.12),
      0 24px 60px -30px rgb(0 0 0 / 0.7);
  }
  .drop {
    display: grid;
    justify-items: center;
    gap: var(--sp-3);
    padding: var(--sp-5) var(--sp-4) var(--sp-4);
    border: 2px dashed rgb(95 227 181 / 0.45);
    border-radius: var(--r-xl);
    background: radial-gradient(80% 90% at 50% 0%, rgb(95 227 181 / 0.09), transparent 75%), rgb(95 227 181 / 0.025);
    text-align: center;
    transition: border-color var(--dur-fast) var(--ease-out), background-color var(--dur-fast) var(--ease-out);
  }
  .box.over .drop {
    border-color: var(--accent);
    background-color: rgb(95 227 181 / 0.1);
  }
  .up {
    display: grid;
    place-items: center;
    width: 48px;
    height: 48px;
    border-radius: 50%;
    background: var(--accent);
    color: var(--on-accent);
    box-shadow: 0 0 28px -4px rgb(95 227 181 / 0.6);
  }
  .bx-r {
    display: grid;
    justify-items: center;
    gap: var(--sp-3);
    min-width: 0;
  }
  .bx-t {
    margin: 0;
    font-size: clamp(1.25rem, 1.05rem + 0.6vw, 1.625rem);
    font-weight: 700;
    letter-spacing: -0.02em;
  }
  .bx-s {
    margin: 0;
    color: var(--text-3);
    font-family: var(--font-mono);
    font-size: var(--fs-micro);
  }
  .bx-h {
    margin: 0;
    color: var(--text-2);
    font-size: var(--fs-small);
  }
  .pick {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: var(--sp-2);
    min-height: 56px;
    padding: 0 var(--sp-6);
    border: 0;
    border-radius: var(--r-lg);
    background: var(--accent);
    color: var(--on-accent);
    font: inherit;
    font-size: 1.0625rem;
    font-weight: 650;
    cursor: pointer;
    box-shadow: 0 12px 30px -14px rgb(95 227 181 / 0.7);
    transition: background-color var(--dur-fast) var(--ease-out), transform var(--dur-fast) var(--ease-out);
  }
  .pick:hover {
    background: var(--accent-hover, #7eebc4);
  }
  .pick:active {
    transform: scale(0.98);
  }
  .pick:focus-visible,
  .mk:focus-visible {
    outline: 2px solid var(--text);
    outline-offset: 3px;
  }
  /* Toujours trois colonnes : Photo ou vidéo, Vocal, Salon côte à côte. */
  .mk3 {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: var(--sp-2);
    width: 100%;
  }
  .mk {
    position: relative;
    display: grid;
    justify-items: center;
    align-content: center;
    gap: 6px;
    min-height: 80px;
    padding: var(--sp-3) var(--sp-2);
    border: 0;
    border-radius: var(--r-lg);
    background: rgb(255 255 255 / 0.05);
    box-shadow: inset 0 0 0 1px rgb(233 236 242 / 0.1);
    color: var(--text);
    font: inherit;
    font-size: var(--fs-small);
    font-weight: 600;
    text-align: center;
    overflow-wrap: anywhere;
    cursor: pointer;
    transition: background-color var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out);
  }
  .mk :global(svg) {
    color: var(--accent);
  }
  .mk:hover {
    background: rgb(95 227 181 / 0.08);
    box-shadow: inset 0 0 0 1px rgb(95 227 181 / 0.4);
  }
  .mk.soon {
    color: var(--text-2);
  }
  .mk.soon :global(svg) {
    color: var(--text-3);
  }
  .pill {
    padding: 1px 7px;
    border-radius: var(--r-pill);
    background: rgb(95 227 181 / 0.12);
    color: var(--accent);
    font-size: 0.6875rem;
    font-weight: 600;
  }
  /* Téléphone : tout le cadre tient dans le premier écran d'un iPhone ; ni pastille ni « Glissez vos
     fichiers ici » (on ne glisse pas de fichier sur un téléphone) ; bouton pleine largeur. */
  @media (max-width: 639px) {
    .box {
      gap: var(--sp-3);
      padding: var(--sp-3);
    }
    .drop {
      padding: var(--sp-3);
      gap: var(--sp-2);
    }
    .up,
    .bx-t {
      display: none;
    }
    .pick {
      width: 100%;
      min-height: 52px;
    }
    .mk {
      min-height: 72px;
      padding-block: var(--sp-2);
    }
  }
  @media (max-width: 767px) {
    /* Le bloc « Que voulez-vous envoyer ? » ne reste que sur la page d'envoi. */
    .home:not(.compact) .compose {
      display: none;
    }
  }
  /* Tuile « Choisir des fichiers » : verre sombre, contour en pointillé menthe (une
     zone de dépôt), pastille d'icône menthe, titre et « ou glissez-les ici », flèche. */
  /* Les trois assurances sur une seule ligne : une capsule discrète,
     séparées par un point menthe ; plus de cases cochées. */
  .meta {
    display: inline-flex;
    /* Toujours une seule ligne (« plus petit, sur une ligne »). */
    flex-wrap: nowrap;
    justify-content: center;
    align-items: center;
    justify-self: start;
    gap: 0;
    max-width: 100%;
    margin: var(--sp-1) 0 0;
    padding: 6px 14px;
    border-radius: var(--r-pill);
    background: rgb(95 227 181 / 0.06);
    box-shadow: inset 0 0 0 1px rgb(95 227 181 / 0.22);
    list-style: none;
    color: #c4cde3;
    font-size: 0.8125rem;
    font-weight: 550;
    white-space: nowrap;
  }
  .meta li {
    white-space: nowrap;
  }
  .meta li + li::before {
    content: "";
    display: inline-block;
    width: 5px;
    height: 5px;
    margin-inline: 12px;
    border-radius: 50%;
    background: var(--accent);
    vertical-align: middle;
    transform: translateY(-1px);
  }
  
  /* Page d'envoi : le titre visible, plus petit, à gauche ; trois
     assurances dessous ; le Salon à droite (ordinateur) ou dessous (téléphone). */
  .home.compact .hero {
    padding-top: 0;
    padding-bottom: var(--sp-2);
    gap: var(--sp-3);
  }
  .home.compact .compose {
    order: 2;
  }
  /* Salon (bientôt) : à part des actions d'envoi, désactivé mais lisible. */


  /* « Commencer » (page d'envoi) : bouton contour ; le blanc plein reste au héros. */

  

  /* Téléphone : « Ajouter » remplace « Commencer » et la rangée de tuiles (aucun doublon). */
  
  @media (max-width: 759px) {
    
    
    
    
    
    
    
    
    /* Composeur : un écran d'app, pas une carte dans la page (ni cadre, ni liseré). */
    .home.compact .compose :global(.vessel) {
      background: transparent;
      box-shadow: none;
    }
    .home.compact .compose :global(.vessel > .line) {
      display: none;
    }
  }
  /* Composeur sur ordinateur : la carte a un contour entier ; l'ouverture
     de la capsule (motif du logo) laissait le haut sans bord, de la gauche jusqu'au milieu. Le
     dépôt garde son ouverture resserrée. */
  .home.compact .compose :global(.vessel:not(.drop) .track) {
    stroke-dasharray: none;
  }
  @keyframes flash {
    30% {
      opacity: 0.9;
    }
    100% {
      opacity: 0;
    }
  }
  @keyframes rec {
    50% {
      opacity: 1;
    }
  }
  @keyframes level {
    to {
      transform: scaleY(1);
    }
  }
  @keyframes caret {
    0% {
      opacity: 1;
    }
    50% {
      opacity: 0;
    }
  }

  


  /* ---------- Carte de dépôt : le composeur vide ---------- */
  .compose {
    position: relative;
    isolation: isolate;
    min-width: 0;
  }
  .home:not(.compact) .compose {
    width: 100%;
    max-width: 880px;
    margin-inline: auto;
  }

  /* « plus rien. » figé dans son effacement (aucune animation) :
     trame de points de plus en plus fine, blanche puis menthe ; les deux dernières lettres partent
     en points vers la droite (deux copies de la lettre, data-c, hors du masque). Masques CSS seuls. */
  .l {
    position: relative;
    display: inline-block;
  }
  .g {
    display: inline-block;
    --r: 4px;
    -webkit-mask-image: radial-gradient(circle, #000 var(--r), transparent calc(var(--r) + 0.7px));
    mask-image: radial-gradient(circle, #000 var(--r), transparent calc(var(--r) + 0.7px));
    -webkit-mask-size: 5px 5px;
    mask-size: 5px 5px;
  }
  /* Plus effacé : la trame s'affine plus vite, « rie » commence à partir en
     points, « n. » n'est presque plus que poussière. */
  /* Plus lisible (« qu'on voie mieux le mot ») : trame plus pleine,
     menthe franche ; seule la dernière lettre part vraiment en poussière. */
  .s1 .g {
    --r: 2.6px;
  }
  .s2 .g {
    --r: 2.3px;
  }
  .s3 .g {
    --r: 2px;
    color: var(--accent);
  }
  .s4 .g {
    --r: 1.6px;
    color: var(--accent);
    opacity: 0.8;
  }
  .s3::before,
  .s4::before,
  .s4::after {
    content: attr(data-c);
    position: absolute;
    inset: 0;
    color: var(--accent);
    pointer-events: none;
    -webkit-mask-image: radial-gradient(circle, #000 1.1px, transparent 1.8px);
    mask-image: radial-gradient(circle, #000 1.1px, transparent 1.8px);
    -webkit-mask-size: 9px 8px;
    mask-size: 9px 8px;
  }
  .s3::before {
    transform: translate(0.18em, -0.05em);
    opacity: 0.25;
  }
  .s4::before {
    transform: translate(0.4em, -0.1em);
    opacity: 0.45;
  }
  .s4::after {
    -webkit-mask-size: 13px 11px;
    mask-size: 13px 11px;
    -webkit-mask-position: 5px 4px;
    mask-position: 5px 4px;
    transform: translate(0.85em, 0.12em);
    opacity: 0.25;
  }
  @media (forced-colors: active) {
    .g {
      -webkit-mask-image: none;
      mask-image: none;
    }
    .s3::before,
    .s4::before,
    .s4::after {
      display: none;
    }
  }
  /* Téléphone et tablette : titre, phrase, cadre puis assurances, centrés. */
  @media (max-width: 1023px) {
    .home:not(.compact) h1 {
      margin-inline: auto;
    }
    .home:not(.compact) .pitch {
      justify-items: center;
      text-align: center;
    }
    .home:not(.compact) .meta {
      justify-self: center;
    }
    .home:not(.compact) .box {
      justify-self: center;
    }
  }
  @media (max-width: 639px) {
    /* Assurances : toujours une ligne, le texte suit la largeur de l'écran (320 px compris). */
    .home:not(.compact) .meta {
      padding: 5px 10px;
      font-size: min(0.75rem, 2.8vw);
      letter-spacing: -0.01em;
    }
    .home:not(.compact) .meta li + li::before {
      width: 3px;
      height: 3px;
      margin-inline: 6px;
    }
    .home:not(.compact) .hero {
      gap: var(--sp-4);
      padding-block: var(--sp-3) var(--sp-6);
    }
    .home:not(.compact) .pitch {
      gap: var(--sp-3);
    }
    .home:not(.compact) h1 {
      font-size: clamp(2.125rem, 1.2rem + 4.6vw, 2.75rem);
    }
    .lede {
      font-size: 1rem;
      line-height: 1.5;
    }
  }
  /* Ordinateur : titre, phrase et assurances à gauche ; le cadre d'envoi à droite (maquette « La
     trame ») ; toute la largeur utile (« trop compressé »). */
  @media (min-width: 1024px) {
    .home:not(.compact) .hero {
      grid-template-columns: minmax(0, 1.1fr) minmax(0, 0.9fr);
      grid-template-areas:
        "pitch box"
        "meta box";
      align-items: center;
      column-gap: clamp(40px, 5vw, 96px);
      row-gap: var(--sp-5);
      min-height: min(calc(100svh - 76px - var(--banner-h, 0px)), 820px);
      padding-block: var(--sp-5) var(--sp-7);
    }
    .home:not(.compact) .pitch {
      grid-area: pitch;
      align-self: end;
    }
    .home:not(.compact) .box {
      grid-area: box;
      justify-self: end;
    }
    .home:not(.compact) .meta {
      grid-area: meta;
      align-self: start;
    }
    .home.compact .hero {
      grid-template-columns: minmax(0, 1fr);
      padding-block: 0;
    }
    .lede {
      font-size: 1.1875rem;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    
    .pick,
    .pick :global(svg){
      transition: none;
    }
    
    .pick:active,
    .pick:hover{
      transform: none;
    }
  }
  @media (forced-colors: active) {
    /* Le navigateur pose un fond plein derrière chaque ligne : avec un interligne < 1, celui de la
       ligne suivante masquait les jambages (« passe », « lien, »). */
    h1 {
      line-height: 1.15;
    }
    .home:not(.compact) .hero::before{
      display: none;
    }
    
    .pick,
    .mk {
      border: 1px solid ButtonText;
      box-shadow: none;
    }
    /* Le cadre d'envoi est la zone de dépôt : pointillé. */
    .box {
      border: 1px dashed CanvasText;
      box-shadow: none;
    }
  }
</style>
