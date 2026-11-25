<script lang="ts">
  // « Lien prêt » (UI §9.5) : affiché seulement après la résolution de createShare. L'avertissement
  // « plus jamais affichés » en tête ; un « ticket » : le lien, une perforation, le mot de passe
  // (masqué à l'arrivée), chacun avec sa copie ; ordinateur : l'échéance et la gestion dans une
  // colonne à droite (audit design, lot 2) ; puis « Partager » (feuille : envoyer vers une app, copier le lien et le mot
  // de passe, QR code du lien et du mot de passe, D41-29) et « Copier le lien et le mot de
  // passe » ; lien de gestion replié ; Supprimer ce partage ; « Nouveau partage », discret (rien
  // à valider : le lien marche déjà ; confirmation seulement tant que le lien et le mot de passe
  // n'ont pas été copiés, ready-copies.ts). Les valeurs ne viennent que des props (Copier lit l'état, jamais le
  // DOM) ; rien n'est écrit dans la console, le titre, l'URL ou un stockage.
  import { tick } from "svelte";
  import { getDemo } from "../app/demo-hooks";
  import { formatDuration } from "../i18n/format";
  import { getLang, t } from "../i18n/i18n.svelte";
  import { NotFoundError, destroyShare, shareLinkWithPassword } from "../index";
  import { announce } from "../ui/announce";
  import { arrive } from "../ui/arrive";
  import Button from "../ui/Button.svelte";
  import { copyText } from "../ui/clipboard";
  import CopyField from "../ui/CopyField.svelte";
  import Deadline from "../ui/Deadline.svelte";
  import { Check, Copy, Eye, Lock, Plus, QrCode as QrIcon, Send, Share2, Trash2 } from "../ui/Icon";
  import InlineConfirm from "../ui/InlineConfirm.svelte";
  import Logo from "../ui/Logo.svelte";
  import QrCode from "../ui/QrCode.svelte";
  import { reducedMotion } from "../ui/motion";
  import { canShareLink, haptic, shareText } from "../ui/native";
  import Sheet from "../ui/Sheet.svelte";
  import "../ui/seal.css";
  import { NOTHING_COPIED, confirmLeave, noteCopy, secured, warnOnUnload, type Copied } from "./ready-copies";

  /** `title` : nom du partage tel que le moteur l'a écrit (nettoyé) ; absent sans nom. */
  export type ReadyResult = { link: string; manage: string; expiresInS: number; password: string; title?: string };
  type Props = {
    /** null après Nouveau partage ou Supprimer : plus aucune référence aux secrets. */
    result: ReadyResult | null;
    summary: string;
    ttlHours: number;
    maxOpens: number;
    /** Nouveau partage : retour au composeur vide. */
    ondone: () => void;
    /** Le lien et le mot de passe ont été copiés ou partagés : le Retour ne demande plus rien. */
    onsecured?: () => void;
    /** Le partage est supprimé : oublier les secrets. */
    onforget: () => void;
    /** « Nouvel envoi » après la suppression. */
    onnew: () => void;
  };
  let { result, summary, ttlHours, maxOpens, ondone, onsecured, onforget, onnew }: Props = $props();
  const lang = $derived(getLang());
  const demo = getDemo();

  const selfDestruct = $derived(
    t("ready.selfdestruct", { opens: t("ready.opens", { n: maxOpens }), ttl: formatDuration(ttlHours * 3600, lang) }),
  );

  // ---------- Garde de sortie : jusqu'à la copie des deux, Nouveau partage ou Supprimer (UI §9.5, A12) ----------
  // État en mémoire seulement : quelles valeurs ont été copiées (ou partagées), jamais les valeurs.
  let copies = $state(NOTHING_COPIED);
  let finished = $state(false);
  function copied(what: Copied) {
    const was = secured(copies);
    copies = noteCopy(copies, what);
    if (!was && secured(copies)) onsecured?.();
  }
  // Écouteur posé par <svelte:window> ; l'état est lu au moment de l'événement : une sortie déjà
  // confirmée par la garde du routeur (secrets oubliés, `result` à null) ne redemande rien.
  function warnUnload(e: BeforeUnloadEvent) {
    if (!result || !warnOnUnload(copies, finished)) return;
    e.preventDefault();
    e.returnValue = "";
  }

  // ---------- Arrivée : focus sur le titre, annonce, montée en éventail (M18) ----------
  let heading: HTMLHeadingElement | undefined = $state();
  let panel: HTMLDivElement | undefined = $state();
  $effect(() => {
    if (!heading) return;
    heading.focus({ preventScroll: true });
    haptic();
    announce(t("ready.created"));
  });
  $effect(() => {
    if (!panel || reducedMotion() || typeof panel.animate !== "function") return;
    const blocks = [...panel.querySelectorAll<HTMLElement>("[data-fan]")];
    blocks.forEach((el, i) =>
      el.animate([{ transform: "translateY(14px)", opacity: 0 }, { transform: "none", opacity: 1 }], {
        duration: 520,
        delay: Math.min(i, 2) * 60,
        easing: "cubic-bezier(0.16, 1, 0.3, 1)",
        fill: "backwards",
      }),
    );
  });

  // ---------- Partager (D41-29) : lien et mot de passe ensemble ----------
  // Une seule ouverture par défaut : même envoyés au même endroit, personne d'autre ne pourra
  // voir le contenu ensuite, et le destinataire verrait qu'il a déjà été ouvert (spec D41-29).
  const canShare = canShareLink();
  const both = (r: ReadyResult) => t("ready.share.text", { link: r.link, password: r.password });
  let sheet = $state(false);
  let qrShown = $state(false);
  let copyNote = $state("");
  async function shareApp() {
    if (result && (await shareText(both(result))) === "shared") copied("both");
  }
  async function copyBoth() {
    if (!result) return;
    const r = await copyText(both(result));
    if (r === "copied") copied("both");
    copyNote = r === "copied" ? t("ready.share.copied") : t("ready.share.manual");
    announce(copyNote);
  }
  function openSheet() {
    qrShown = false;
    copyNote = "";
    sheet = true;
  }

  // ---------- Nouveau partage, Supprimer ----------
  function done() {
    finished = true;
    ondone();
  }
  let deleteError = $state("");
  let deleted = $state(false);
  let logo: Logo | undefined = $state();
  let goneTitle: HTMLHeadingElement | undefined = $state();
  async function remove() {
    if (!result) return;
    deleteError = "";
    try {
      await destroyShare(result.manage, location.origin);
    } catch (e) {
      if (!(e instanceof NotFoundError)) {
        deleteError = t("ready.deleted.net");
        return;
      }
    }
    // Après la réponse du serveur seulement : dissolution, puis message (UI §7.4).
    finished = true;
    if (panel && typeof panel.animate === "function") {
      const reduce = reducedMotion();
      const a = panel.animate(
        reduce
          ? [{ opacity: 1 }, { opacity: 0 }]
          : [
              { opacity: 1, filter: "blur(0)", transform: "none" },
              { opacity: 0, filter: "blur(2px)", transform: "translateY(-4px)" },
            ],
        { duration: reduce ? 240 : 400, easing: "cubic-bezier(0.65, 0, 0.35, 1)", fill: "forwards" },
      );
      await a.finished.catch(() => undefined);
    }
    deleted = true;
    onforget();
    await tick();
    arrive(goneTitle);
    announce(t("ready.deleted"));
    await logo?.erase();
  }
</script>

<svelte:window onbeforeunload={warnUnload} />

{#if deleted || !result}
  <section class="gone" aria-labelledby="gone-title">
    <div class="gone-logo"><Logo bind:this={logo} /></div>
    <span class="mini dashed" aria-hidden="true"></span>
    <h1 id="gone-title" class="title" tabindex="-1" bind:this={goneTitle}>{t("ready.deleted")}</h1>
    <p class="lede">{t("ready.deleted.body")}</p>
    <Button variant="primary" onpress={onnew}>{t("ready.new")}</Button>
  </section>
{:else}
  <section class="ready" aria-labelledby="ready-title">
    <div class="panel" bind:this={panel}>
      <header class="hd titre-bandeau" data-fan>
        <span class="mini" aria-hidden="true" data-capsule><Lock size={22} strokeWidth={1.9} /></span>
        <div class="hd-tx">
          <!-- Titre de niveau 1 : le composeur (et son h1) est masqué pendant cet écran. -->
          <h1 id="ready-title" class="title" tabindex="-1" data-large-title bind:this={heading}>{t("ready.title")}</h1>
          <p class="meta num">{summary}</p>
        </div>
      </header>

      <!-- Ordinateur : deux colonnes. À gauche le « ticket » (le lien, une perforation, le mot de
           passe) et l'envoi ; à droite l'échéance et la gestion. Téléphone : une colonne, même
           ordre (celui du DOM : lien, mot de passe, informations, Supprimer, Nouveau partage). -->
      <div class="corps" data-ready-card>
        <div class="gauche">
          <!-- Le ticket : lien, perforation, mot de passe (masqué à l'arrivée, œil pour l'afficher,
               copiable masqué). Rien entre les deux : la paire reste ensemble. -->
          <!-- Apparition propre au ticket (CSS, coupée en mouvement réduit), pas l'éventail data-fan. -->
          <div class="ticket" data-ticket>
            <!-- Coche menthe discrète, à hauteur du libellé : cette valeur a été copiée (ou partagée). -->
            <div class="cell lien" role="group" aria-label={t("ready.link.title")}>
              <CopyField label={t("ready.link.label")} value={result.link} oncopied={() => copied("link")} />
              {#if copies.link}<span class="kept" data-ready-copied><Check size={16} strokeWidth={2.25} aria-hidden="true" /><span class="sr-only">{t("ready.copied")}</span></span>{/if}
            </div>
            <div class="perfo" aria-hidden="true"></div>
            <div class="cell mdp" role="group" aria-label={t("ready.pw.title")}>
              <CopyField label={t("ready.pw.title")} value={result.password} whole secret oncopied={() => copied("password")} />
              {#if copies.password}<span class="kept" data-ready-copied><Check size={16} strokeWidth={2.25} aria-hidden="true" /><span class="sr-only">{t("ready.copied")}</span></span>{/if}
            </div>
          </div>
          <p class="works" data-ready-works>{t("ready.works")}</p>

          <div class="send" data-fan>
            <Button variant="primary" onpress={openSheet} aria-haspopup="dialog">
              {#snippet icon()}<Share2 size={20} strokeWidth={1.75} />{/snippet}
              {t("ready.share")}
            </Button>
            <Button variant="secondary" onpress={copyBoth}>
              {#snippet icon()}<Copy size={20} strokeWidth={1.75} />{/snippet}
              {t("ready.share.both")}
            </Button>
            {#if copyNote && !sheet}<p class="note" role="status">{copyNote}</p>{/if}
          </div>

          {#if demo}
            <div class="demo-zone">
              <Button variant="ghost" dense onpress={() => demo.openAsRecipient(result!.link)}>
                {#snippet icon()}<Eye size={20} strokeWidth={1.75} />{/snippet}
                {t("ready.demo.open")}
              </Button>
              <p class="demo-note" data-demo-note>{demo.readyNote}</p>
            </div>
          {/if}
        </div>

        <div class="droite" data-fan>
          <h2 class="col-t">{t("ready.col.when")}</h2>
          <div class="facts" data-ready-facts>
            <!-- Nom du partage : texte de l'expéditeur, en texte brut, isolé (bdi). -->
            {#if result.title}<p class="name" data-ready-name><span class="sr-only">{t("ready.name")} </span><bdi>{result.title}</bdi></p>{/if}
            <p class="active num"><span class="dot" aria-hidden="true"></span>{t("ready.active")}</p>
            <!-- Heure de fin seule : le serveur l'arrondit au quart d'heure supérieur ;
                 un décompte « 12 h 12 min » à côté de « 12 h » semblait faux. La phrase dit l'arrondi. -->
            <p class="when"><Deadline expiresInS={result?.expiresInS ?? 0} countdown={false} /></p>
            <p class="self">{selfDestruct}</p>
          </div>

          <!-- Le lien de gestion est le seul moyen de suivre ou de supprimer le partage une fois
               cette page fermée (rien n'est gardé sur l'appareil ni dans le compte, spec §33). -->
          <h2 class="col-t sep">{t("ready.col.manage")}</h2>
          <div class="manage" data-manage>
            <CopyField label={t("ready.manage.label")} value={result.manage} />
            <p class="hint">{t("ready.manage.hint")}</p>
          </div>

          <div class="danger-zone">
            <InlineConfirm
              label={t("ready.delete")}
              message={t("ready.delete.confirm")}
              confirmLabel={t("ready.delete.yes")}
              kind="danger"
              triggerVariant="ghost"
              onconfirm={remove}
            >
              {#snippet icon()}<Trash2 size={20} strokeWidth={1.75} />{/snippet}
            </InlineConfirm>
            {#if deleteError}<p class="del-err" role="alert">{deleteError}</p>{/if}
          </div>

          <!-- Pas d'action principale : rien à « terminer », le partage marche déjà. Lien discret. -->
          <div class="done">
            {#if confirmLeave(copies)}
              <InlineConfirm
                label={t("ready.done")}
                message={t("ready.done.confirm")}
                confirmLabel={t("ready.done.yes")}
                kind="warn"
                triggerVariant="ghost"
                onconfirm={done}
              >
                {#snippet icon()}<Plus size={20} strokeWidth={1.75} />{/snippet}
              </InlineConfirm>
            {:else}
              <Button variant="ghost" onpress={done}>
                {#snippet icon()}<Plus size={20} strokeWidth={1.75} />{/snippet}
                {t("ready.done")}
              </Button>
            {/if}
          </div>
        </div>
      </div>
    </div>
  </section>

  <Sheet bind:open={sheet} title={t("ready.share.title")}>
    <div class="choices">
      {#if canShare}
        <Button variant="secondary" onpress={shareApp}>
          {#snippet icon()}<Send size={20} strokeWidth={1.75} />{/snippet}
          {t("ready.share.app")}
        </Button>
      {/if}
      <Button variant="secondary" onpress={copyBoth}>
        {#snippet icon()}<Copy size={20} strokeWidth={1.75} />{/snippet}
        {t("ready.share.both")}
      </Button>
      <Button variant="secondary" aria-expanded={qrShown} onpress={() => void (qrShown = !qrShown)}>
        {#snippet icon()}<QrIcon size={20} strokeWidth={1.75} />{/snippet}
        {qrShown ? t("ready.qr.hide") : t("ready.qr")}
      </Button>
      {#if copyNote}<p class="note" role="status">{copyNote}</p>{/if}
    </div>
    {#if qrShown}
      <figure class="qr">
        <QrCode text={shareLinkWithPassword(result.link, result.password)} label={t("ready.qr.alt")} />
        <figcaption>{t("ready.qr.caption")}</figcaption>
      </figure>
    {/if}
  </Sheet>

{/if}

<style>
  .name {
    margin: 0;
    font-weight: 600;
    color: var(--text);
    overflow-wrap: anywhere;
  }
  /* Échéance en deux lignes (Deadline). */
  .when {
    margin: 0;
    font-size: var(--fs-small);
  }
  .ready,
  .gone {
    width: min(100%, 600px);
    margin-inline: auto;
    padding: var(--sp-6) var(--sp-4) var(--sp-8);
  }
  .panel {
    display: grid;
    gap: var(--sp-5);
  }
  /* Pastille cadenas et titre centrés sur le même axe (avant : pastille en haut, titre décalé). */
  .hd {
    display: flex;
    align-items: center;
    gap: var(--sp-5);
  }
  /* Une colonne (téléphone, tablette), deux à partir de 1024 px : ticket 7/12, gestion 5/12. */
  .corps,
  .gauche,
  .droite {
    display: grid;
    gap: var(--sp-5);
    align-content: start;
    min-width: 0;
  }
  @media (min-width: 1024px) {
    .ready {
      width: min(100%, 1120px);
    }
    .corps {
      grid-template-columns: minmax(0, 7fr) minmax(0, 5fr);
      gap: var(--sp-7);
    }
    .droite {
      padding: var(--sp-5) var(--sp-5) var(--sp-4);
      border: 1px solid var(--hair-2);
      border-radius: var(--r-xl);
      background:
        radial-gradient(120% 60% at 100% 0%, rgb(95 227 181 / 0.06), transparent 60%),
        var(--vessel);
      box-shadow: var(--edge-hi);
    }
    .droite .facts {
      padding-top: 0;
      border-top: 0;
    }
  }

  /* Colonne de droite : deux groupes titrés (l'échéance, puis le suivi et la suppression),
     l'heure de fin en grand, la phrase en petit ; « Nouveau partage » en bas, discret. */
  .col-t {
    margin: 0;
    color: var(--text-3);
    font-size: var(--fs-micro);
    font-weight: 650;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .col-t.sep {
    padding-top: var(--sp-4);
    border-top: 1px solid var(--hair-2);
  }
  .droite {
    gap: var(--sp-4);
  }
  .droite .facts {
    gap: var(--sp-2);
  }
  .droite .when {
    font-size: var(--fs-h3);
    line-height: 1.3;
  }
  .droite .self {
    font-size: var(--fs-small);
    line-height: var(--lh-small, 1.45);
  }

  /* ---------- Le ticket ----------
     Un objet : relief fin (filet clair en haut, ombre portée), bord menthe lumineux, deux parties
     séparées par une perforation : vraies encoches découpées (masque, le fond passe au travers) et
     rangée de trous ronds. En haut le lien (papier sombre), en bas le mot de passe (nuit). */
  .ticket {
    --encoche: 13px;
    --bord: rgb(95 227 181 / 0.32);
    position: relative;
    display: grid;
    min-width: 0;
    filter: drop-shadow(0 1px 0 rgb(255 255 255 / 0.04)) drop-shadow(0 22px 30px rgb(0 0 0 / 0.5)) drop-shadow(0 0 22px rgb(95 227 181 / 0.08));
    animation: ticket-arrive 640ms cubic-bezier(0.16, 1, 0.3, 1) 80ms backwards;
  }
  .ticket .cell {
    position: relative;
    isolation: isolate;
    overflow: hidden;
  }
  .ticket .lien {
    padding: var(--sp-5) var(--sp-5) calc(var(--sp-5) + 2px);
    border-radius: var(--r-xl) var(--r-xl) 0 0;
    background:
      radial-gradient(120% 90% at 0% 0%, rgb(255 255 255 / 0.06), transparent 55%),
      linear-gradient(180deg, #232938, #1a1f2b);
    box-shadow:
      inset 0 1px 0 var(--bord),
      inset 0 2px 0 rgb(255 255 255 / 0.06),
      inset 1px 0 0 var(--bord),
      inset -1px 0 0 var(--bord);
    -webkit-mask:
      radial-gradient(circle var(--encoche) at 0 100%, #0000 98%, #000) left / 51% 100% no-repeat,
      radial-gradient(circle var(--encoche) at 100% 100%, #0000 98%, #000) right / 51% 100% no-repeat;
    mask:
      radial-gradient(circle var(--encoche) at 0 100%, #0000 98%, #000) left / 51% 100% no-repeat,
      radial-gradient(circle var(--encoche) at 100% 100%, #0000 98%, #000) right / 51% 100% no-repeat;
  }
  .ticket .mdp {
    padding: calc(var(--sp-5) + 2px) var(--sp-5) var(--sp-5);
    border-radius: 0 0 var(--r-xl) var(--r-xl);
    background:
      radial-gradient(90% 120% at 100% 100%, rgb(95 227 181 / 0.1), transparent 60%),
      linear-gradient(180deg, #0f1c19, #080b0e);
    box-shadow:
      inset 1px 0 0 var(--bord),
      inset -1px 0 0 var(--bord),
      inset 0 -1px 0 var(--bord);
    -webkit-mask:
      radial-gradient(circle var(--encoche) at 0 0, #0000 98%, #000) left / 51% 100% no-repeat,
      radial-gradient(circle var(--encoche) at 100% 0, #0000 98%, #000) right / 51% 100% no-repeat;
    mask:
      radial-gradient(circle var(--encoche) at 0 0, #0000 98%, #000) left / 51% 100% no-repeat,
      radial-gradient(circle var(--encoche) at 100% 0, #0000 98%, #000) right / 51% 100% no-repeat;
  }
  /* Reflet qui traverse le haut du ticket une fois, à l'arrivée. */
  .ticket .lien::after {
    content: "";
    position: absolute;
    inset: 0;
    z-index: -1;
    background: linear-gradient(105deg, transparent 35%, rgb(255 255 255 / 0.07) 50%, transparent 65%) -100% 0 / 200% 100% no-repeat;
    animation: ticket-reflet 1.4s cubic-bezier(0.65, 0, 0.35, 1) 420ms both;
    pointer-events: none;
  }
  /* Perforation : une rangée de trous ronds entre les deux encoches. */
  .perfo {
    position: relative;
    z-index: 1;
    height: 0;
    margin-inline: calc(var(--encoche) + 6px);
  }
  .perfo::before {
    content: "";
    position: absolute;
    inset: -3px 0 auto;
    height: 6px;
    background: radial-gradient(circle at 3px 3px, rgb(0 0 0 / 0.75) 2.2px, rgb(255 255 255 / 0.08) 2.6px, transparent 3px) 0 0 / 11px 6px repeat-x;
  }
  .perfo::after {
    display: none;
  }
  @keyframes ticket-arrive {
    from {
      opacity: 0;
      transform: translateY(18px) rotate(-0.6deg) scale(0.98);
    }
  }
  @keyframes ticket-reflet {
    to {
      background-position: 200% 0;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .ticket,
    .ticket .lien::after {
      animation: none;
    }
  }

  /* Copiée : petite coche menthe en haut à droite de la case, à hauteur du libellé. */
  .kept {
    position: absolute;
    top: var(--sp-5);
    inset-inline-end: var(--sp-5);
    display: grid;
    place-items: center;
    width: 22px;
    height: 22px;
    margin-top: -3px;
    border-radius: 50%;
    background: var(--accent-tint);
    color: var(--accent);
    /* Retour du geste : la coche se pose (fondu et léger grossissement), une fois. */
    animation: kept-in var(--dur-base) var(--ease-out) both;
  }
  @keyframes kept-in {
    from {
      opacity: 0;
      transform: scale(0.6);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .kept {
      animation: none;
    }
  }
  .ticket .mdp .kept {
    top: calc(var(--sp-5) + 2px);
  }
  .works {
    margin: 0;
    font-size: var(--fs-small);
    color: var(--text-2);
  }

  /* Valeurs dans le ticket : une seule boîte par valeur, « Copier » intégré à droite ; police
     à chasse fixe, chiffres tabulaires, zéro barré. Copié : bord et bouton menthe (2 s). */
  .ticket :global(.cf) {
    gap: var(--sp-3);
  }
  .ticket :global(.cf .lbl) {
    color: var(--text-3);
    font-size: var(--fs-micro);
    font-weight: 650;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .ticket :global(.cf .row) {
    gap: 0;
    padding: 4px;
    border: 1px solid rgb(233 236 242 / 0.12);
    border-radius: 14px;
    background: rgb(0 0 0 / 0.28);
    box-shadow: inset 0 1px 2px rgb(0 0 0 / 0.35);
    transition:
      border-color var(--dur-fast) var(--ease-out),
      box-shadow var(--dur-fast) var(--ease-out);
  }
  .ticket :global(.cf .val) {
    border: 0;
    background: transparent;
    font-variant-numeric: tabular-nums slashed-zero;
    font-feature-settings: "tnum", "zero";
  }
  .ticket .lien :global(.cf .val) {
    font-size: 0.9375rem;
    color: var(--text);
  }
  .ticket .mdp :global(.cf .val) {
    font-size: 1.1875rem;
    letter-spacing: 0.08em;
    color: #f3fff9;
  }
  .ticket .mdp :global(.cf .val.masked) {
    color: var(--text-2);
  }
  .ticket :global(.cf .row > .btn) {
    flex: none;
    min-height: 44px;
    border-radius: 10px;
  }
  .ticket :global(.cf[data-copied] .row) {
    border-color: rgb(95 227 181 / 0.6);
    box-shadow:
      inset 0 1px 2px rgb(0 0 0 / 0.35),
      0 0 0 3px rgb(95 227 181 / 0.12);
  }
  .ticket :global(.cf[data-copied] .row > .btn) {
    background: var(--accent-tint);
    border-color: rgb(95 227 181 / 0.5);
    color: var(--accent);
  }
  @media (forced-colors: active) {
    .ticket .lien,
    .ticket .mdp {
      border: 1px solid CanvasText;
      -webkit-mask: none;
      mask: none;
    }
    .perfo::before {
      border-top: 1px dashed CanvasText;
      background: none;
    }
  }
  .demo-zone {
    display: grid;
    justify-items: start;
    gap: var(--sp-1);
  }
  .mini {
    flex: none;
    display: grid;
    place-items: center;
    width: 96px;
    height: 60px;
    border: 2px solid var(--accent);
    border-radius: var(--r-pill);
    background: var(--accent-tint);
    color: var(--accent);
    view-transition-name: capsule;
  }
  .mini.dashed {
    border-style: dashed;
    border-color: var(--line-strong);
    background: transparent;
  }
  .hd-tx {
    display: grid;
    gap: var(--sp-1);
    min-width: 0;
  }
  .title {
    margin: 0;
    font-size: var(--fs-ready);
    font-stretch: var(--wd-ready);
    letter-spacing: var(--ls-ready);
    line-height: 1.05;
  }
  .title:focus {
    outline: none;
  }
  .meta,
  .self {
    margin: 0;
    color: var(--text-2);
  }
  .active {
    margin: 0;
    display: inline-flex;
    align-items: center;
    gap: var(--sp-2);
    justify-self: start;
    padding: 2px var(--sp-3);
    border-radius: var(--r-pill);
    background: var(--accent-tint);
    color: var(--accent);
    font-size: var(--fs-small);
    font-weight: 600;
  }
  .active .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--accent);
  }
  .hint {
    margin: 0;
    font-size: var(--fs-small);
    color: var(--text-2);
  }
  .send {
    display: flex;
    flex-wrap: wrap;
    gap: var(--sp-3);
    align-items: center;
  }
  .choices {
    display: grid;
    gap: var(--sp-2);
  }
  .choices :global(.btn) {
    width: 100%;
    justify-content: flex-start;
  }
  .note {
    margin: 0;
    flex-basis: 100%;
    font-size: var(--fs-small);
    color: var(--text-2);
  }
  .qr {
    margin: var(--sp-4) 0 0;
    display: grid;
    justify-items: start;
    gap: var(--sp-2);
  }
  .qr figcaption {
    font-size: var(--fs-small);
    color: var(--text-2);
  }
  .cell {
    min-width: 0;
  }
  .facts {
    display: grid;
    gap: var(--sp-1);
    padding-top: var(--sp-3);
    border-top: 1px solid var(--hair-2);
  }
  .manage {
    display: grid;
    gap: var(--sp-2);
  }
  .done {
    display: grid;
    justify-items: start;
    padding-top: var(--sp-3);
    border-top: 1px solid var(--hair-2);
  }
  .danger-zone {
    display: grid;
    justify-items: start;
    gap: var(--sp-2);
  }
  .danger-zone :global(button.ghost) {
    color: var(--danger);
  }
  .del-err {
    margin: 0;
    color: var(--danger);
  }
  @media (max-width: 759px) {
    .ready {
      padding: var(--sp-2) 0 0;
    }
    .panel {
      gap: var(--sp-4);
    }
    .hd {
      gap: var(--sp-4);
      align-items: center;
    }
    .hd-tx {
      gap: var(--sp-2);
    }
    .mini {
      width: 56px;
      height: 56px;
    }
    .ticket .lien {
      padding: var(--sp-4);
      border-radius: var(--r-lg) var(--r-lg) 0 0;
    }
    .ticket .mdp {
      padding: var(--sp-4);
      border-radius: 0 0 var(--r-lg) var(--r-lg);
    }
    .ticket .kept,
    .ticket .mdp .kept {
      top: var(--sp-4);
      inset-inline-end: var(--sp-4);
    }
    .send {
      display: grid;
    }
    .send :global(.btn) {
      width: 100%;
      justify-content: center;
    }
    .danger-zone {
      justify-items: stretch;
    }
    /* « Nouveau partage » dans le fil, jamais collé en bas (rien à valider). */
    .done {
      justify-items: stretch;
      margin-block-end: var(--sp-4);
    }
  }
  .gone {
    display: grid;
    justify-items: start;
    gap: var(--sp-4);
  }
  .gone-logo {
    width: 180px;
  }
  .lede {
    margin: 0;
    color: var(--text-2);
  }
  /* Démo seulement : la mention qui remplace le texte du bandeau. */
  .demo-note {
    margin: var(--sp-2) 0 0;
    color: var(--warn);
    font-size: var(--fs-small);
  }
</style>
