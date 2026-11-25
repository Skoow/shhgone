<script lang="ts">
  // « Lien prêt » (UI §9.5) : affiché seulement après la résolution de createShare. L'avertissement
  // « plus jamais affichés » en tête ; un « ticket » : le lien, une perforation, le mot de passe
  // (masqué à l'arrivée), chacun avec sa copie ; ordinateur : l'échéance et la gestion dans une
  // colonne à droite (audit design, lot 2) ; puis « Partager » (feuille : envoyer vers une app, copier le lien et le mot
  // de passe, QR code du lien et du mot de passe, D41-29) et « Copier le lien et le mot de
  // passe » ; lien de gestion replié ; Supprimer ce partage (secondaire) ; Terminé (principal,
  // collé en bas sur téléphone). Les valeurs ne viennent que des props (Copier lit l'état, jamais le
  // DOM) ; rien n'est écrit dans la console, le titre, l'URL ou un stockage.
  import { tick, untrack } from "svelte";
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
  import { ClipboardX, Copy, Eye, Lock, QrCode as QrIcon, Send, Share2, Trash2 } from "../ui/Icon";
  import InlineConfirm from "../ui/InlineConfirm.svelte";
  import Logo from "../ui/Logo.svelte";
  import QrCode from "../ui/QrCode.svelte";
  import { reducedMotion } from "../ui/motion";
  import { canShareLink, haptic, shareText } from "../ui/native";
  import Sheet from "../ui/Sheet.svelte";
  import Switch from "../ui/Switch.svelte";
  import { forgetShare, keepSentDefault, loadHistory, markDestroyed, recordShare, setHistoryEnabled, shares } from "../history/live.svelte";
  import "../ui/seal.css";

  /** `title` : nom du partage tel que le moteur l'a écrit (nettoyé) ; absent sans nom. */
  export type ReadyResult = { link: string; manage: string; expiresInS: number; password: string; title?: string };
  type Props = {
    /** null après Terminé ou Supprimer : plus aucune référence aux secrets. */
    result: ReadyResult | null;
    summary: string;
    ttlHours: number;
    maxOpens: number;
    /** Pour l'historique local (spec §33.1) : nombre d'éléments et taille, jamais leurs noms. */
    itemsCount: number;
    sizeBytes: number;
    /** Terminé : retour au composeur vide. */
    ondone: () => void;
    /** Le partage est supprimé : oublier les secrets. */
    onforget: () => void;
    /** « Nouvel envoi » après la suppression. */
    onnew: () => void;
  };
  let { result, summary, ttlHours, maxOpens, itemsCount, sizeBytes, ondone, onforget, onnew }: Props = $props();
  const lang = $derived(getLang());
  const demo = getDemo();

  const selfDestruct = $derived(
    t("ready.selfdestruct", { opens: t("ready.opens", { n: maxOpens }), ttl: formatDuration(ttlHours * 3600, lang) }),
  );

  // ---------- « Garder dans mon historique » (spec §33, §33.1) ----------
  // Désactivé par défaut, avec ou sans compte (keepSentDefault), le
  // lien de gestion est alors montré ici ; activé par la personne, le réglage vaut pour les envois
  // suivants. Une fois activé, gardé dès l'affichage (fermer l'onglet
  // sans « Terminé » ne le perd pas) : le lien de gestion,
  // l'heure locale, la taille, le nombre d'éléments, l'échéance, le maximum d'ouvertures et le
  // nom du partage ; jamais le lien de partage, le mot de passe ni les noms des
  // éléments. Désactiver retire l'entrée et vaut pour les prochains envois. Opérations à la file : une bascule rapide garde l'ordre.
  const createdAt = Date.now();
  let keep = $state(false);
  let keepReady = $state(false);
  let keepId: string | null = $state(null); // lu par data-kept : entrée réellement écrite
  let chain: Promise<void> = Promise.resolve();
  const queue = (fn: () => Promise<void>) => (chain = chain.then(fn).catch(() => undefined));
  async function save() {
    const r = result;
    if (!r || keepId) return;
    // Nom du partage : gardé dans l'entrée, chiffrée comme le reste (history/store.ts).
    keepId = await recordShare({ manage: r.manage, createdAt, sizeBytes, itemsCount, expiresAt: createdAt + r.expiresInS * 1000, maxOpens, ...(r.title ? { label: r.title } : {}) });
  }
  $effect(() => {
    untrack(() =>
      queue(async () => {
        await loadHistory();
        keep = shares.status === "ready" && keepSentDefault();
        keepReady = true;
        if (keep) await save();
      }),
    );
  });
  function setKeep(v: boolean) {
    keep = v;
    void queue(async () => {
      await setHistoryEnabled(v);
      if (v) await save();
      else if (keepId) {
        const id = keepId;
        keepId = null;
        await forgetShare(id);
      }
    });
  }

  // ---------- Garde de sortie : jusqu'à Terminé ou Supprimer (UI §9.5, A12) ----------
  let guarded = $state(true);
  $effect(() => {
    if (!guarded) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  });

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
    if (result) await shareText(both(result));
  }
  async function copyBoth() {
    if (!result) return;
    const r = await copyText(both(result));
    copyNote = r === "copied" ? t("ready.share.copied") : t("ready.share.manual");
    announce(copyNote);
  }
  function openSheet() {
    qrShown = false;
    copyNote = "";
    sheet = true;
  }

  // ---------- Terminé, Supprimer ----------
  function done() {
    guarded = false;
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
    guarded = false;
    void queue(async () => {
      if (keepId) await markDestroyed(keepId);
    });
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
           ordre (celui du DOM : avertissement, lien, mot de passe, informations, Supprimer, Terminé). -->
      <div class="corps" data-ready-card>
        <div class="gauche">
          <p class="never" data-fan><ClipboardX size={18} strokeWidth={1.75} aria-hidden="true" />{t("ready.never")}</p>

          <!-- Le ticket : lien, perforation, mot de passe (masqué à l'arrivée, œil pour l'afficher,
               copiable masqué). Rien entre les deux : la paire reste ensemble. -->
          <div class="ticket" data-fan data-ticket>
            <div class="cell lien" role="group" aria-label={t("ready.link.title")}><CopyField label={t("ready.link.label")} value={result.link} /></div>
            <div class="perfo" aria-hidden="true"></div>
            <div class="cell mdp" role="group" aria-label={t("ready.pw.title")}><CopyField label={t("ready.pw.title")} value={result.password} whole secret /></div>
          </div>

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
          <div class="facts" data-ready-facts>
            <!-- Nom du partage : texte de l'expéditeur, en texte brut, isolé (bdi). -->
            {#if result.title}<p class="name" data-ready-name><span class="sr-only">{t("ready.name")} </span><bdi>{result.title}</bdi></p>{/if}
            <p class="active num"><span class="dot" aria-hidden="true"></span>{t("ready.active")}</p>
            <!-- Heure de fin seule : le serveur l'arrondit au quart d'heure supérieur ;
                 un décompte « 12 h 12 min » à côté de « 12 h » semblait faux. La phrase dit l'arrondi. -->
            <p class="when"><Deadline expiresInS={result?.expiresInS ?? 0} countdown={false} /></p>
            <p class="self">{selfDestruct}</p>
          </div>

          <!-- « Gérer ce partage » retiré : avec l'historique, le partage se
               suit et se supprime depuis « Mes partages ». Sans historique, le lien de gestion est le
               seul moyen de le suivre ou de le supprimer plus tard : il est alors montré ici. -->
          <div class="keep" data-keep data-kept={keepId ? "" : undefined}>
            {#if keepReady && shares.status === "unavailable"}
              <p class="hint" data-keep-unavailable>{t("ready.keep.unavailable")}</p>
            {:else}
              <Switch label={t("ready.keep")} hint={t("ready.keep.hint")} checked={keep} disabled={!keepReady} onchange={setKeep} />
            {/if}
            {#if keepReady && (!keep || shares.status === "unavailable")}
              <div class="manage" data-manage>
                <CopyField label={t("ready.manage.label")} value={result.manage} />
                <p class="hint">{t("ready.manage.hint")}</p>
              </div>
            {/if}
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

          <div class="done">
            <InlineConfirm
              label={t("ready.done")}
              message={t("ready.done.confirm")}
              confirmLabel={t("ready.done.yes")}
              triggerVariant="primary"
              onconfirm={done}
            />
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
      padding: var(--sp-5);
      border: 1px solid var(--hair-2);
      border-radius: var(--r-xl);
      background: var(--vessel);
      box-shadow: var(--edge-hi);
    }
    .droite .when {
      font-size: var(--fs-h3);
    }
    .droite .facts {
      padding-top: 0;
      border-top: 0;
    }
  }
  /* Le ticket : le lien en haut, une perforation (pointillé et deux encoches), le mot de passe
     en bas sur fond nuit, bord menthe : la paire à donner ensemble. */
  .ticket {
    display: grid;
    min-width: 0;
    border-radius: var(--r-xl);
    box-shadow: var(--edge-hi);
    filter: drop-shadow(0 24px 32px rgb(0 0 0 / 0.45));
  }
  .ticket .lien {
    padding: var(--sp-5) var(--sp-5) var(--sp-4);
    border: 1px solid var(--hair-2);
    border-bottom: 0;
    border-radius: var(--r-xl) var(--r-xl) 0 0;
    background: linear-gradient(180deg, var(--surface-3), var(--surface-2));
  }
  .ticket .mdp {
    padding: var(--sp-4) var(--sp-5) var(--sp-5);
    border: 1px solid rgb(95 227 181 / 0.45);
    border-top: 0;
    border-radius: 0 0 var(--r-xl) var(--r-xl);
    background: linear-gradient(180deg, #0d1a17, var(--bg-deep));
  }
  .perfo {
    position: relative;
    height: 0;
    border-top: 2px dashed var(--line-strong);
    margin-inline: 14px;
  }
  .perfo::before,
  .perfo::after {
    content: "";
    position: absolute;
    top: -13px;
    width: 24px;
    height: 24px;
    border-radius: 50%;
    background: var(--bg);
  }
  .perfo::before {
    left: -27px;
  }
  .perfo::after {
    right: -27px;
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
  .never {
    max-width: none;
    margin: 0;
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    padding: var(--sp-3) var(--sp-4);
    border-radius: var(--r-md);
    background: var(--warn-tint);
    color: var(--text);
    font-weight: 560;
  }
  .never :global(svg) {
    flex: none;
    color: var(--warn);
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
  .keep {
    display: grid;
    gap: var(--sp-3);
  }
  .manage {
    display: grid;
    gap: var(--sp-2);
  }
  .done {
    display: grid;
    justify-items: start;
    padding-top: var(--sp-4);
    border-top: 1px solid var(--line);
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
    .send {
      display: grid;
    }
    .send :global(.btn) {
      width: 100%;
      justify-content: center;
    }
    /* Supprimer reste loin de la barre collée de Terminé (pas de geste raté). */
    .danger-zone {
      justify-items: stretch;
      margin-block-end: var(--sp-6);
    }
    /* Terminé, l'action principale, sous le pouce ; la suppression reste dans le fil. */
    .done {
      position: sticky;
      bottom: 0;
      z-index: 2;
      justify-items: stretch;
      margin-inline: calc(-1 * var(--sp-4));
      padding: var(--sp-2) var(--sp-4) calc(var(--sp-2) + env(safe-area-inset-bottom));
      background: var(--bg);
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
