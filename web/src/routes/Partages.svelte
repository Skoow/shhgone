<script lang="ts">
  // « Mes partages » (/envois ; spec §33, D42-30) : les partages envoyés et les salons créés sur
  // cet appareil, gardés d'office (storage/partages.svelte.ts), et ceux du compte s'il est ouvert.
  // D'abord l'état LOCAL (lecture d'IndexedDB, aucune requête) ; puis, page visible, une relecture
  // des envois actifs dont l'état date de plus de 5 min, l'un après l'autre, après une gigue
  // (storage/partages-relecture.ts). Jamais en arrière-plan, aucune boucle.
  // Par entrée : état (mot et icône), ouvertures, échéance, taille et nombre d'éléments, nom du
  // partage ; « Supprimer » (destruction par le lien de gestion, pour tout le monde) et « Retirer
  // de la liste » (sur l'appareil et dans le compte ; le partage n'est pas détruit). Un salon :
  // « Gérer le salon » (sa page de gestion, qui peut le détruire) et « Copier l'invitation ».
  // Une entrée finie est retirée 7 jours après sa fin. Jamais le lien de partage ni le mot de passe.
  import { untrack } from "svelte";
  import { accountFlag } from "../app/account-flag.svelte";
  import { followLink, href, navigate } from "../app/router.svelte";
  import { formatBytes, formatDayTime, formatDuration } from "../i18n/format";
  import { getLang, t } from "../i18n/i18n.svelte";
  import { arreterRelecture, chargerPartages, detruirePartage, mesPartages, relirePartages, retirerPartage } from "../storage/partages.svelte";
  import { estActif, etatVu, type Partage } from "../storage/partages";
  import { announce } from "../ui/announce";
  import Button from "../ui/Button.svelte";
  import { copyText } from "../ui/clipboard";
  import EmptyState from "../ui/EmptyState.svelte";
  import { Copy, MessagesSquare, Plus, Trash2, X } from "../ui/Icon";
  import InlineConfirm from "../ui/InlineConfirm.svelte";
  import PageHeader from "../ui/PageHeader.svelte";
  import StateChip from "../ui/StateChip.svelte";

  const lang = $derived(getLang());
  let now = $state(Date.now());
  $effect(() => {
    untrack(() =>
      void chargerPartages().then(async () => {
        if (document.visibilityState === "visible") await relirePartages().catch(() => undefined);
      }),
    );
    const id = setInterval(() => (now = Date.now()), 30_000);
    const retour = () => {
      if (document.visibilityState === "visible") now = Date.now();
    };
    document.addEventListener("visibilitychange", retour);
    return () => {
      arreterRelecture();
      clearInterval(id);
      document.removeEventListener("visibilitychange", retour);
    };
  });

  const actifs = $derived(mesPartages.liste.filter((p) => estActif(p, now)).length);
  const finis = $derived(mesPartages.liste.length - actifs);

  let title: HTMLHeadingElement | undefined = $state();
  $effect(() => {
    if (title) untrack(() => title?.focus({ preventScroll: true }));
  });

  /** État pour StateChip (mêmes mots que la page de gestion). */
  const CHIP = { actif: "ready", epuise: "draining", detruit: "gone", expire: "expired" } as const;
  const etat = (p: Partage) => CHIP[etatVu(p, now)];
  // L'échéance du serveur est au quart d'heure ; arrondie à la minute pour l'affichage.
  const finVers = (p: Partage) => formatDayTime(Math.round((etatVu(p, now) === "expire" ? p.echeance : p.finLe || p.echeance) / 60_000) * 60_000, lang);
  const erreurTexte = (p: Partage) => {
    const e = mesPartages.erreurs[p.id];
    return e === "reseau" ? t("shares.err.reseau") : e === "limite" ? t("shares.err.limite") : e === "serveur" ? t("shares.err.serveur") : "";
  };

  async function supprimer(p: Partage) {
    if (await detruirePartage(p.id)) announce(t("shares.destroyed"));
  }
  async function retirer(p: Partage) {
    await retirerPartage(p.id);
    announce(t("shares.removed"));
  }
  let copie = $state<{ id: string; texte: string } | null>(null);
  async function copierInvitation(p: Partage) {
    const r = await copyText(p.invitation);
    copie = { id: p.id, texte: r === "copied" ? t("shares.invite.copied") : t("shares.copy.manual") };
    announce(copie.texte);
  }
</script>

<section class="parts" aria-labelledby="p-title" aria-busy={mesPartages.statut === "attente" || mesPartages.statut === "lecture" ? "true" : undefined}>
  <PageHeader id="p-title" title={t("shares.title")} bind:titleEl={title}>
    {#if mesPartages.statut === "pret" && mesPartages.liste.length > 0}
      <p class="counts num" data-counts>{t("shares.count.active", { n: actifs })} · {t("shares.count.ended", { n: finis })}</p>
    {/if}
    {#snippet actions()}
      <Button variant="primary" onpress={() => navigate("/envoyer")}>
        {#snippet icon()}<Plus size={20} strokeWidth={2} />{/snippet}
        {t("shares.new")}
      </Button>
    {/snippet}
  </PageHeader>

  {#if mesPartages.statut === "indisponible"}
    <EmptyState title={t("shares.unavailable.title")} data-shares-unavailable>
      <p>{t("shares.unavailable.body")}</p>
    </EmptyState>
  {:else if mesPartages.statut !== "pret"}
    <ul class="list" role="list" aria-label={t("shares.loading")}>
      {#each [0, 1] as k (k)}<li class="skel" aria-hidden="true"></li>{/each}
    </ul>
  {:else if mesPartages.liste.length === 0}
    <EmptyState title={t("shares.empty.title")} data-shares-empty>
      {#snippet art()}
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
          <path d="M14 3v5h5M9 13h6M9 17h4" />
        </svg>
      {/snippet}
      <p>{t("shares.empty.body")}</p>
      <a class="cta" href={href("/envoyer")} onclick={(e) => followLink(e, "/envoyer")}>{t("shares.empty.cta")}</a>
    </EmptyState>
  {:else}
    <ul class="list" role="list">
      {#each mesPartages.liste as p (p.id)}
        {@const vu = etatVu(p, now)}
        {@const actif = vu === "actif" || vu === "epuise"}
        {@const err = erreurTexte(p)}
        <li class={["card", { fini: !actif }]} data-share-card data-sorte={p.sorte} data-state={vu}>
          <div class="hd">
            {#if p.sorte === "salon"}
              <p class="name"><MessagesSquare size={18} strokeWidth={1.8} aria-hidden="true" /> {t("shares.room")}</p>
            {:else if p.nom}
              <p class="name" data-share-title><bdi translate="no">{p.nom}</bdi></p>
            {:else}
              <p class="name">{t("shares.share")}</p>
            {/if}
            <StateChip state={etat(p)} destroyedHere={p.detruitIci} />
          </div>
          <ul class="m num" role="list">
            {#if p.sorte === "envoi"}
              <li data-opens>{t("shares.opens", { u: p.ouvertures, max: p.ouverturesMax })}</li>
              <li>{t("shares.items", { n: p.elements })} · {formatBytes(p.taille, lang)}</li>
            {/if}
            {#if actif}
              <li data-expires>{t("shares.expires", { duration: formatDuration(Math.max(0, (p.echeance - now) / 1000), lang) })}</li>
            {:else}
              <li>{t("shares.ended", { time: finVers(p) })}</li>
            {/if}
          </ul>
          <p class="sub">{t("shares.created", { date: formatDayTime(p.creeLe, lang) })}</p>
          {#if vu === "epuise"}<p class="sub">{t("manage.draining")}</p>{/if}
          {#if p.sorte === "salon" && actif}<p class="sub">{t("shares.room.note")}</p>{/if}
          {#if !actif}<p class="sub">{t("shares.autoremove")}</p>{/if}
          {#if err}<p class="stale" role="status" data-stale>{err}</p>{/if}

          <div class="acts">
            {#if actif && p.sorte === "envoi"}
              <InlineConfirm label={t("shares.destroy")} message={t("shares.destroy.confirm")} confirmLabel={t("shares.destroy.yes")} kind="danger" triggerVariant="danger-line" dense onconfirm={() => supprimer(p)}>
                {#snippet icon()}<Trash2 size={18} strokeWidth={1.75} />{/snippet}
              </InlineConfirm>
            {:else if actif}
              <a class="lnk" href={p.gestion} data-room-manage>{t("shares.room.manage")}</a>
              <Button variant="ghost" dense onpress={() => copierInvitation(p)}>
                {#snippet icon()}<Copy size={18} strokeWidth={1.75} />{/snippet}
                {t("shares.invite.copy")}
              </Button>
            {/if}
            {#if actif}
              <InlineConfirm label={t("shares.remove")} message={t(p.sorte === "salon" ? "shares.remove.confirm.room" : "shares.remove.confirm")} confirmLabel={t("shares.remove.yes")} kind="warn" triggerVariant="ghost" dense onconfirm={() => retirer(p)}>
                {#snippet icon()}<X size={18} strokeWidth={1.75} />{/snippet}
              </InlineConfirm>
            {:else}
              <Button variant="ghost" dense onpress={() => retirer(p)}>
                {#snippet icon()}<X size={18} strokeWidth={1.75} />{/snippet}
                {t("shares.remove")}
              </Button>
            {/if}
          </div>
          {#if copie?.id === p.id}<p class="sub" role="status">{copie.texte}</p>{/if}
        </li>
      {/each}
    </ul>
  {/if}

  {#if mesPartages.statut === "pret"}
    <div class="foot">
      <p class="sub">{t("shares.honest")}</p>
      <p class="sub" data-shares-device>{t(accountFlag.connected ? "shares.device.account" : "shares.device.alone")}</p>
    </div>
  {/if}
</section>

<style>
  .parts {
    width: min(100%, 1120px);
    margin-inline: auto;
    padding: 0 var(--sp-4) var(--sp-8);
    display: grid;
    gap: var(--sp-5);
    min-width: 0;
  }
  .counts {
    color: var(--text-2);
    font-variant-numeric: tabular-nums;
  }
  .list {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: var(--sp-3);
    margin: 0;
    padding: 0;
    list-style: none;
  }
  @media (min-width: 960px) {
    .list {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }
  .skel {
    height: 150px;
    border-radius: var(--r-xl);
    background: var(--surface-1);
  }
  .card {
    display: grid;
    align-content: start;
    gap: var(--sp-2);
    min-width: 0;
    padding: var(--sp-4);
    border: 1px solid var(--hair-2);
    border-radius: var(--r-xl);
    background: var(--vessel);
    box-shadow: var(--edge-hi);
  }
  .card.fini {
    opacity: 0.8;
  }
  .hd {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--sp-2) var(--sp-3);
    min-width: 0;
  }
  .name {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    margin: 0;
    min-width: 0;
    font-weight: 600;
    color: var(--text);
    overflow-wrap: anywhere;
  }
  .m {
    display: flex;
    flex-wrap: wrap;
    gap: var(--sp-1) var(--sp-4);
    margin: 0;
    padding: 0;
    list-style: none;
    font-weight: 600;
  }
  .num {
    font-variant-numeric: tabular-nums;
  }
  .sub {
    margin: 0;
    color: var(--text-2);
    font-size: var(--fs-small);
    max-width: 62ch;
  }
  .stale {
    margin: 0;
    font-size: var(--fs-small);
    color: var(--warn);
  }
  .acts {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--sp-2);
    padding-top: var(--sp-2);
  }
  .lnk,
  .cta {
    display: inline-flex;
    align-items: center;
    min-height: 44px;
    padding-inline: var(--sp-2);
    color: var(--accent);
    font-weight: 600;
    text-underline-offset: 0.2em;
  }
  .foot {
    display: grid;
    gap: var(--sp-2);
    padding-top: var(--sp-4);
    border-top: 1px solid var(--line);
  }
  @media (max-width: 899px) {
    .parts {
      padding: 0 0 var(--sp-6);
      gap: var(--sp-4);
    }
    .card {
      border-radius: var(--r-lg);
    }
  }
</style>
