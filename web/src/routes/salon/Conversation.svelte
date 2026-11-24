<script lang="ts">
  // Conversation du salon (spec §39.6, v3 §4, §6, §14.1, §14.2 ; plan C-3) : en-tête (en ligne,
  // places libres, échéance), fil en role="log", bulles (les siennes à droite), réponses,
  // réactions, modifier, retirer, coches envoyé / reçu / vu, « écrit », participants, saisie.
  // Tout le texte affiché vient du fil local (conversation.ts) : aucune interpolation HTML, liens
  // https? seulement, sans aperçu.
  import { onMount, tick, untrack } from "svelte";
  import { t, getLang } from "../../i18n/i18n.svelte";
  import { formatClock, formatDayTime, formatDuration } from "../../i18n/format";
  import { announce } from "../../ui/announce";
  import { routeTitle } from "../../app/title";
  import { morceaux, type Bulle, type Element } from "../../salon/conversation";
  import * as S from "../../salon/salon.svelte";
  import Button from "../../ui/Button.svelte";
  import InlineConfirm from "../../ui/InlineConfirm.svelte";
  import Sheet from "../../ui/Sheet.svelte";
  import Membres from "./Membres.svelte";
  import Emojis from "./Emojis.svelte";
  import Piece from "./Piece.svelte";
  import Fichiers from "./Fichiers.svelte";
  import Appel from "./Appel.svelte";
  import IconButton from "../../ui/IconButton.svelte";
  import VoiceRecorder from "../../ui/VoiceRecorder.svelte";
  import { Folder, Mic, Paperclip, Phone, Users, Video, Volume, VolumeX } from "../../ui/Icon";
  import { doitSonner, jouer, SILENCE_TOUJOURS } from "../../salon/son";
  import { SvelteSet } from "svelte/reactivity";

  const vue = S.vue;
  const conv = S.conversation()!;
  const lang = $derived(getLang());

  /** Copie du fil à chaque changement (les bulles sont modifiées sur place par conversation.ts). */
  const elements = $derived.by<Element[]>(() => {
    void vue.rev;
    return conv.elements.map((e) => (e.k === "bulle" ? { ...e, reactions: e.reactions.map((r) => ({ ...r })) } : { ...e }));
  });
  // Albums (v3 §14.3) : photos envoyées ensemble (même auteur, à la suite, à moins d'une minute
  // d'écart) affichées en grille. Chaque photo reste un message à part (accusés, réactions,
  // retrait, effacement) : seule la mise en page change. Calculé sur l'appareil.
  const albums = $derived.by(() => {
    const dans = new Map<string, "debut" | "suite">();
    let run: Bulle[] = [];
    const clore = () => {
      if (run.length >= 2) run.forEach((b, i) => dans.set(b.cle, i === 0 ? "debut" : "suite"));
      run = [];
    };
    for (const e of elements) {
      const img = e.k === "bulle" && !e.retire && e.piece?.sorte === "image" ? e : null;
      const prec = run.at(-1);
      if (img && prec && prec.siege === img.siege && prec.moi === img.moi && img.heureMs - prec.heureMs <= 60_000) run.push(img);
      else {
        clore();
        if (img) run.push(img);
      }
    }
    clore();
    return dans;
  });
  let maintenant = $state(Date.now());
  const ecrivent = $derived((void vue.rev, void maintenant, conv.ecrivent()));
  const enLigne = $derived((void vue.rev, [...conv.presents].filter((s) => conv.presence.get(s)?.enLigne).length));
  const libres = $derived((void vue.rev, Math.max(0, vue.places - conv.presents.size)));
  const reste = $derived(Math.max(0, (vue.finMs - maintenant) / 1000));
  const etatAppel = $derived((void vue.rev, S.appel()?.etat ?? "aucun"));

  function nom(siege: number): string {
    const n = conv.nom(siege);
    return n.pseudo ?? t("salon.room.participant", { n: n.numero });
  }
  /** Auteur d'un élément du fil : nom figé si son siège a été redonné depuis. */
  function nomDe(e: Element): string {
    const n = conv.nomDe(e);
    return n.pseudo ?? t("salon.room.participant", { n: n.numero });
  }

  let texte = $state("");
  let saisie: HTMLTextAreaElement | undefined = $state();
  let reponse = $state<Bulle | null>(null);
  let edition = $state<Bulle | null>(null);
  let menu = $state<string | null>(null);
  let emojis = $state(false);
  let membres = $state(false);
  let erreur = $state("");
  let enBas = $state(true);
  let nonLus = $state(0);

  const QUICK = ["👍", "❤️", "😂", "😮", "😢", "🙏"];

  // --- Pièces (plan C-4) -------------------------------------------------------------------------
  let fichiers = $state(false);
  let vocal = $state(false);
  let joindre: HTMLInputElement | undefined = $state();
  function choisis(): void {
    const l = [...(joindre?.files ?? [])];
    if (joindre) joindre.value = "";
    if (l.length > 0) void S.envoyerFichiers(l);
  }
  function deposer(e: DragEvent): void {
    const l = [...(e.dataTransfer?.files ?? [])];
    if (l.length === 0) return;
    e.preventDefault();
    void S.envoyerFichiers(l);
  }
  /** Coller une image (ou un fichier) dans le champ : envoyée comme pièce ; du texte reste du texte. */
  function coller(e: ClipboardEvent): void {
    const l = [...(e.clipboardData?.files ?? [])];
    if (l.length === 0) return;
    e.preventDefault();
    void S.envoyerFichiers(l);
  }
  function voir(cle: string): void {
    fichiers = false;
    document.getElementById(`m-${cle}`)?.scrollIntoView({ block: "center" });
  }
  function echec(code: string): string {
    if (code === "trop_grand") return t("salon.room.toolong.json");
    if (code.startsWith("limite:")) return t("salon.piece.err.limite", { duree: formatDuration(Number(code.slice(7)), lang) });
    if (code === "budget") return t("salon.piece.err.budget");
    if (code === "vocal_trop_long" || code === "trop_gros") return t(`salon.piece.err.${code}`);
    if (code === "plein") return t("salon.room.full");
    return t("salon.room.tick.echec");
  }

  onMount(() => {
    const id = setInterval(() => (maintenant = Date.now()), 1000);
    return () => clearInterval(id);
  });

  // --- Envoi -----------------------------------------------------------------------------------

  /** Texte refusé car trop long : proposé en fichier « message.txt » (§39.5, v3 §4.1). */
  let tropLong = $state<string | null>(null);
  function enFichier(x: string): void {
    tropLong = null;
    erreur = "";
    texte = "";
    if (S.intercepterLienGestion(x)) return; // exigence C-3 32 : jamais envoyé, même en .txt
    void S.envoyerFichiers([new File([x], "message.txt", { type: "text/plain" })]);
  }
  /** Silencieux (v3 §14.4) : choix ouvert (toujours, 1 h, 8 h). */
  let choixSilence = $state(false);
  const silencieux = $derived(vue.silence === SILENCE_TOUJOURS || vue.silence > maintenant);
  // Écart groupe / serveur (exigence 27).
  const fantomes = $derived((void vue.rev, void maintenant, conv.encoreDansLeGroupe()));

  function envoyer(): void {
    erreur = "";
    tropLong = null;
    const brut = texte;
    if (brut.trim() === "") return;
    if (intercepte()) return;
    try {
      if (edition) S.modifier(edition, brut);
      else S.envoyerTexte(brut, reponse?.id ?? null);
    } catch (e) {
      const m = (e as Error).message;
      erreur = m === "texte_trop_long" ? t("salon.room.toolong") : t("salon.room.invalid");
      tropLong = m === "texte_trop_long" && !edition ? brut : null;
      return;
    }
    texte = "";
    reponse = null;
    edition = null;
    void tick().then(() => aller(true));
    saisie?.focus();
  }

  const tactile = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
  function clavier(e: KeyboardEvent): void {
    if (e.key === "Enter" && !e.shiftKey && !tactile && !e.isComposing) {
      e.preventDefault();
      envoyer();
    } else if (e.key === "Escape") {
      if (emojis) emojis = false;
      else if (edition) annulerEdition();
      else reponse = null;
    }
  }
  function frappe(): void {
    if (intercepte()) return;
    if (texte !== "") S.ecrit();
  }
  /**
   * Exigence C-3 32 : un lien de gestion tapé ou collé dans la saisie n'est jamais envoyé (ni
   * message, ni « écrit ») ; la saisie est vidée et le choix est proposé (salon.svelte.ts).
   */
  function intercepte(): boolean {
    if (!S.intercepterLienGestion(texte)) return false;
    texte = "";
    tropLong = null;
    erreur = "";
    void tick().then(() => document.getElementById("salon-colle")?.focus());
    return true;
  }
  // Le résultat est dit par le paragraphe role="status" du panneau (pas d'annonce en double).
  const reprendreDroits = (): Promise<void> => S.reprendreDroits();
  function fermerColle(): void {
    S.annulerGestionCollee();
    saisie?.focus();
  }
  function annulerEdition(): void {
    edition = null;
    texte = "";
  }

  // --- Actions d'un message ----------------------------------------------------------------------

  function repondre(b: Bulle): void {
    menu = null;
    edition = null;
    reponse = b;
    saisie?.focus();
  }
  function editer(b: Bulle): void {
    menu = null;
    reponse = null;
    edition = b;
    texte = b.texte;
    saisie?.focus();
  }
  async function copier(b: Bulle): Promise<void> {
    menu = null;
    try {
      await navigator.clipboard.writeText(b.texte);
      announce(t("salon.room.copied"));
    } catch {
      // Copie refusée par le navigateur : rien d'autre à faire.
    }
  }
  // --- Mode sélection (v3 §14.3) : appui long sur une pièce, ou « Sélectionner » dans son menu
  // (clavier) ; « Télécharger (N) » en une archive .zip faite sur l'appareil, comme « Fichiers ».
  let selection = $state(false);
  const choix = new SvelteSet<string>();
  let selEnCours = $state(false);
  let selMessage = $state("");
  const selectionnable = (b: Bulle): boolean => b.piece !== null && b.piece.ref !== null && !b.retire;
  const selectionnables = $derived(elements.filter((e): e is Bulle => e.k === "bulle" && selectionnable(e)));
  function nomPiece(b: Bulle): string {
    try {
      return S.moteur()?.nettoyerNom(b.piece!.nom) || t("salon.piece.sans.nom");
    } catch {
      return t("salon.piece.sans.nom");
    }
  }
  function selectionner(b: Bulle): void {
    menu = null;
    selection = true;
    selMessage = "";
    choix.add(b.cle);
    void tick().then(() => document.getElementById(`sel-${b.cle}`)?.focus());
  }
  function basculer(cle: string): void {
    if (choix.has(cle)) choix.delete(cle);
    else choix.add(cle);
  }
  function finSelection(): void {
    selection = false;
    choix.clear();
    selMessage = "";
  }
  async function telechargerSelection(): Promise<void> {
    selEnCours = true;
    selMessage = "";
    const e = await S.telechargerArchive(selectionnables.filter((b) => choix.has(b.cle)));
    selEnCours = false;
    if (e === null) finSelection();
    else selMessage = t(e === "trop_gros" ? "salon.files.zip.gros" : e === "indisponible" ? "salon.piece.err.indisponible" : e === "sortie" ? "salon.piece.err.sortie" : "salon.piece.err.lecture");
  }
  // Sélection : les pièces retirées ou effacées entre-temps quittent le choix.
  $effect(() => {
    const ok = new Set(selectionnables.map((b) => b.cle));
    untrack(() => {
      for (const c of choix) if (!ok.has(c)) choix.delete(c);
    });
  });
  /**
   * Appui long (500 ms sans bouger) sur une pièce : mode sélection, cette pièce choisie. En mode
   * sélection, un toucher (ou clic) sur une pièce la coche ou la décoche.
   */
  function appuiLong(el: HTMLElement, b: Bulle) {
    let minuteur: ReturnType<typeof setTimeout> | undefined;
    let x0 = 0;
    let y0 = 0;
    let fait = false;
    const stop = () => {
      clearTimeout(minuteur);
      minuteur = undefined;
    };
    const bas = (ev: PointerEvent) => {
      if (ev.button !== 0 || !selectionnable(b) || selection) return;
      fait = false;
      x0 = ev.clientX;
      y0 = ev.clientY;
      stop();
      minuteur = setTimeout(() => {
        minuteur = undefined;
        fait = true;
        selectionner(b);
      }, 500);
    };
    const bouge = (ev: PointerEvent) => {
      if (minuteur && Math.hypot(ev.clientX - x0, ev.clientY - y0) > 10) stop();
    };
    const menuContexte = (ev: Event) => {
      if (fait || minuteur) ev.preventDefault();
    };
    const clic = (ev: MouseEvent) => {
      if (fait) {
        fait = false;
        ev.preventDefault();
        ev.stopPropagation();
        return;
      }
      if (!selection || !selectionnable(b) || (ev.target as HTMLElement).closest("input.sel")) return;
      ev.preventDefault();
      ev.stopPropagation();
      basculer(b.cle);
    };
    el.addEventListener("pointerdown", bas);
    el.addEventListener("pointermove", bouge);
    el.addEventListener("pointerup", stop);
    el.addEventListener("pointercancel", stop);
    el.addEventListener("pointerleave", stop);
    el.addEventListener("contextmenu", menuContexte);
    el.addEventListener("click", clic, true);
    return {
      update(nb: Bulle) {
        b = nb;
      },
      destroy() {
        stop();
        el.removeEventListener("pointerdown", bas);
        el.removeEventListener("pointermove", bouge);
        el.removeEventListener("pointerup", stop);
        el.removeEventListener("pointercancel", stop);
        el.removeEventListener("pointerleave", stop);
        el.removeEventListener("contextmenu", menuContexte);
        el.removeEventListener("click", clic, true);
      },
    };
  }

  // Fiche « Infos » (v3 §14.2) : nos messages seulement, données déjà sur l'appareil.
  let infosDe = $state<string | null>(null);
  let infosOuverte = $state(false);
  const infos = $derived.by(() => {
    void vue.rev;
    const b = infosDe ? conv.bulle(infosDe) : undefined;
    return b ? { b, f: conv.infos(b) } : null;
  });
  function ouvrirInfos(b: Bulle): void {
    menu = null;
    infosDe = b.id;
    infosOuverte = true;
  }
  function heure(ms: number | null): string {
    if (ms === null) return t("salon.infos.pas");
    return new Date(ms).toDateString() === new Date().toDateString() ? formatClock(ms, lang) : formatDayTime(ms, lang);
  }
  function reagir(b: Bulle, e: string): void {
    menu = null;
    S.reagir(b, e);
  }

  // --- Lecture : « vu » après 1 s à l'écran, page visible (spec v3 §5) ---------------------------

  const vus = new Set<string>();
  const minuteurs = new Map<HTMLElement, ReturnType<typeof setTimeout>>();
  let observateur: IntersectionObserver | undefined;
  function surveiller(el: HTMLElement, b: Bulle) {
    if (b.moi || !b.id || vus.has(b.id) || typeof IntersectionObserver === "undefined") return;
    observateur ??= new IntersectionObserver((entrees) => {
      for (const en of entrees) {
        const cible = en.target as HTMLElement;
        const id = cible.dataset.id!;
        if (en.isIntersecting && document.visibilityState === "visible") {
          if (!minuteurs.has(cible))
            minuteurs.set(
              cible,
              setTimeout(() => {
                minuteurs.delete(cible);
                const x = conv.bulle(id);
                if (x && !vus.has(id) && document.visibilityState === "visible") {
                  vus.add(id);
                  S.vu(x);
                  observateur?.unobserve(cible);
                }
              }, 1000),
            );
        } else {
          clearTimeout(minuteurs.get(cible));
          minuteurs.delete(cible);
        }
      }
    }, { threshold: 0.6 });
    observateur.observe(el);
    return {
      destroy() {
        clearTimeout(minuteurs.get(el));
        minuteurs.delete(el);
        observateur?.unobserve(el);
      },
    };
  }
  $effect(() => () => observateur?.disconnect());

  // --- Défilement, non-lus, annonces ----------------------------------------------------------------

  let repere: HTMLElement | undefined = $state();
  /** Défile jusqu'à la fin de la conversation (saisie comprise), jamais jusqu'au pied de page. */
  function aller(force = false): void {
    if (!force && !enBas) return;
    const r = repere?.getBoundingClientRect();
    if (r) window.scrollTo({ top: Math.max(0, window.scrollY + r.bottom - window.innerHeight), behavior: "instant" as ScrollBehavior });
    nonLus = 0;
  }
  function defile(): void {
    const r = repere?.getBoundingClientRect();
    enBas = r ? r.top <= window.innerHeight + 80 : true;
    if (enBas) nonLus = 0;
  }
  let vusAnnonce = untrack(() => conv.elements.length);
  let rafale: { n: number; t: number } = { n: 0, t: 0 };
  /** Dernier son joué (ms) : au plus un toutes les 2 s (v3 §14.4). */
  let dernierSon = 0;
  /** Séparateur « Nouveaux messages » (v3 §14 point 6) : avant le premier message non lu. */
  let separateur = $state<string | null>(null);
  $effect(() => {
    const n = elements.length;
    untrack(() => {
      const nouveaux = elements.slice(vusAnnonce).filter((e): e is Bulle => e.k === "bulle" && !e.moi);
      vusAnnonce = n;
      if (nouveaux.length === 0) {
        void tick().then(() => aller());
        return;
      }
      const tps = Date.now();
      if (tps - rafale.t > 2000) rafale = { n: 0, t: tps };
      rafale.n += nouveaux.length;
      if (rafale.n > 3) announce(t("salon.room.announce.many", { n: rafale.n }));
      else for (const b of nouveaux) announce(t("salon.room.announce", { nom: nom(b.siege), texte: b.texte }));
      const visible = document.visibilityState === "visible";
      if (!enBas || !visible) {
        if (nonLus === 0) separateur = nouveaux[0]!.cle;
        nonLus += nouveaux.length;
      }
      if (doitSonner({ n: nouveaux.length, silence: vue.silence, maintenant: tps, dernier: dernierSon, visible, enBas })) {
        dernierSon = tps;
        jouer();
      }
      void tick().then(() => aller());
    });
  });
  // Titre de l'onglet : « (3) Salon · Shhgone » (un nombre, aucun contenu ; spec §39.5).
  $effect(() => {
    const n = nonLus;
    void lang;
    document.title = (n > 0 ? `(${n}) ` : "") + routeTitle("salon");
  });

  // --- Affichage ---------------------------------------------------------------------------------------

  function coche(b: Bulle): string {
    const c = conv.coche(b);
    if (c === "vu" || c === "recu" || c === "envoye") {
      if (b.attendus.length > 1 && b.vus.length > 0 && c !== "vu") return t("salon.room.tick.vupar", { n: b.vus.length, total: b.attendus.length });
    }
    return t(`salon.room.tick.${c}`);
  }
  function cite(b: Bulle): { nom: string; texte: string } | null {
    if (!b.cite) return null;
    const o = conv.bulle(b.cite);
    if (!o || o.retire) return { nom: "", texte: t("salon.room.quote.gone") };
    return { nom: nomDe(o), texte: o.texte };
  }
  function ligne(e: Extract<Element, { k: "sys" }>): string {
    if (e.quoi === "pseudo") return t("salon.room.sys.pseudo", { avant: e.avant, apres: e.apres });
    if (e.quoi === "createur") return t("salon.room.sys.createur");
    if (e.quoi === "regle") return t("salon.room.sys.regle", { nom: nomDe(e), regle: t(`salon.regle.${e.regle as 1 | 2 | 3}`) });
    return t(`salon.room.sys.${e.quoi}`, { nom: nomDe(e) });
  }
  const attente = $derived(vue.attenteDepuis === null ? "" : maintenant - vue.attenteDepuis > 30_000 ? t("salon.room.wait.long") : maintenant - vue.attenteDepuis > 2_000 ? t("salon.room.wait.short") : "");
  // Disposition large (panneau des participants à droite) : suit la fenêtre (redimensionnement, appareil tourné).
  const mqLarge = typeof matchMedia === "function" ? matchMedia("(min-width: 1100px)") : null;
  let large = $state(mqLarge?.matches ?? false);
  $effect(() => {
    if (!mqLarge) return;
    const suivre = () => (large = mqLarge.matches);
    mqLarge.addEventListener("change", suivre);
    return () => mqLarge.removeEventListener("change", suivre);
  });
  /** Échap, où que soit le focus dans le salon : ferme le sélecteur d'émojis ou le menu d'un message (revue du 20 novembre). */
  function echappe(e: KeyboardEvent): void {
    if (e.key !== "Escape" || e.defaultPrevented) return;
    if (emojis) {
      emojis = false;
      saisie?.focus();
    } else if (menu !== null) menu = null;
    else if (selection) finSelection();
  }
</script>

<svelte:window onscroll={defile} onkeydown={echappe} />

<div class="salon">
  <header class="tete">
    <div class="titre">
      <h1 tabindex="-1">{t("title.salon")}</h1>
      <p class="etat">
        <span>{t("salon.room.online", { n: enLigne })}</span> · <span>{t("salon.room.free", { n: libres })}</span> ·
        <span>{t("salon.room.expires", { duree: formatDuration(reste, lang, { precise: reste < 300 }) })}</span>
      </p>
    </div>
    <div class="boutons">
      {#if vue.appels && etatAppel === "aucun"}
        <IconButton label={t("salon.appel.audio")} variant="secondary" onpress={() => void S.appel()?.rejoindre(false)}><Phone size={20} /></IconButton>
        <IconButton label={t("salon.appel.video")} variant="secondary" onpress={() => void S.appel()?.rejoindre(true)}><Video size={20} /></IconButton>
      {/if}
      <!-- Revue du 20 novembre (U8) : sur téléphone, boutons à icône de 44 px sur une ligne (le
           libellé reste le nom accessible) ; ailleurs, icône et libellé. -->
      {#if silencieux}
        <button type="button" class="bt coupe" aria-label={t("salon.son.reactiver")} onclick={() => S.silencieux(null)}><VolumeX size={20} aria-hidden="true" /><span class="lib" aria-hidden="true">{t("salon.son.reactiver")}</span></button>
      {:else}
        <button type="button" class="bt" aria-label={t("salon.son.silence")} aria-expanded={choixSilence} onclick={() => (choixSilence = !choixSilence)}><Volume size={20} aria-hidden="true" /><span class="lib" aria-hidden="true">{t("salon.son.silence")}</span></button>
      {/if}
      <button type="button" class="bt" aria-label={t("salon.files.title")} onclick={() => (fichiers = true)}><Folder size={20} aria-hidden="true" /><span class="lib" aria-hidden="true">{t("salon.files.title")}</span></button>
      {#if !large}<button type="button" class="bt" aria-label={t("salon.room.members")} onclick={() => (membres = true)}><Users size={20} aria-hidden="true" /><span class="lib" aria-hidden="true">{t("salon.room.members")}</span></button>{/if}
    </div>
  </header>

  <div class="corps">
    <section class="col" aria-label={t("salon.room.label")} ondragover={(e) => e.dataTransfer?.types.includes("Files") && e.preventDefault()} ondrop={deposer}>
      {#if vue.appels}<Appel />{/if}
      {#if vue.connexion === "coupe"}<p class="bandeau" role="status">{t("salon.room.reconnect")}</p>{/if}
      {#if !vue.dansLeGroupe && !vue.createur}<p class="bandeau" role="status">{t("salon.room.waitgroup")}</p>{/if}
      {#if choixSilence && !silencieux}
        <div class="silence" role="group" aria-label={t("salon.son.silence")}>
          {#each [["toujours", "salon.son.toujours"], [1, "salon.son.1h"], [8, "salon.son.8h"]] as const as [c, cle] (c)}
            <Button variant="secondary" dense onpress={() => {
                S.silencieux(c);
                choixSilence = false;
              }}>{t(cle)}</Button>
          {/each}
        </div>
      {/if}
      {#each fantomes as f (f.siege)}<p class="bandeau alerte" role="alert">{t("salon.room.fantome", { nom: f.pseudo ?? t("salon.room.participant", { n: f.numero }) })}</p>{/each}
      {#if selection}
        <div class="barre-sel" role="group" aria-label={t("salon.sel.titre")}>
          <span class="nb" role="status">{t("salon.sel.n", { n: choix.size })}</span>
          <Button variant="ghost" dense onpress={() => {
              if (choix.size === selectionnables.length) choix.clear();
              else for (const b of selectionnables) choix.add(b.cle);
            }}>{choix.size === selectionnables.length ? t("salon.files.aucun") : t("salon.files.tout")}</Button>
          <Button variant="secondary" dense disabled={choix.size === 0 || selEnCours} onpress={telechargerSelection}>{t("salon.files.zip", { n: choix.size })}</Button>
          <Button variant="ghost" dense onpress={finSelection}>{t("salon.sel.fin")}</Button>
          {#if selMessage}<p class="err" role="alert">{selMessage}</p>{/if}
        </div>
      {/if}
      <div role="log" aria-live="off">
      <ol class="fil">
        {#each elements as e (e.cle)}
          {#if e.cle === separateur}<li class="sys nouveaux">{t("salon.room.nouveaux")}</li>{/if}
          {#if e.k === "sys"}
            <li class="sys">{ligne(e)}</li>
          {:else}
            {@const al = albums.get(e.cle)}
            <li class={["msg", { moi: e.moi, album: al !== undefined, choisi: selection && choix.has(e.cle) }, `c${conv.couleurDe(e)}`]} id="m-{e.cle}" data-id={e.id ?? undefined} use:surveiller={e} use:appuiLong={e}>
              {#if selection && selectionnable(e)}
                <input type="checkbox" class="sel" id="sel-{e.cle}" checked={choix.has(e.cle)} aria-label={t("salon.files.choisir", { nom: nomPiece(e) })} onchange={() => basculer(e.cle)} />
              {/if}
              <div class="bulle">
                {#if !e.moi && al !== "suite"}<span class="auteur">{nomDe(e)}</span>{/if}
                {#if e.retire}
                  <p class="retire">{t("salon.room.retracted")}</p>
                {:else}
                  {@const q = cite(e)}
                  {#if q}<blockquote class="cite"><span class="qn">{q.nom}</span> <bdi>{q.texte}</bdi></blockquote>{/if}
                  {#if e.piece}
                    <Piece b={e} />
                  {:else}
                    <p class="texte"><bdi
                        >{#each morceaux(e.texte) as m, i (i)}{#if m.lien}<a href={m.t} target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">{m.t}</a>{:else}{m.t}{/if}{/each}</bdi
                      ></p>
                  {/if}
                {/if}
                {#if e.etat === "echec" && e.echec}<p class="err" role="status">{echec(e.echec)}</p>
                  {#if e.echec === "trop_grand" && !e.piece && e.texte}<Button variant="secondary" dense onpress={() => enFichier(e.texte)}>{t("salon.room.toolong.txt")}</Button>{/if}{/if}
                <p class="meta">
                  <time>{formatClock(e.heureMs, lang)}</time>
                  {#if e.modifie && !e.retire}<span>· {t("salon.room.edited")}</span>{/if}
                  {#if e.moi}<span class={["coche", conv.coche(e)]}>· {coche(e)}</span>{/if}
                  {#if e.regle !== 0 && !e.retire}{@const ef = S.effacement(e, maintenant)}{#if ef.etat === "rebours"}<span class="rebours">· {ef.finMs > maintenant ? t("salon.room.rebours", { duree: formatDuration((ef.finMs - maintenant) / 1000, lang, { precise: true }) }) : t("salon.room.attente.lecture")}</span>{/if}{/if}
                </p>
                {#if e.reactions.length > 0}
                  <ul class="reactions">
                    {#each e.reactions as r (r.emoji)}
                      <li><button type="button" class={{ mien: r.sieges.includes(conv.moi) }} aria-label="{r.emoji} {r.sieges.length} — {r.sieges.map(nom).join(', ')}" onclick={() => reagir(e, r.emoji)}>{r.emoji} {r.sieges.length}</button></li>
                    {/each}
                  </ul>
                {/if}
              </div>
              {#if !e.retire && e.id}
                <button type="button" class="plus" aria-label={t("salon.room.actions")} aria-expanded={menu === e.cle} onclick={() => (menu = menu === e.cle ? null : e.cle)}>⋯</button>
                {#if menu === e.cle}
                  <div class="actions-msg" role="group" aria-label={t("salon.room.actions")}>
                    <div class="rapides">
                      {#each QUICK as q (q)}<button type="button" aria-label="{t('salon.room.react')} {q}" onclick={() => reagir(e, q)}>{q}</button>{/each}
                    </div>
                    <Button variant="ghost" dense onpress={() => repondre(e)}>{t("salon.room.reply")}</Button>
                    {#if selectionnable(e)}<Button variant="ghost" dense onpress={() => selectionner(e)}>{t("salon.sel.choisir")}</Button>{/if}
                    <Button variant="ghost" dense onpress={() => copier(e)}>{t("salon.room.copy")}</Button>
                    {#if e.moi && e.seq !== null}
                      <Button variant="ghost" dense onpress={() => ouvrirInfos(e)}>{t("salon.infos")}</Button>
                      <Button variant="ghost" dense onpress={() => editer(e)}>{t("salon.room.edit")}</Button>
                      <InlineConfirm label={t("salon.room.retract")} message={t("salon.room.retract.confirm")} confirmLabel={t("salon.room.retract")} kind="danger" triggerVariant="ghost" onconfirm={() => ((menu = null), S.retirer(e))} />
                    {/if}
                  </div>
                {/if}
              {/if}
            </li>
          {/if}
        {/each}
      </ol>
      </div>
      <p class="ecrit" aria-live="polite">
        {#if ecrivent.length === 1}{t("salon.room.typing.un", { nom: nom(ecrivent[0]!) })}{:else if ecrivent.length > 1}{t("salon.room.typing.plusieurs")}{/if}
      </p>
      {#if nonLus > 0 && !enBas}
        <button type="button" class="bas" aria-label={`${t("salon.room.unread", { n: nonLus })} · ${t("salon.room.down")}`} onclick={() => aller(true)}><span aria-hidden="true">↓ </span><span>{t("salon.room.unread", { n: nonLus })}</span></button>
      {/if}

      <div class="saisie">
        {#if attente}<p class="note" role="status">{attente}</p>{/if}
        {#if S.pieces.avertissement}<p class="err" role="status">{t("salon.piece.err.trop_gros")}</p>{/if}
        {#if S.pieces.aConfirmer.length > 0}
          <div class="confirmer" role="group" aria-label={t("salon.piece.nonnettoye")}>
            <p class="note">{t("salon.piece.nonnettoye")}</p>
            <ul>{#each S.pieces.aConfirmer as f, i (i)}<li><bdi>{f.name}</bdi></li>{/each}</ul>
            <div class="ligne">
              <Button variant="secondary" dense onpress={() => S.confirmerTelQuel(true)}>{t("salon.piece.telquel")}</Button>
              <Button variant="ghost" dense onpress={() => S.confirmerTelQuel(false)}>{t("salon.piece.annuler")}</Button>
            </div>
          </div>
        {/if}
        {#if vue.gestionCollee}
          <div class="confirmer" id="salon-colle" tabindex="-1" role="group" aria-label={t("salon.colle.titre")}>
            {#if vue.gestionCollee === "proposee"}
              <p class="note">{t("salon.colle.proposee")}</p>
              <p class="note">{t("salon.colle.deloge")}</p>
              <div class="ligne">
                <Button variant="secondary" dense onpress={reprendreDroits}>{t("salon.colle.reprendre")}</Button>
                <Button variant="ghost" dense onpress={fermerColle}>{t("salon.colle.annuler")}</Button>
              </div>
            {:else}
              <p class={vue.gestionCollee === "fait" || vue.gestionCollee === "deja" ? "note" : "err"} role="status">{t(`salon.colle.${vue.gestionCollee}`)}</p>
              <div class="ligne"><Button variant="ghost" dense onpress={fermerColle}>{t("salon.colle.fermer")}</Button></div>
            {/if}
          </div>
        {/if}
        {#if erreur}<p class="err" role="alert">{erreur}</p>{/if}
        {#if tropLong}<Button variant="secondary" dense onpress={() => {
            if (tropLong) enFichier(tropLong);
          }}>{t("salon.room.toolong.txt")}</Button>{/if}
        {#if reponse}
          <div class="contexte">
            <span>{t("salon.room.reply.to", { nom: nomDe(reponse) })}</span>
            <button type="button" aria-label={t("salon.room.reply.cancel")} onclick={() => (reponse = null)}>✕</button>
          </div>
        {/if}
        {#if edition}
          <div class="contexte">
            <span>{t("salon.room.edit.mode")} — {t("salon.room.edit.note")}</span>
            <button type="button" aria-label={t("salon.room.edit.cancel")} onclick={annulerEdition}>✕</button>
          </div>
        {/if}
        {#if emojis}<Emojis onpick={(x) => ((texte += x), saisie?.focus())} onclose={() => ((emojis = false), saisie?.focus())} />{/if}
        <div class="ligne">
          <button type="button" class="emo" aria-label={emojis ? t("salon.room.emoji.close") : t("salon.room.emoji")} aria-expanded={emojis} onclick={() => (emojis = !emojis)}>☺</button>
          <button type="button" class="emo" aria-label={t("salon.piece.joindre")} onclick={() => joindre?.click()}><Paperclip size={20} aria-hidden="true" /></button>
          <button type="button" class="emo" aria-label={t("salon.piece.vocal")} onclick={() => (vocal = true)}><Mic size={20} aria-hidden="true" /></button>
          <input bind:this={joindre} type="file" multiple hidden onchange={choisis} />
          <label class="sr-only" for="salon-saisie">{t("salon.room.input")}</label>
          <textarea
            id="salon-saisie"
            bind:this={saisie}
            bind:value={texte}
            rows="1"
            placeholder={t("salon.room.placeholder")}
            autocomplete="off"
            autocapitalize="sentences"
            spellcheck={false}
            enterkeyhint={tactile ? "enter" : "send"}
            onkeydown={clavier}
            oninput={frappe}
            onpaste={coller}
          ></textarea>
          <Button dense onpress={envoyer}>{t("salon.room.send")}</Button>
        </div>
      </div>
      <!-- Repère dans le flux (la saisie est collée en bas) : la fin de la conversation. -->
      <div bind:this={repere}></div>
    </section>
    {#if large}
      <aside class="panneau" aria-label={t("salon.room.members")}><Membres /></aside>
    {/if}
  </div>
</div>

{#if !large}
  <Sheet bind:open={membres} title={t("salon.room.members")}><Membres /></Sheet>
{/if}
<Sheet bind:open={infosOuverte} title={t("salon.infos.titre")} onclose={() => (infosDe = null)}>
  {#if infos?.f}
    {@const f = infos.f}
    <p class="note">{t("salon.infos.envoye", { heure: heure(f.envoyeMs) })}</p>
    {#if f.lecteurs.length === 0}
      <p class="note">{t("salon.infos.personne")}</p>
    {:else}
      <ul class="infos">
        {#each f.lecteurs as l (l.siege)}
          <li>
            <p class="qui"><bdi>{nom(l.siege)}</bdi></p>
            <dl>
              <dt>{t("salon.infos.recu")}</dt><dd>{heure(l.recu)}</dd>
              <dt>{t("salon.infos.vu")}</dt><dd>{heure(l.vu)}</dd>
              {#if infos.b.piece}
                <dt>{t("salon.infos.ouvert")}</dt><dd>{heure(l.ouvert)}</dd>
                <dt>{t("salon.infos.telecharge")}</dt><dd>{heure(l.telecharge)}</dd>
              {/if}
            </dl>
          </li>
        {/each}
      </ul>
    {/if}
    <p class="note">{t("salon.infos.note")}</p>
  {/if}
</Sheet>
<Sheet bind:open={fichiers} title={t("salon.files.title")}><Fichiers onvoir={voir} /></Sheet>
<VoiceRecorder bind:open={vocal} ondone={(v) => S.envoyerVocal(v)} />

<style>
  .salon {
    width: 100%;
    max-width: 1180px;
    margin-inline: auto;
    padding: var(--sp-3) var(--sp-4) 0;
    /* La saisie reste en bas de l'écran, le pied de page sous la ligne de flottaison (messagerie). */
    min-height: calc(100dvh - 4.5rem);
    display: flex;
    flex-direction: column;
    /* Couleurs des participants (§39.4 point 5) : ≥ 6,7:1 sur --surface-3. */
    --p0: #5fe3b5;
    --p1: #7cc4ff;
    --p2: #b79cff;
    --p3: #ff8fc7;
    --p4: #ff9a7a;
    --p5: #f2c46d;
    --p6: #d8e86a;
    --p7: #4fd8e0;
    --p8: #e0a8f0;
    --p9: #d9c3a0;
  }
  .boutons {
    display: flex;
    flex-wrap: wrap;
    gap: var(--sp-2);
    justify-content: flex-end;
  }
  .confirmer {
    display: grid;
    gap: var(--sp-2);
    padding: var(--sp-2) var(--sp-3);
    border: 1px solid var(--warn);
    border-radius: 12px;
  }
  .infos {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: var(--sp-3);
  }
  .infos .qui {
    margin: 0;
    font-weight: 600;
  }
  .infos dl {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: var(--sp-1) var(--sp-3);
    margin: var(--sp-1) 0 0;
  }
  .infos dd {
    margin: 0;
  }
  .confirmer ul {
    margin: 0;
    padding-inline-start: 1.2em;
  }
  .tete {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--sp-3);
    padding-block: var(--sp-2) var(--sp-3);
    border-bottom: 1px solid var(--line);
  }
  .tete h1 {
    margin: 0;
    font-size: var(--fs-title, 1.25rem);
  }
  .tete h1:focus {
    outline: none;
  }
  .etat {
    margin: 0;
    color: var(--text-2);
    font-size: 0.875rem;
  }
  /* Boutons de l'en-tête : icône et libellé (mesures de Button dense, secondaire). */
  .bt {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: var(--sp-2);
    min-width: 44px;
    min-height: 44px;
    padding: 0 14px;
    border: 1px solid var(--hair-2);
    border-radius: 10px;
    background: rgb(255 255 255 / 0.045);
    box-shadow: var(--edge-hi);
    color: var(--text);
    font: inherit;
    font-size: var(--fs-small);
    font-weight: 560;
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
    touch-action: manipulation;
    transition:
      background-color var(--dur-fast) var(--ease-out),
      transform var(--dur-press) var(--ease-out);
  }
  .bt :global(svg) {
    flex: none;
  }
  .bt.coupe {
    color: var(--accent);
  }
  @media (hover: hover) {
    .bt:hover {
      background: rgb(255 255 255 / 0.08);
    }
  }
  .bt:active {
    transform: scale(0.97);
  }
  .bt:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  /* Téléphone (revue du 20 novembre, U8 : en-tête de ~170 px) : titre et boutons à icône seule
     de 44 px sur une ligne, l'état du salon sur une ligne dessous. */
  @media (max-width: 600px) {
    .tete {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      grid-template-areas: "titre boutons" "etat etat";
      align-items: center;
      column-gap: var(--sp-2);
      row-gap: var(--sp-1);
    }
    .titre {
      display: contents;
    }
    .tete h1 {
      grid-area: titre;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .etat {
      grid-area: etat;
      font-size: var(--fs-micro);
      line-height: var(--lh-micro);
    }
    .boutons {
      grid-area: boutons;
      flex-wrap: nowrap;
      gap: var(--sp-1);
    }
    .bt {
      width: 44px;
      padding: 0;
    }
    .lib {
      display: none;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .bt {
      transition: none;
    }
    .bt:active {
      transform: none;
    }
  }
  @media (forced-colors: active) {
    .bt {
      border-color: ButtonText;
    }
  }
  .corps {
    flex: 1;
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: var(--sp-5);
  }
  @media (min-width: 1100px) {
    .corps {
      grid-template-columns: minmax(0, 720px) 320px;
      justify-content: center;
    }
  }
  .col {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: var(--sp-2);
  }
  /* Le panneau ne dicte plus la hauteur de la page (revue du 20 novembre : 850 px de vide entre
     le dernier message et la saisie) : il reste sous la barre du site et défile en lui-même. */
  .panneau {
    position: sticky;
    top: 64px;
    align-self: start;
    max-height: calc(100dvh - 64px);
    overflow: auto;
    padding: var(--sp-4) 0;
    overscroll-behavior: contain;
  }
  .bandeau {
    margin: var(--sp-2) 0 0;
    padding: var(--sp-2) var(--sp-3);
    border-radius: 10px;
    background: var(--warn-tint);
    color: var(--warn);
  }
  .fil {
    list-style: none;
    margin: 0;
    padding: var(--sp-3) 0;
    display: grid;
    /* Albums : jusqu'à 4 photos par rangée (2 sur téléphone) ; tout le reste prend la rangée. */
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: var(--sp-2);
    min-height: 40vh;
  }
  .fil > :global(li) {
    grid-column: 1 / -1;
  }
  .fil > .msg.album {
    grid-column: auto;
  }
  .album :global(.img) {
    width: 100%;
    aspect-ratio: 1;
    object-fit: cover;
  }
  @media (max-width: 600px) {
    .fil {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }
  .silence {
    display: flex;
    flex-wrap: wrap;
    gap: var(--sp-2);
  }
  .alerte {
    color: var(--warn, var(--text));
  }
  .nouveaux {
    justify-self: stretch;
    border-top: 1px solid var(--line-strong);
    padding-top: var(--sp-1);
    color: var(--accent);
  }
  .sys {
    justify-self: center;
    color: var(--text-3);
    font-size: 0.8125rem;
    text-align: center;
  }
  .msg {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    gap: var(--sp-1);
    max-width: min(86%, 560px);
  }
  .msg.moi {
    justify-self: end;
    flex-direction: row-reverse;
  }
  .bulle {
    min-width: 0;
    padding: var(--sp-2) var(--sp-3);
    border-radius: 14px;
    background: var(--surface-1);
    border-inline-start: 3px solid var(--pc, var(--line));
    overflow-wrap: anywhere;
  }
  .barre-sel {
    position: sticky;
    top: var(--sp-2);
    z-index: 2;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--sp-2);
    padding: var(--sp-2) var(--sp-3);
    border: 1px solid var(--line-strong);
    border-radius: 12px;
    background: var(--surface-2);
  }
  .barre-sel .nb {
    font-weight: 600;
  }
  .barre-sel .err {
    flex-basis: 100%;
    margin: 0;
  }
  input.sel {
    align-self: center;
    inline-size: 24px;
    block-size: 24px;
    margin: 10px;
    accent-color: var(--accent);
  }
  .choisi .bulle {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  .moi .bulle {
    background: var(--surface-2);
    border-inline-start: 0;
    border-inline-end: 3px solid var(--accent);
  }
  .c0 { --pc: var(--p0); }
  .c1 { --pc: var(--p1); }
  .c2 { --pc: var(--p2); }
  .c3 { --pc: var(--p3); }
  .c4 { --pc: var(--p4); }
  .c5 { --pc: var(--p5); }
  .c6 { --pc: var(--p6); }
  .c7 { --pc: var(--p7); }
  .c8 { --pc: var(--p8); }
  .c9 { --pc: var(--p9); }
  .auteur {
    display: block;
    color: var(--pc);
    font-weight: 600;
    font-size: 0.8125rem;
  }
  .texte {
    margin: 0;
    white-space: pre-wrap;
  }
  .texte a {
    color: var(--accent);
    text-underline-offset: 2px;
  }
  .retire {
    margin: 0;
    color: var(--text-3);
    font-style: italic;
  }
  .cite {
    margin: 0 0 var(--sp-1);
    padding: var(--sp-1) var(--sp-2);
    border-inline-start: 2px solid var(--line-strong);
    color: var(--text-2);
    font-size: 0.875rem;
    display: -webkit-box;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .qn {
    font-weight: 600;
  }
  .meta {
    margin: var(--sp-1) 0 0;
    display: flex;
    gap: var(--sp-1);
    flex-wrap: wrap;
    color: var(--text-3);
    font-size: 0.75rem;
  }
  .coche.vu {
    color: var(--accent);
  }
  .coche.echec {
    color: var(--danger);
  }
  .reactions {
    list-style: none;
    margin: var(--sp-1) 0 0;
    padding: 0;
    display: flex;
    flex-wrap: wrap;
    gap: var(--sp-1);
  }
  .reactions button,
  .rapides button {
    min-height: 32px;
    padding: 0 var(--sp-2);
    border: 1px solid var(--line);
    border-radius: 999px;
    background: var(--surface-2);
    color: var(--text);
    font: inherit;
    cursor: pointer;
  }
  .reactions button.mien {
    border-color: var(--accent);
  }
  .plus {
    min-width: 44px;
    min-height: 44px;
    border: 0;
    background: transparent;
    color: var(--text-2);
    font-size: 1.25rem;
    cursor: pointer;
    border-radius: 10px;
  }
  .plus:focus-visible,
  .emo:focus-visible,
  .bas:focus-visible,
  .contexte button:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  .actions-msg {
    flex-basis: 100%;
    display: flex;
    flex-wrap: wrap;
    gap: var(--sp-1);
    padding: var(--sp-2);
    border: 1px solid var(--line);
    border-radius: 12px;
    background: var(--surface-1);
  }
  .rapides {
    display: flex;
    gap: var(--sp-1);
    flex-wrap: wrap;
    flex-basis: 100%;
  }
  .rapides button {
    min-width: 44px;
    min-height: 44px;
    font-size: 1.25rem;
  }
  .ecrit {
    min-height: 1.25rem;
    margin: 0;
    color: var(--text-2);
    font-size: 0.8125rem;
  }
  .bas {
    position: sticky;
    bottom: 6.5rem;
    justify-self: end;
    min-height: 44px;
    padding: 0 var(--sp-3);
    border: 1px solid var(--line);
    border-radius: 999px;
    background: var(--surface-2);
    color: var(--text);
    cursor: pointer;
  }
  .saisie {
    margin-top: auto;
    position: sticky;
    bottom: 0;
    display: grid;
    gap: var(--sp-2);
    padding: var(--sp-2) 0 max(var(--sp-3), env(safe-area-inset-bottom));
    background: var(--bg);
    border-top: 1px solid var(--line);
  }
  .ligne {
    display: flex;
    align-items: flex-end;
    gap: var(--sp-2);
  }
  /* Téléphone (revue du 20 novembre : le champ ne faisait plus que 93 px) : le message prend
     toute la largeur, les outils et « Envoyer » passent dessous. */
  @media (max-width: 600px) {
    .ligne {
      flex-wrap: wrap;
    }
    .ligne textarea {
      order: -1;
      flex: 1 0 100%;
    }
    .ligne > :global(:last-child) {
      margin-inline-start: auto;
    }
  }
  textarea {
    flex: 1;
    min-height: 44px;
    max-height: 40vh;
    resize: none;
    field-sizing: content;
    padding: var(--sp-2) var(--sp-3);
    border: 1px solid var(--line-strong);
    border-radius: 12px;
    background: var(--surface-1);
    color: var(--text);
    font: inherit;
  }
  textarea:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  .emo {
    min-width: 44px;
    min-height: 44px;
    border: 0;
    border-radius: 12px;
    background: var(--surface-2);
    color: var(--text);
    font-size: 1.25rem;
    cursor: pointer;
  }
  .contexte {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--sp-2);
    padding: var(--sp-1) var(--sp-2);
    border-inline-start: 2px solid var(--accent);
    color: var(--text-2);
    font-size: 0.875rem;
  }
  .contexte button {
    min-width: 44px;
    min-height: 44px;
    border: 0;
    background: transparent;
    color: var(--text-2);
    cursor: pointer;
  }
  .note {
    margin: 0;
    color: var(--text-2);
    font-size: 0.875rem;
  }
  .err {
    margin: 0;
    color: var(--danger);
    font-size: 0.875rem;
  }
  @media (forced-colors: active) {
    .bulle {
      border: 1px solid CanvasText;
    }
    .auteur {
      text-decoration: underline;
    }
  }
</style>
