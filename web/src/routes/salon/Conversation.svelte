<script lang="ts">
  // Conversation du salon (spec §39.6, v3 §4, §6, §14.1, §14.2) : en-tête (en ligne,
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
  import { ralentiRestant } from "../../salon/affichage";
  import { palierAnnonce, rebours } from "../../salon/fermeture";
  import * as S from "../../salon/salon.svelte";
  import Button from "../../ui/Button.svelte";
  import InlineConfirm from "../../ui/InlineConfirm.svelte";
  import Sheet from "../../ui/Sheet.svelte";
  import Membres from "./Membres.svelte";
  import Emojis from "./Emojis.svelte";
  import Piece from "./Piece.svelte";
  import Fichiers from "./Fichiers.svelte";
  import Appel from "./Appel.svelte";
  import Panneau from "./Panneau.svelte";
  import Avatar from "./Avatar.svelte";
  import { texteVu } from "./presence";
  import IconButton from "../../ui/IconButton.svelte";
  import VoiceRecorder from "../../ui/VoiceRecorder.svelte";
  import { ArrowDown, Clock, Ellipsis, Folder, Hourglass, Mic, Paperclip, Phone, Send, SlidersHorizontal, Smile, TriangleAlert, Users, Video, Volume, VolumeX, X } from "../../ui/Icon";
  import { rangs, sorteJour } from "./fil";
  import { reducedMotion } from "../../ui/motion";
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
  // Présence des autres participants (v3 §14.1, d'après 0x07 et 0x0D seulement) : en ligne d'abord.
  const autres = $derived.by(() => {
    void vue.rev;
    return [...conv.presents]
      .filter((s) => s !== conv.moi)
      .map((s) => ({ s, nom: nom(s), couleur: conv.couleur(s), enLigne: conv.presence.get(s)?.enLigne === true }))
      .sort((a, b) => Number(b.enLigne) - Number(a.enLigne) || a.s - b.s);
  });
  // Fin proche : compte à rebours visible à la seconde pendant la dernière minute ; l'alerte des
  // minutes reste affichée ici pendant un appel (le fil, lui, peut être hors de vue). Le lecteur
  // d'écran n'entend que les alertes et, à la fin, 30 s et 10 s.
  const secondesFin = $derived(rebours(vue.finMs, maintenant));
  const annonceFin = $derived(
    secondesFin !== null && palierAnnonce(secondesFin) !== 60 ? t("salon.fin.rebours", { n: palierAnnonce(secondesFin) }) : vue.alerteFin !== null ? t("salon.fin.alerte", { n: vue.alerteFin }) : "",
  );
  $effect(() => announce(annonceFin));

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
  /** Panneau « Paramètres du salon » (participants, règle d'effacement, gestion) ouvert. */
  let params = $state(false);
  let erreur = $state("");
  // Limite de trames du serveur (0x0B) : l'envoi repart tout seul ; on le dit au lieu de rester muet.
  const ralenti = $derived(ralentiRestant(vue.ralentiJusqua, maintenant));
  let enBas = $state(true);
  let nonLus = $state(0);

  const QUICK = ["👍", "❤️", "😂", "😮", "😢", "🙏"];

  // --- Pièces -------------------------------------------------------------------------
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
    if (S.intercepterLienGestion(x)) return; // lien de gestion : jamais envoyé, même en .txt
    void S.envoyerFichiers([new File([x], "message.txt", { type: "text/plain" })]);
  }
  /** Silencieux (v3 §14.4) : choix ouvert (toujours, 1 h, 8 h). */
  let choixSilence = $state(false);
  const silencieux = $derived(vue.silence === SILENCE_TOUJOURS || vue.silence > maintenant);
  // Écart groupe / serveur.
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
    else selMessage = t(e === "trop_gros" ? "salon.files.zip.gros" : e === "indisponible" ? "salon.piece.err.indisponible" : e === "sortie" ? "salon.piece.err.sortie" : e === "relu" ? "salon.piece.err.relu" : "salon.piece.err.lecture");
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
  // Comme une application : la page ne défile pas, seul le fil défile (en-tête et saisie fixes).

  let zoneFil: HTMLElement | undefined = $state();
  let listeFil: HTMLElement | undefined = $state();
  /** Défile jusqu'au dernier message du fil. */
  function aller(force = false): void {
    if (!force && !enBas) return;
    if (zoneFil) zoneFil.scrollTop = zoneFil.scrollHeight;
    enBas = true;
    nonLus = 0;
  }
  function defile(): void {
    const z = zoneFil;
    enBas = z ? z.scrollHeight - z.scrollTop - z.clientHeight <= 80 : true;
    if (enBas) nonLus = 0;
  }
  // Une photo qui se charge, une réaction, un menu qui s'ouvre : le fil grandit ; s'il était en
  // bas, il y reste (comme une messagerie). Premier affichage : en bas.
  $effect(() => {
    const l = listeFil;
    if (!l || typeof ResizeObserver === "undefined") return;
    untrack(() => aller(true));
    const ro = new ResizeObserver(() => aller());
    ro.observe(l);
    return () => ro.disconnect();
  });

  // --- Mise en page d'application ---------------------------------------------------------------------
  // La page entière est l'écran du salon : pas de défilement ni de pied de page pendant la
  // conversation (html.salon-app, ôtée en quittant). Ordinateur : sous la barre du site
  // (--haut, mesurée) ; téléphone : plein écran, à la hauteur de la partie visible
  // (visualViewport : le clavier virtuel ne cache jamais la saisie, iOS compris).
  let salon: HTMLElement | undefined = $state();
  $effect(() => {
    const el = salon;
    if (!el) return;
    const html = document.documentElement;
    html.classList.add("salon-app");
    window.scrollTo(0, 0);
    const barre = document.querySelector<HTMLElement>("header.top");
    const vv = window.visualViewport;
    const maj = () => {
      el.style.setProperty("--haut", `${Math.max(0, barre?.getBoundingClientRect().bottom ?? 0)}px`);
      el.style.setProperty("--vv-h", `${vv?.height ?? window.innerHeight}px`);
      el.style.setProperty("--vv-top", `${vv?.offsetTop ?? 0}px`);
      aller();
    };
    maj();
    const ro = barre && typeof ResizeObserver !== "undefined" ? new ResizeObserver(maj) : null;
    if (barre) ro?.observe(barre);
    vv?.addEventListener("resize", maj);
    vv?.addEventListener("scroll", maj);
    window.addEventListener("resize", maj);
    return () => {
      html.classList.remove("salon-app");
      ro?.disconnect();
      vv?.removeEventListener("resize", maj);
      vv?.removeEventListener("scroll", maj);
      window.removeEventListener("resize", maj);
    };
  });
  /** Colonne des participants (ordinateur large) : repliable, ouverte par défaut. */
  let colonne = $state(true);

  // Champ de saisie qui grandit avec le texte : CSS (field-sizing) là où il existe, sinon la
  // hauteur suit le contenu (Safari, Firefox), jusqu'à 160 px.
  const grandit = typeof CSS !== "undefined" && CSS.supports?.("field-sizing", "content");
  $effect(() => {
    void texte;
    const s = saisie;
    if (!s || grandit) return;
    s.style.height = "auto";
    s.style.height = `${Math.min(s.scrollHeight + 2, 160)}px`;
  });

  const envoiPossible = $derived(texte.trim() !== "" || edition !== null);
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

  // Fil mis en page : jour, séries d'un même auteur, albums, « Nouveaux messages ».
  const rangsFil = $derived(rangs(elements, albums, (b) => `${b.moi}:${b.siege}:${nomDe(b)}`, separateur));
  function jour(ms: number): string {
    const s = sorteJour(ms, maintenant);
    if (s === "today" || s === "yesterday") return t(`salon.room.jour.${s}`);
    return new Intl.DateTimeFormat(lang, { weekday: "long", day: "numeric", month: "long", ...(s === "annee" ? { year: "numeric" } : {}) }).format(ms);
  }
  // Pastilles empilées de l'en-tête : les trois premiers autres participants.
  const pile = $derived(autres.slice(0, 3));
  function coche(b: Bulle): string {
    if (vuPartiel(b)) return t("salon.room.tick.vupar", { n: b.vus.length, total: b.attendus.length });
    return t(`salon.room.tick.${conv.coche(b)}`);
  }
  /** Groupe : vu par une partie seulement des participants attendus (« Vu par 1 / 3 »). */
  function vuPartiel(b: Bulle): boolean {
    const c = conv.coche(b);
    return (c === "recu" || c === "envoye") && b.attendus.length > 1 && b.vus.length > 0;
  }
  /** Décompte court d'un message éphémère (« 42 s », « 4 min »), ou null hors décompte. */
  function decompte(b: Bulle): { court: string; long: string } | null {
    if (b.regle === 0 || b.retire) return null;
    const ef = S.effacement(b, maintenant);
    if (ef.etat !== "rebours") return null;
    if (ef.finMs <= maintenant) return { court: "", long: t("salon.room.attente.lecture") };
    const d = formatDuration((ef.finMs - maintenant) / 1000, lang);
    return { court: d, long: t("salon.room.rebours", { duree: d }) };
  }
  /**
   * Message effacé (règle du salon) qui quitte le fil : il se défait en trame de points qui
   * dérive vers le haut, comme l'effet « efface » du site (ui/DestroyedArt.svelte), avec un fondu.
   * Transform, opacité et masque seulement ; mouvement réduit : il part sans animation.
   */
  function dissoudre(_n: HTMLElement) {
    if (reducedMotion()) return { duration: 0 };
    return {
      duration: 640,
      css: (x: number) => {
        const p = 1 - x;
        const r = 4.4 * (1 - p * p);
        const m = `radial-gradient(circle, #000 ${r.toFixed(2)}px, transparent ${(r + 0.6).toFixed(2)}px) 0 0 / 6px 6px`;
        return `opacity:${Math.min(1, x * 1.6).toFixed(3)};transform:translate(${(p * 6).toFixed(2)}px,${(-p * 10).toFixed(2)}px);-webkit-mask:${m};mask:${m}`;
      },
    };
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
    if (e.quoi === "fermeture") return t("salon.fin.alerte", { n: e.minutes });
    if (e.quoi === "regle") return t("salon.room.sys.regle", { nom: nomDe(e), regle: t(`salon.regle.${e.regle as 1 | 2 | 3}`) });
    return t(`salon.room.sys.${e.quoi}`, { nom: nomDe(e) });
  }
  const attente = $derived(vue.attenteDepuis === null ? "" : maintenant - vue.attenteDepuis > 30_000 ? t("salon.room.wait.long") : maintenant - vue.attenteDepuis > 2_000 ? t("salon.room.wait.short") : "");
  /** Échap, où que soit le focus dans le salon : ferme le sélecteur d'émojis ou le menu d'un message. */
  function echappe(e: KeyboardEvent): void {
    if (e.key !== "Escape" || e.defaultPrevented) return;
    if (emojis) {
      emojis = false;
      saisie?.focus();
    } else if (menu !== null) menu = null;
    else if (selection) finSelection();
  }
</script>

<svelte:window onkeydown={echappe} />

<!-- Un message (bulle, rangée d'actions, réactions, menu). `album` : case d'un album de photos. -->
{#snippet message(e: Bulle, premier: boolean, dernier: boolean, album: boolean)}
  {@const dc = decompte(e)}
  {@const media = !e.retire && e.piece !== null && (e.piece.sorte === "image" || e.piece.sorte === "video")}
  <li class={["msg", { moi: e.moi, premier, dernier, album, choisi: selection && choix.has(e.cle) }, `c${conv.couleurDe(e)}`]} id="m-{e.cle}" data-id={e.id ?? undefined} use:surveiller={e} use:appuiLong={e} out:dissoudre>
    {#if !e.moi && !album}
      <!-- Photo de l'auteur : sur le premier message de la série seulement (décorative, le nom est dans la bulle). -->
      <span class="gout" aria-hidden="true">{#if premier}<Avatar siege={e.siege} nom={nomDe(e)} taille={32} photo={!e.fige} />{/if}</span>
    {/if}
    <div class="contenu">
      <div class="rang">
        {#if selection && selectionnable(e)}
          <input type="checkbox" class="sel" id="sel-{e.cle}" checked={choix.has(e.cle)} aria-label={t("salon.files.choisir", { nom: nomPiece(e) })} onchange={() => basculer(e.cle)} />
        {/if}
        <div class={["bulle", { media }]}>
          {#if !e.moi && premier && !album}<span class="auteur">{nomDe(e)}</span>{/if}
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
          <!-- Effacement (règle du salon) : sablier et temps restant, avant l'heure. -->
          {#if dc}<span class="minuteur" data-decompte><Hourglass size={12} strokeWidth={2} aria-hidden="true" />{#if dc.court}<span aria-hidden="true">{dc.court}</span>{/if}<span class="sr-only">{dc.long}</span></span>{/if}
          <!-- Bas de la bulle, à droite : « modifié », heure, puis accusés (nos messages). -->
          <p class="meta">
            {#if e.modifie && !e.retire}<span class="modifie">{t("salon.room.edited")}</span>{/if}
            <time>{formatClock(e.heureMs, lang)}</time>
            {#if e.moi}
              {@const c = conv.coche(e)}
              <span class={["coche", c, { partiel: vuPartiel(e) }]}>
                {#if c === "attente"}<Clock size={13} strokeWidth={2} aria-hidden="true" />
                {:else if c === "echec"}<TriangleAlert size={13} strokeWidth={2} aria-hidden="true" />
                {:else}
                  <svg class="tic" viewBox="0 0 18 12" width="18" height="12" aria-hidden="true" focusable="false">
                    {#if c === "envoye" && !vuPartiel(e)}<path d="M3.5 6.6l2.9 2.9L13 2.9" />{:else}<path d="M1 6.6l2.9 2.9L10.5 2.9" /><path d="M7.6 9.2l.3.3L14.5 2.9" />{/if}
                  </svg>
                {/if}
                {#if vuPartiel(e)}<span aria-hidden="true">{e.vus.length}/{e.attendus.length}</span>{/if}
                <span class={c === "echec" ? "" : "sr-only"}>{coche(e)}</span>
              </span>
            {/if}
          </p>
        </div>
        {#if !e.retire && e.id}
          <button type="button" class="plus" aria-label={t("salon.room.actions")} aria-expanded={menu === e.cle} onclick={() => (menu = menu === e.cle ? null : e.cle)}><Ellipsis size={18} aria-hidden="true" /></button>
        {/if}
      </div>
      {#if e.reactions.length > 0}
        <ul class="reactions">
          {#each e.reactions as r (r.emoji)}
            <li><button type="button" class={{ mien: r.sieges.includes(conv.moi) }} aria-label="{r.emoji} {r.sieges.length} — {r.sieges.map(nom).join(', ')}" onclick={() => reagir(e, r.emoji)}>{r.emoji} {r.sieges.length}</button></li>
          {/each}
        </ul>
      {/if}
      {#if !e.retire && e.id && menu === e.cle}
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
    </div>
  </li>
{/snippet}

<!-- L'écran du salon, comme une application de messagerie : en-tête, participants (colonne sur
     grand écran, ligne ailleurs), fil qui défile seul, saisie collée en bas. -->
<div bind:this={salon} class={["salon", { replie: !colonne, seul: autres.length === 0 }]} data-salon>
  <header class="tete">
    <div class="ident">
      <span class="pile" aria-hidden="true">
        {#each pile as m (m.s)}<span class={["pp", `c${m.couleur}`]}><Avatar siege={m.s} nom={m.nom} taille={36} /></span>{:else}<span class="pp vide"><Users size={18} /></span>{/each}
      </span>
      <div class="titre">
        <h1 tabindex="-1">{t("title.salon")}</h1>
        <p class="etat">
          <!-- « Noé écrit… » remplace l'état le temps de l'écriture (annoncé poliment). -->
          <span class="ecrit" aria-live="polite">{#if ecrivent.length === 1}{t("salon.room.typing.un", { nom: nom(ecrivent[0]!) })}{:else if ecrivent.length > 1}{t("salon.room.typing.plusieurs")}{/if}</span>
          {#if ecrivent.length === 0}
            <span>{t("salon.room.online", { n: enLigne })}</span><span class="sep" aria-hidden="true">·</span><span class="libres">{t("salon.room.free", { n: libres })}</span><span class="sep libres" aria-hidden="true">·</span>
            <span class="echeance"><Hourglass size={12} strokeWidth={2} aria-hidden="true" /><span class="long">{t("salon.room.expires", { duree: formatDuration(reste, lang, { precise: reste < 300 }) })}</span><span class="court" aria-hidden="true">{formatDuration(reste, lang, { precise: reste < 300 })}</span></span>
          {/if}
        </p>
      </div>
    </div>
    <div class="boutons">
      {#if vue.appels && etatAppel === "aucun"}
        <!-- Lancer un appel : réservé à Plus et Pro. Sans pass sur cet appareil, les deux boutons
             sont dans un cadre étiqueté « Plus · Pro » (et la description des boutons le dit aux
             lecteurs d'écran) ; rejoindre un appel en cours reste ouvert à tous. -->
        <div class={["appels", { reserve: !vue.offreAppel }]} role="group" aria-label={t("salon.appel.groupe")} data-appels>
          {#if !vue.offreAppel}<span class="badge" aria-hidden="true">{t("salon.appel.badge")}</span><span class="sr-only" id="appels-reserve">{t("salon.appel.reserve")}</span>{/if}
          <button type="button" class="ic" aria-label={t("salon.appel.audio")} aria-describedby={vue.offreAppel ? undefined : "appels-reserve"} onclick={() => void S.lancerAppel(false)}><Phone size={20} aria-hidden="true" /></button>
          <button type="button" class="ic" aria-label={t("salon.appel.video")} aria-describedby={vue.offreAppel ? undefined : "appels-reserve"} onclick={() => void S.lancerAppel(true)}><Video size={20} aria-hidden="true" /></button>
        </div>
      {/if}
      {#if silencieux}
        <button type="button" class="ic coupe" aria-label={t("salon.son.reactiver")} onclick={() => S.silencieux(null)}><VolumeX size={20} aria-hidden="true" /></button>
      {:else}
        <button type="button" class="ic" aria-label={t("salon.son.silence")} aria-expanded={choixSilence} onclick={() => (choixSilence = !choixSilence)}><Volume size={20} aria-hidden="true" /></button>
      {/if}
      <button type="button" class="ic" aria-label={t("salon.files.title")} onclick={() => (fichiers = true)}><Folder size={20} aria-hidden="true" /></button>
      <!-- Grand écran : la colonne des participants se replie. -->
      <button type="button" class="ic bascule" aria-label={t("salon.room.presents.afficher")} aria-expanded={colonne} aria-controls="salon-presents" onclick={() => (colonne = !colonne)}><Users size={20} aria-hidden="true" /></button>
      <!-- Participants, règle d'effacement et gestion : dans le panneau. -->
      <button type="button" class="ic" aria-label={t("salon.params")} aria-haspopup="dialog" aria-expanded={params} aria-controls="salon-params" onclick={() => (params = !params)}><SlidersHorizontal size={20} aria-hidden="true" /></button>
    </div>
  </header>

  <!-- Les autres participants : photo, pastille verte ou rouge, et l'état en texte. -->
  <div class="cote" id="salon-presents">
    <p class="cote-t" aria-hidden="true">{t("salon.room.presents")}<span class="nb">{autres.length + 1}</span></p>
    {#if autres.length > 0}
      <ul class="presents" aria-label={t("salon.room.presents")} data-presents>
        {#each autres as m (m.s)}
          <li class={[`c${m.couleur}`, { hors: !m.enLigne }]}>
            <Avatar siege={m.s} nom={m.nom} taille={32} enLigne={m.enLigne} />
            <span class="pq"><bdi class="pn">{m.nom}</bdi><span class="pv">{texteVu(conv.presence.get(m.s), maintenant, lang)}</span></span>
          </li>
        {/each}
      </ul>
    {:else}
      <p class="cote-vide">{t("salon.room.presents.vide")}</p>
    {/if}
  </div>

  <section class="conv" aria-label={t("salon.room.label")} ondragover={(e) => e.dataTransfer?.types.includes("Files") && e.preventDefault()} ondrop={deposer}>
    <!-- Au-dessus du fil : appel, bandeaux, choix du silencieux, sélection. -->
    <div class="hauts">
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
    </div>

    <div class="zone-fil">
      <div class="defile" role="log" aria-live="off" bind:this={zoneFil} onscroll={defile}>
        <ol class="fil" bind:this={listeFil}>
          {#each rangsFil as r (r.cle)}
            {#if r.k === "jour"}
              <li class="jour"><span>{jour(r.ms)}</span></li>
            {:else if r.k === "nouveaux"}
              <li class="sys nouveaux"><span>{t("salon.room.nouveaux")}</span></li>
            {:else if r.k === "sys"}
              <li class="sys"><span>{ligne(r.e)}</span></li>
            {:else if r.k === "msg"}
              {@render message(r.e, r.premier, r.dernier, false)}
            {:else}
              {@const a = r.items[0]!}
              <!-- Album (v3 §14.3) : chaque photo reste un message à part (accusés, réactions, retrait). -->
              <li class={["albums", { moi: a.moi, premier: r.premier, dernier: r.dernier }, `c${conv.couleurDe(a)}`]}>
                {#if !a.moi}<span class="gout" aria-hidden="true">{#if r.premier}<Avatar siege={a.siege} nom={nomDe(a)} taille={32} photo={!a.fige} />{/if}</span>{/if}
                <div class="contenu">
                  {#if !a.moi && r.premier}<span class="auteur">{nomDe(a)}</span>{/if}
                  <ol class="photos" data-n={Math.min(r.items.length, 3)}>
                    {#each r.items as p (p.cle)}{@render message(p, false, false, true)}{/each}
                  </ol>
                </div>
              </li>
            {/if}
          {/each}
        </ol>
      </div>
      {#if nonLus > 0 && !enBas}
        <button type="button" class="bas" aria-label={`${t("salon.room.unread", { n: nonLus })} · ${t("salon.room.down")}`} onclick={() => aller(true)}><ArrowDown size={16} strokeWidth={2} aria-hidden="true" /><span>{t("salon.room.unread", { n: nonLus })}</span></button>
      {/if}
    </div>

    <div class="saisie">
      {#if secondesFin !== null}
        <p class="fin-proche" data-alerte-fin="rebours">{t("salon.fin.rebours", { n: secondesFin })}</p>
      {:else if vue.alerteFin !== null && etatAppel === "dans"}
        <p class="fin-proche" data-alerte-fin="minutes">{t("salon.fin.alerte", { n: vue.alerteFin })}</p>
      {/if}
      {#if attente}<p class="note" role="status">{attente}</p>{/if}
      {#if S.pieces.avertissement}<p class="err" role="status">{t("salon.piece.err.trop_gros")}</p>{/if}
      {#if S.pieces.aConfirmer.length > 0}
        <div class="confirmer" role="group" aria-label={t("salon.piece.nonnettoye")}>
          <p class="note">{t("salon.piece.nonnettoye")}</p>
          <ul>{#each S.pieces.aConfirmer as f, i (i)}<li><bdi>{f.name}</bdi></li>{/each}</ul>
          <div class="choix">
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
            <div class="choix">
              <Button variant="secondary" dense onpress={reprendreDroits}>{t("salon.colle.reprendre")}</Button>
              <Button variant="ghost" dense onpress={fermerColle}>{t("salon.colle.annuler")}</Button>
            </div>
          {:else}
            <p class={vue.gestionCollee === "fait" || vue.gestionCollee === "deja" ? "note" : "err"} role="status">{t(`salon.colle.${vue.gestionCollee}`)}</p>
            <div class="choix"><Button variant="ghost" dense onpress={fermerColle}>{t("salon.colle.fermer")}</Button></div>
          {/if}
        </div>
      {/if}
      {#if erreur}<p class="err" role="alert">{erreur}</p>{/if}
      {#if ralenti !== null}<p class="note" role="status">{t("salon.room.ralenti", { duree: formatDuration(ralenti, lang, { precise: true }) })}</p>{/if}
      {#if tropLong}<div class="choix"><Button variant="secondary" dense onpress={() => {
          if (tropLong) enFichier(tropLong);
        }}>{t("salon.room.toolong.txt")}</Button></div>{/if}
      {#if reponse}
        <div class="contexte">
          <span>{t("salon.room.reply.to", { nom: nomDe(reponse) })}</span>
          <button type="button" aria-label={t("salon.room.reply.cancel")} onclick={() => (reponse = null)}><X size={18} aria-hidden="true" /></button>
        </div>
      {/if}
      {#if edition}
        <div class="contexte">
          <span>{t("salon.room.edit.mode")} — {t("salon.room.edit.note")}</span>
          <button type="button" aria-label={t("salon.room.edit.cancel")} onclick={annulerEdition}><X size={18} aria-hidden="true" /></button>
        </div>
      {/if}
      {#if emojis}<Emojis onpick={(x) => ((texte += x), saisie?.focus())} onclose={() => ((emojis = false), saisie?.focus())} />{/if}
      <!-- Saisie : pièce jointe, champ arrondi qui grandit (émojis au bout), puis le bouton rond :
           « Envoyer » dès qu'il y a du texte, « Message vocal » sinon. -->
      <div class="ligne">
        <button type="button" class="rond outil" aria-label={t("salon.piece.joindre")} onclick={() => joindre?.click()}><Paperclip size={22} aria-hidden="true" /></button>
        <input bind:this={joindre} type="file" multiple hidden onchange={choisis} />
        <div class="champ">
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
          <button type="button" class="emo" aria-label={emojis ? t("salon.room.emoji.close") : t("salon.room.emoji")} aria-expanded={emojis} onclick={() => (emojis = !emojis)}><Smile size={22} aria-hidden="true" /></button>
        </div>
        {#if envoiPossible}
          <button type="button" class="rond envoi" aria-label={t("salon.room.send")} onclick={envoyer}><Send size={20} strokeWidth={2} aria-hidden="true" /></button>
        {:else}
          <button type="button" class="rond vocal" aria-label={t("salon.piece.vocal")} onclick={() => (vocal = true)}><Mic size={22} aria-hidden="true" /></button>
        {/if}
      </div>
    </div>
  </section>
</div>

<Panneau bind:open={params} id="salon-params" title={t("salon.params")}><Membres /></Panneau>
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
  /* ---------- L'écran ---------- */
  /* Toute la fenêtre sous la barre du site (ordinateur) ou toute la partie visible (téléphone) ;
     la page elle-même ne défile plus (html.salon-app), le pied de page attend la sortie. */
  :global(html.salon-app),
  :global(html.salon-app body) {
    overflow: hidden;
    overscroll-behavior: none;
  }
  :global(html.salon-app footer[data-foot]) {
    display: none;
  }
  .salon {
    position: fixed;
    inset: var(--haut, 64px) 0 0 0;
    z-index: 5;
    display: grid;
    grid-template-columns: minmax(0, 1fr) 288px;
    grid-template-rows: auto minmax(0, 1fr);
    grid-template-areas: "tete cote" "conv cote";
    background: var(--bg);
    box-shadow: inset 0 1px 0 var(--hair);
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
    /* Bulles : les autres sur une surface, les miennes en menthe sourde. */
    --b-autre: #1a1e29;
    --b-moi: #153a30;
    --b-moi-meta: #a9d4c4;
    --gout: 40px;
    --marge: clamp(16px, 3vw, 40px);
  }
  .salon.replie {
    grid-template-columns: minmax(0, 1fr) 0;
  }
  .salon.replie .cote {
    display: none;
  }
  @media (max-width: 1099px) {
    .salon {
      grid-template-columns: minmax(0, 1fr);
      grid-template-rows: auto auto minmax(0, 1fr);
      grid-template-areas: "tete" "cote" "conv";
    }
    .salon.replie .cote {
      display: block;
    }
    .salon.seul .cote,
    .ic.bascule {
      display: none;
    }
  }
  /* Téléphone et tablette : plein écran, par-dessus la barre du site, à la hauteur de la partie
     visible (clavier virtuel ouvert compris). */
  @media (max-width: 899px) {
    .salon {
      inset: var(--vv-top, 0px) 0 auto 0;
      height: var(--vv-h, 100dvh);
      z-index: 30;
      box-shadow: none;
      --gout: 36px;
      --marge: 12px;
    }
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

  /* ---------- En-tête compact ---------- */
  .tete {
    grid-area: tete;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--sp-3);
    min-width: 0;
    padding: 12px var(--marge) 10px;
    background: var(--surface-1);
    box-shadow: 0 1px 0 var(--hair);
    z-index: 2;
  }
  .ident {
    display: flex;
    align-items: center;
    gap: var(--sp-3);
    min-width: 0;
  }
  /* Photos empilées des autres participants (la photo du salon : il n'a pas d'autre nom). */
  .pile {
    display: flex;
    flex: none;
  }
  .pp {
    display: inline-flex;
    border-radius: 50%;
    box-shadow: 0 0 0 2px var(--surface-1);
  }
  .pp + .pp {
    margin-inline-start: -14px;
  }
  .pp.vide {
    display: grid;
    place-items: center;
    width: 36px;
    height: 36px;
    background: var(--surface-3);
    color: var(--text-2);
  }
  .titre {
    min-width: 0;
  }
  .tete h1 {
    margin: 0;
    font-size: 1.0625rem;
    font-weight: 650;
    line-height: 1.25;
    letter-spacing: -0.01em;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .tete h1:focus {
    outline: none;
  }
  .etat {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    margin: 1px 0 0;
    color: var(--text-2);
    font-size: 0.8125rem;
    line-height: 1.2rem;
    white-space: nowrap;
    overflow: hidden;
  }
  .etat .sep {
    color: var(--text-3);
  }
  .ecrit:empty {
    margin-inline-end: -6px;
  }
  .ecrit {
    color: var(--accent);
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .echeance {
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }
  .echeance :global(svg) {
    flex: none;
    color: var(--text-3);
  }
  .court {
    display: none;
  }
  .boutons {
    display: flex;
    align-items: center;
    gap: 2px;
    flex: none;
  }
  /* Boutons d'en-tête : icône seule (le libellé est le nom accessible et la bulle d'aide). */
  .ic {
    display: inline-grid;
    place-items: center;
    width: 40px;
    height: 40px;
    padding: 0;
    border: 0;
    border-radius: 12px;
    background: transparent;
    color: var(--text-2);
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
    touch-action: manipulation;
    transition:
      background-color var(--dur-fast) var(--ease-out),
      color var(--dur-fast) var(--ease-out),
      transform var(--dur-press) var(--ease-out);
  }
  @media (hover: hover) {
    .ic:hover {
      background: rgb(255 255 255 / 0.06);
      color: var(--text);
    }
  }
  .ic:active {
    transform: scale(0.92);
  }
  .ic[aria-expanded="true"] {
    background: rgb(255 255 255 / 0.07);
    color: var(--text);
  }
  .ic.coupe {
    color: var(--accent);
  }
  .ic:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
  /* Appels réservés à Plus et Pro : les deux boutons dans un cadre aux couleurs des offres,
     l'étiquette « Plus · Pro » posée sur le filet du haut. Avec un pass : pas de cadre. */
  .appels {
    position: relative;
    display: flex;
    gap: 2px;
    margin-inline-end: 6px;
    padding: 2px;
    border-radius: 14px;
  }
  .appels.reserve {
    padding: 3px;
    background: linear-gradient(135deg, rgb(62 193 245 / 0.08), rgb(92 128 255 / 0.1));
    box-shadow: inset 0 0 0 1px rgb(92 160 255 / 0.42);
  }
  .appels.reserve .ic {
    color: #b8d9ff;
  }
  .badge {
    position: absolute;
    top: 0;
    left: 50%;
    translate: -50% -58%;
    padding: 0 7px;
    border-radius: 999px;
    background: linear-gradient(90deg, var(--plus-tint), var(--pro-tint));
    box-shadow:
      inset 0 0 0 1px rgb(92 160 255 / 0.55),
      0 0 0 2px var(--surface-1);
    color: #d6e9ff;
    font-size: 0.625rem;
    font-weight: 700;
    line-height: 0.9375rem;
    letter-spacing: 0.02em;
    white-space: nowrap;
    pointer-events: none;
  }
  @media (max-width: 599px) {
    .tete {
      gap: var(--sp-2);
      padding-top: calc(12px + env(safe-area-inset-top, 0px));
    }
    .ident {
      gap: 10px;
    }
    .pile .pp:nth-child(n + 2) {
      display: none;
    }
    .etat {
      gap: 4px;
      font-size: 0.75rem;
    }
    .boutons .ic {
      width: 36px;
    }
    .libres {
      display: none;
    }
    .long {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip-path: inset(50%);
      white-space: nowrap;
    }
    .court {
      display: inline;
    }
    .appels {
      margin-inline-end: 2px;
    }
  }
  @media (max-width: 899px) and (min-width: 600px) {
    .tete {
      padding-top: calc(12px + env(safe-area-inset-top, 0px));
    }
  }

  /* ---------- Participants : colonne (grand écran) ou ligne sous l'en-tête ---------- */
  .cote {
    grid-area: cote;
    min-height: 0;
    overflow-y: auto;
    padding: 18px var(--sp-4) var(--sp-4);
    background: var(--surface-1);
    box-shadow: inset 1px 0 0 var(--hair);
    scrollbar-width: thin;
  }
  .cote-t {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    margin: 0 0 var(--sp-3);
    color: var(--text-2);
    font-size: 0.8125rem;
    font-weight: 600;
  }
  .cote-t .nb {
    padding: 0 6px;
    border-radius: 999px;
    background: var(--surface-3);
    color: var(--text-2);
    font-size: 0.75rem;
    font-variant-numeric: tabular-nums;
  }
  .cote-vide {
    margin: 0;
    color: var(--text-3);
    font-size: 0.8125rem;
  }
  .presents {
    display: grid;
    gap: 2px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .presents li {
    display: flex;
    align-items: center;
    gap: var(--sp-3);
    min-width: 0;
    padding: 6px 8px;
    margin-inline: -8px;
    border-radius: 10px;
  }
  .pq {
    display: grid;
    min-width: 0;
    line-height: 1.2;
  }
  .pn {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 0.875rem;
    font-weight: 600;
  }
  .pv {
    color: var(--text-2);
    font-size: 0.75rem;
    white-space: nowrap;
  }
  .presents .hors .pn {
    color: var(--text-2);
  }
  @media (max-width: 1099px) {
    .cote {
      padding: 6px var(--marge);
      overflow: visible;
      box-shadow: 0 1px 0 var(--hair);
      z-index: 1;
    }
    .cote-t {
      display: none;
    }
    .presents {
      display: flex;
      gap: var(--sp-4);
      overflow-x: auto;
      scrollbar-width: none;
    }
    .presents::-webkit-scrollbar {
      display: none;
    }
    .presents li {
      flex: none;
      gap: var(--sp-2);
      padding: 2px 0;
      margin: 0;
    }
    .pn {
      max-width: 12ch;
      font-size: 0.8125rem;
    }
  }

  /* ---------- Conversation : au-dessus du fil, fil, saisie ---------- */
  .conv {
    grid-area: conv;
    min-height: 0;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .hauts {
    flex: none;
    max-height: 55%;
    overflow-y: auto;
    display: grid;
    gap: var(--sp-2);
    padding-inline: var(--marge);
  }
  .hauts > :global(:first-child) {
    margin-top: var(--sp-2);
  }
  .bandeau {
    margin: 0;
    padding: var(--sp-2) var(--sp-3);
    border-radius: 10px;
    background: var(--warn-tint);
    color: var(--warn);
    font-size: var(--fs-small);
  }
  .alerte {
    color: var(--warn, var(--text));
  }
  .silence {
    display: flex;
    flex-wrap: wrap;
    gap: var(--sp-2);
  }
  .barre-sel {
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
  }
  /* Le fil : seul à défiler ; trame de points très discrète, comme un fond d'application. */
  .zone-fil {
    position: relative;
    flex: 1 1 auto;
    min-height: 0;
    background:
      radial-gradient(circle, rgb(233 236 242 / 0.035) 1px, transparent 1.5px) 0 0 / 18px 18px,
      #090b10;
  }
  .defile {
    height: 100%;
    overflow-y: auto;
    overscroll-behavior: contain;
    scrollbar-width: thin;
    scrollbar-color: var(--line-strong) transparent;
  }
  .fil {
    list-style: none;
    margin: 0;
    padding: var(--sp-3) var(--marge) var(--sp-4);
    display: flex;
    flex-direction: column;
    /* Peu de messages : ils se posent en bas, contre la saisie, comme dans une messagerie. */
    min-height: 100%;
    justify-content: flex-end;
    box-sizing: border-box;
  }
  /* Jour : pastille centrée. */
  .jour {
    align-self: center;
    margin: var(--sp-4) 0 var(--sp-2);
    pointer-events: none;
  }
  .jour span,
  .sys span {
    display: inline-block;
    padding: 3px 10px;
    border-radius: 999px;
    background: rgb(26 30 41 / 0.92);
    box-shadow: inset 0 0 0 1px var(--hair);
    color: var(--text-2);
    font-size: 0.75rem;
    font-weight: 560;
    line-height: 1.1rem;
  }
  /* Messages système : centrés, discrets. */
  .sys {
    align-self: center;
    max-width: min(90%, 36rem);
    margin: var(--sp-2) 0;
    text-align: center;
  }
  .sys span {
    background: transparent;
    box-shadow: none;
    color: var(--text-3);
    font-weight: 450;
  }
  .nouveaux {
    align-self: stretch;
    max-width: none;
    display: flex;
    align-items: center;
    gap: var(--sp-3);
  }
  .nouveaux::before,
  .nouveaux::after {
    content: "";
    flex: 1;
    height: 1px;
    background: rgb(95 227 181 / 0.35);
  }
  .nouveaux span {
    color: var(--accent);
    font-weight: 600;
  }

  /* ---------- Messages : séries serrées, nom et photo sur le premier ---------- */
  .msg,
  .albums {
    display: flex;
    align-items: flex-start;
    max-width: 100%;
    margin-top: 10px;
  }
  .msg:not(.premier),
  .albums:not(.premier) {
    margin-top: 2px;
  }
  .msg.moi,
  .albums.moi {
    flex-direction: row-reverse;
  }
  .gout {
    flex: none;
    width: var(--gout);
  }
  .contenu {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    min-width: 0;
    max-width: min(78%, 36rem);
  }
  .moi > .contenu {
    align-items: flex-end;
  }
  .rang {
    display: flex;
    align-items: center;
    gap: 2px;
    max-width: 100%;
  }
  .moi .rang {
    flex-direction: row-reverse;
  }
  /* Bulle : coins de 18 px, resserrés du côté de l'auteur entre deux messages d'une série. */
  .bulle {
    position: relative;
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    column-gap: var(--sp-2);
    min-width: 0;
    padding: 7px 12px 6px;
    border-radius: 18px;
    border-start-start-radius: 6px;
    border-end-start-radius: 6px;
    background: var(--b-autre);
    box-shadow: inset 0 0 0 1px var(--hair);
    overflow-wrap: anywhere;
  }
  .premier .bulle {
    border-start-start-radius: 18px;
  }
  .moi .bulle {
    border-radius: 18px;
    border-start-end-radius: 6px;
    border-end-end-radius: 6px;
    background: var(--b-moi);
    box-shadow: inset 0 0 0 1px rgb(95 227 181 / 0.12);
    /* Textes secondaires (pièces, accusés) teintés de menthe : ≥ 4,5:1 sur la bulle. */
    --text-2: #c6e4d8;
    --text-3: var(--b-moi-meta);
  }
  .moi.premier .bulle {
    border-start-end-radius: 18px;
  }
  .bulle > :global(*) {
    flex-basis: 100%;
  }
  .bulle > .texte,
  .bulle > .retire {
    flex-basis: auto;
    max-width: 100%;
  }
  .bulle > .minuteur,
  .bulle > .meta {
    flex-basis: auto;
  }
  .bulle > .meta {
    margin-inline-start: auto;
  }
  /* Photo ou vidéo : la vignette donne la largeur (bloc, pas de rangée souple qui additionne
     les largeurs de ses enfants). */
  .bulle.media {
    display: block;
    width: min(100%, 22rem);
    padding: 4px 4px 6px;
  }
  .bulle.media :global(.img) {
    width: 100%;
    max-height: 60vh;
    object-fit: cover;
    border-radius: 14px;
  }
  .bulle.media > .minuteur {
    display: flex;
    justify-content: flex-end;
  }
  .bulle.media > .auteur,
  .bulle.media > .meta,
  .bulle.media > .minuteur,
  .bulle.media > .cite {
    margin-inline: 8px;
  }
  .bulle.media > .meta {
    margin-inline-start: auto;
  }
  .bulle.media :global(.legende) {
    padding-inline: 8px;
  }
  .auteur {
    display: block;
    margin-bottom: 1px;
    color: var(--pc);
    font-weight: 650;
    font-size: 0.8125rem;
    line-height: 1.1rem;
  }
  .texte {
    margin: 0;
    white-space: pre-wrap;
    line-height: 1.4;
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
    margin: 2px 0 6px;
    padding: 4px 10px;
    border-radius: 8px;
    background: rgb(255 255 255 / 0.05);
    box-shadow: inset 2px 0 0 var(--pc, var(--line-strong));
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
  .minuteur {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    margin-inline-start: auto;
    color: var(--text-3);
    font-size: 0.6875rem;
    line-height: 1rem;
    white-space: nowrap;
  }
  .minuteur + .meta {
    margin-inline-start: 0;
  }
  .minuteur :global(svg) {
    flex: none;
  }
  /* Bas de la bulle : « modifié », heure, coches ; sur la dernière ligne du texte s'il y a la place. */
  .meta {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 4px;
    margin: 2px 0 0;
    color: var(--text-3);
    font-size: 0.6875rem;
    line-height: 1rem;
    white-space: nowrap;
  }
  .moi .meta,
  .moi .minuteur {
    color: var(--b-moi-meta);
  }
  .coche {
    display: inline-flex;
    align-items: center;
    gap: 3px;
  }
  .tic {
    display: block;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.6;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  /* Lu : deux coches bleues ; envoyé et reçu : de la couleur de l'heure. */
  .coche.vu {
    color: #6cb6ff;
  }
  .coche.echec {
    color: var(--danger);
  }
  /* Réactions : pastilles posées sous la bulle, qui la chevauchent un peu. */
  .reactions {
    list-style: none;
    margin: -4px 8px 0;
    padding: 0;
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    position: relative;
  }
  .reactions button,
  .rapides button {
    min-height: 28px;
    padding: 0 8px;
    border: 0;
    border-radius: 999px;
    background: var(--surface-3);
    box-shadow: 0 0 0 2px #090b10;
    color: var(--text);
    font: inherit;
    font-size: 0.8125rem;
    cursor: pointer;
  }
  .reactions button.mien {
    background: #1d3d35;
    box-shadow:
      0 0 0 2px #090b10,
      inset 0 0 0 1px rgb(95 227 181 / 0.55);
  }
  /* « ⋯ » : à côté de la bulle ; sur ordinateur, il apparaît au survol ou au clavier. */
  .plus {
    display: inline-grid;
    place-items: center;
    flex: none;
    width: 36px;
    height: 36px;
    border: 0;
    border-radius: 50%;
    background: transparent;
    color: var(--text-3);
    cursor: pointer;
    transition:
      opacity var(--dur-fast) var(--ease-out),
      background-color var(--dur-fast) var(--ease-out);
  }
  @media (hover: hover) and (pointer: fine) {
    .plus {
      opacity: 0;
    }
    .msg:hover .plus,
    .plus:focus-visible,
    .plus[aria-expanded="true"] {
      opacity: 1;
    }
    .plus:hover {
      background: rgb(255 255 255 / 0.06);
      color: var(--text);
    }
  }
  .plus[aria-expanded="true"] {
    color: var(--text);
  }
  .plus:focus-visible,
  .rond:focus-visible,
  .emo:focus-visible,
  .bas:focus-visible,
  .contexte button:focus-visible,
  .reactions button:focus-visible,
  .rapides button:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  .actions-msg {
    display: flex;
    flex-wrap: wrap;
    gap: var(--sp-1);
    max-width: min(100%, 26rem);
    margin-top: 6px;
    padding: var(--sp-2);
    border-radius: 14px;
    background: var(--surface-2);
    box-shadow:
      inset 0 0 0 1px var(--hair-2),
      var(--e-2);
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
    box-shadow: none;
    background: var(--surface-3);
  }
  input.sel {
    align-self: center;
    inline-size: 22px;
    block-size: 22px;
    margin: 8px;
    accent-color: var(--accent);
  }
  .choisi .bulle {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }

  /* ---------- Albums : grille de photos, chaque photo est un message ---------- */
  .albums > .contenu {
    max-width: min(78%, 26rem);
  }
  .albums > .contenu > .auteur {
    margin: 0 0 4px 4px;
  }
  .photos {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 3px;
    width: min(100%, 22rem);
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .photos[data-n="3"] {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
  .album {
    margin: 0;
    max-width: none;
  }
  .album > .contenu {
    max-width: none;
    width: 100%;
  }
  .album .rang {
    width: 100%;
    position: relative;
  }
  .album .bulle {
    flex: 1;
    border-radius: 6px;
    padding: 0;
    overflow: hidden;
  }
  .album .bulle > :global(*) {
    margin: 0;
  }
  .album .bulle.media :global(.img) {
    width: 100%;
    aspect-ratio: 1;
    object-fit: cover;
    border-radius: 0;
  }
  .album :global(.legende) {
    display: none;
  }
  /* Heure et coches posées sur la photo, sur un voile sombre. */
  .album .meta {
    position: absolute;
    inset: auto 6px 6px auto;
    padding: 1px 6px;
    border-radius: 999px;
    background: rgb(5 7 10 / 0.6);
    color: #e9ecf2;
  }
  .album .plus {
    position: absolute;
    inset: 4px 4px auto auto;
    width: 32px;
    height: 32px;
    background: rgb(5 7 10 / 0.6);
    color: #e9ecf2;
  }
  .photos > :global(li:first-child .bulle) {
    border-start-start-radius: 16px;
  }
  .albums.moi .photos > :global(li:first-child .bulle) {
    border-start-start-radius: 6px;
  }
  .albums.moi .photos > :global(li:nth-child(2) .bulle) {
    border-start-end-radius: 16px;
  }

  /* ---------- Bouton « nouveaux messages » ---------- */
  .bas {
    position: absolute;
    inset: auto var(--marge) var(--sp-3) auto;
    z-index: 2;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-height: 40px;
    padding: 0 14px;
    border: 0;
    border-radius: 999px;
    background: var(--surface-3);
    box-shadow:
      inset 0 0 0 1px var(--hair-2),
      var(--e-2);
    color: var(--text);
    font: inherit;
    font-size: var(--fs-small);
    font-weight: 560;
    cursor: pointer;
  }

  /* ---------- Saisie ---------- */
  .saisie {
    flex: none;
    display: grid;
    gap: var(--sp-2);
    padding: 10px var(--marge) max(12px, env(safe-area-inset-bottom));
    background: var(--surface-1);
    box-shadow: 0 -1px 0 var(--hair);
    z-index: 1;
  }
  :global(html.kbd-open) .saisie {
    padding-bottom: 10px;
  }
  .ligne {
    display: flex;
    align-items: flex-end;
    gap: var(--sp-2);
  }
  .rond {
    display: inline-grid;
    place-items: center;
    flex: none;
    width: 44px;
    height: 44px;
    padding: 0;
    border: 0;
    border-radius: 50%;
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
    touch-action: manipulation;
    transition:
      background-color var(--dur-fast) var(--ease-out),
      transform var(--dur-press) var(--ease-out);
  }
  .rond:active {
    transform: scale(0.92);
  }
  .outil,
  .vocal {
    background: transparent;
    color: var(--text-2);
  }
  @media (hover: hover) {
    .outil:hover,
    .vocal:hover {
      background: rgb(255 255 255 / 0.06);
      color: var(--text);
    }
    .envoi:hover {
      background: var(--accent-hover);
    }
  }
  .envoi {
    background: var(--accent);
    color: var(--on-accent);
    animation: apparait var(--dur-fast) var(--ease-out);
  }
  .envoi :global(svg) {
    translate: -1px 1px;
  }
  @keyframes apparait {
    from {
      scale: 0.6;
      opacity: 0;
    }
  }
  /* Champ arrondi qui grandit avec le texte ; émojis au bout. */
  .champ {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: flex-end;
    border-radius: 22px;
    background: var(--surface-3);
    box-shadow: inset 0 0 0 1px var(--hair-2);
    transition: box-shadow var(--dur-fast) var(--ease-out);
  }
  .champ:focus-within {
    box-shadow: inset 0 0 0 1.5px rgb(95 227 181 / 0.7);
  }
  textarea {
    flex: 1;
    min-width: 0;
    min-height: 44px;
    max-height: 160px;
    box-sizing: border-box;
    margin: 0;
    padding: 11px 4px 11px 16px;
    border: 0;
    background: transparent;
    color: var(--text);
    font: inherit;
    line-height: 1.375rem;
    resize: none;
    field-sizing: content;
    scrollbar-width: thin;
  }
  textarea::placeholder {
    color: var(--text-3);
  }
  textarea:focus {
    outline: none;
  }
  .emo {
    display: inline-grid;
    place-items: center;
    flex: none;
    width: 44px;
    height: 44px;
    padding: 0;
    border: 0;
    border-radius: 50%;
    background: transparent;
    color: var(--text-2);
    cursor: pointer;
  }
  .emo[aria-expanded="true"] {
    color: var(--accent);
  }
  @media (max-width: 599px) {
    .contenu {
      max-width: min(86%, 36rem);
    }
    .ligne {
      gap: 4px;
    }
    .outil {
      width: 40px;
    }
  }
  .contexte {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--sp-2);
    padding: 2px 2px 2px 12px;
    border-radius: 12px;
    background: var(--surface-2);
    box-shadow: inset 2px 0 0 var(--accent);
    color: var(--text-2);
    font-size: 0.875rem;
  }
  .contexte button {
    display: inline-grid;
    place-items: center;
    min-width: 44px;
    min-height: 44px;
    border: 0;
    background: transparent;
    color: var(--text-2);
    cursor: pointer;
  }
  .fin-proche {
    margin: 0;
    padding: var(--sp-2) var(--sp-3);
    border-radius: 10px;
    background: var(--warn-tint);
    color: var(--warn);
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }
  .confirmer {
    display: grid;
    gap: var(--sp-2);
    padding: var(--sp-2) var(--sp-3);
    border: 1px solid var(--warn);
    border-radius: 12px;
  }
  .confirmer ul {
    margin: 0;
    padding-inline-start: 1.2em;
  }
  .choix {
    display: flex;
    flex-wrap: wrap;
    gap: var(--sp-2);
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
  @media (prefers-reduced-motion: reduce) {
    .ic,
    .rond,
    .plus,
    .champ {
      transition: none;
    }
    .ic:active,
    .rond:active {
      transform: none;
    }
    .envoi {
      animation: none;
    }
  }
  @media (forced-colors: active) {
    .bulle,
    .champ,
    .appels.reserve,
    .badge {
      border: 1px solid CanvasText;
    }
    .ic,
    .rond {
      border: 1px solid ButtonText;
    }
    .auteur {
      text-decoration: underline;
    }
  }
</style>
