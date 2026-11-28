<script lang="ts">
  // « Mes partages » (/envois) et « Mes salons » (/salons) (spec §33, D42-30 ; deux pages depuis le
  // 28 novembre, décision du propriétaire) : une page par sorte, rien de mélangé. Seulement ce que
  // la personne a ELLE-MÊME créé (partages envoyés, salons créés), sur cet appareil et dans son
  // compte s'il est ouvert ; jamais un lien reçu. Gardés d'office (storage/partages.svelte.ts).
  // D'abord l'état LOCAL (lecture d'IndexedDB, aucune requête) ; puis, page visible, une relecture
  // des envois actifs dont l'état date de plus de 5 min, l'un après l'autre, après une gigue
  // (storage/partages-relecture.ts). Jamais en arrière-plan, aucune boucle.
  // Par ligne : l'icône du type (fichier, salon), le nom, une étiquette d'état en mot (« En cours »
  // en vert, « Terminé » grisé : le mot se lit, la couleur ne fait que l'appuyer), la date de fin
  // avec l'heure entre parenthèses (« Se termine le 29 nov. (12 h 14) », « Terminé le … ») ; pour
  // un envoi, les ouvertures, le nombre d'éléments et la taille.
  // Actions, dites pour qui elles comptent :
  //   - « Supprimer le partage » : détruit le partage pour tout le monde (lien de gestion) ;
  //   - « Retirer de la liste » : l'enlève seulement de cette liste (appareil et compte), le partage
  //     ou le salon continue jusqu'à son échéance ;
  //   - « Gérer le salon » : la page de gestion du créateur (elle seule peut le fermer) ;
  //   - terminé : « Retirer » un par un, et « Effacer l'historique » (Oui / Non) retire tous les
  //     terminés de la page, les actifs restent.
  // Une entrée finie est aussi retirée seule 7 jours après sa fin. Jamais le lien de partage ni le
  // mot de passe.
  import { untrack } from "svelte";
  import { accountFlag } from "../app/account-flag.svelte";
  import { followLink, href, navigate } from "../app/router.svelte";
  import { formatBytes, formatDayParen } from "../i18n/format";
  import { getLang, t } from "../i18n/i18n.svelte";
  import { arreterRelecture, chargerPartages, detruirePartage, mesPartages, relirePartages, retirerPartage, retirerTermines } from "../storage/partages.svelte";
  import { estActif, etatVu, finDe, type Partage, type Sorte } from "../storage/partages";
  import { announce } from "../ui/announce";
  import Button from "../ui/Button.svelte";
  import { copyText } from "../ui/clipboard";
  import EmptyState from "../ui/EmptyState.svelte";
  import { Copy, File, MessagesSquare, Plus, Trash2, X } from "../ui/Icon";
  import InlineConfirm from "../ui/InlineConfirm.svelte";
  import PageHeader from "../ui/PageHeader.svelte";

  let { sorte = "envoi" }: { sorte?: Sorte } = $props();
  const salon = $derived(sorte === "salon");

  const lang = $derived(getLang());
  let now = $state(Date.now());
  $effect(() => {
    untrack(() =>
      void chargerPartages().then(async () => {
        if (document.visibilityState === "visible") await relirePartages().catch(() => undefined);
      }),
    );
    const id = setInterval(() => (now = Date.now()), 30_000);
    // Suivi en direct : coupé quand la page est cachée, repris à son retour.
    const retour = () => {
      if (document.visibilityState === "visible") {
        now = Date.now();
        void relirePartages().catch(() => undefined);
      } else arreterRelecture();
    };
    document.addEventListener("visibilitychange", retour);
    return () => {
      arreterRelecture();
      clearInterval(id);
      document.removeEventListener("visibilitychange", retour);
    };
  });

  /** Entrées de la page, dans l'ordre de la liste (actifs d'abord, storage/partages.ts trier). */
  const liste = $derived(mesPartages.liste.filter((p) => p.sorte === sorte));
  const termines = $derived(liste.filter((p) => !estActif(p, now)).length);

  let title: HTMLHeadingElement | undefined = $state();
  $effect(() => {
    if (title) untrack(() => title?.focus({ preventScroll: true }));
  });

  // L'échéance du serveur est au quart d'heure ; arrondie à la minute pour l'affichage.
  const minute = (ms: number) => Math.round(ms / 60_000) * 60_000;
  /** « Se termine le 29 nov. (12 h 14) » ou « Terminé le 29 nov. (12 h 14) ». */
  const fin = (p: Partage) => (estActif(p, now) ? t("shares.ends", { date: formatDayParen(minute(p.echeance), lang) }) : t("shares.ended", { date: formatDayParen(minute(finDe(p, now)), lang) }));
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
  async function effacerHistorique() {
    const n = await retirerTermines(sorte);
    announce(t("shares.history.cleared", { n }));
  }
  let copie = $state<{ id: string; texte: string } | null>(null);
  async function copierInvitation(p: Partage) {
    const r = await copyText(p.invitation);
    copie = { id: p.id, texte: r === "copied" ? t("shares.invite.copied") : t("shares.copy.manual") };
    announce(copie.texte);
  }
  const nouveau = $derived(salon ? "/salon/nouveau" : "/envoyer");
</script>

<section class="parts" aria-labelledby="p-title" data-shares-page={sorte} aria-busy={mesPartages.statut === "attente" || mesPartages.statut === "lecture" ? "true" : undefined}>
  <PageHeader id="p-title" title={t(salon ? "rooms.title" : "shares.title")} lede={t(salon ? "rooms.sub" : "shares.sub")} bind:titleEl={title}>
    {#snippet actions()}
      <Button variant="primary" onpress={() => navigate(nouveau)}>
        {#snippet icon()}<Plus size={20} strokeWidth={2} />{/snippet}
        {t(salon ? "rooms.new" : "shares.new")}
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
  {:else if liste.length === 0}
    <EmptyState level="p" title={t(salon ? "shares.rooms.empty.title" : "shares.files.empty.title")} data-shares-empty={sorte}>
      {#snippet art()}
        {#if salon}<MessagesSquare size={32} strokeWidth={1.5} />{:else}<File size={32} strokeWidth={1.5} />{/if}
      {/snippet}
      <p>{t(salon ? "shares.rooms.empty.body" : "shares.files.empty.body")}</p>
      <a class="cta" href={href(nouveau)} onclick={(e) => followLink(e, nouveau)}>{t(salon ? "shares.rooms.empty.cta" : "shares.files.empty.cta")}</a>
    </EmptyState>
  {:else}
    <div class="ph">
      <p class="counts num" data-counts>{t("shares.count.active", { n: liste.length - termines })} · {t("shares.count.ended", { n: termines })}</p>
      {#if termines > 0}
        <div data-history-clear>
          <InlineConfirm label={t("shares.history.clear")} message={t("shares.history.confirm", { n: termines })} confirmLabel={t("shares.history.yes")} cancelLabel={t("shares.history.no")} kind="warn" triggerVariant="ghost" dense onconfirm={effacerHistorique}>
            {#snippet icon()}<Trash2 size={18} strokeWidth={1.75} />{/snippet}
          </InlineConfirm>
        </div>
      {/if}
    </div>
    <ul class="list" role="list">
      {#each liste as p (p.id)}
        {@render carte(p)}
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

{#snippet carte(p: Partage)}
  {@const vu = etatVu(p, now)}
  {@const actif = vu === "actif" || vu === "epuise"}
  {@const err = erreurTexte(p)}
  <li class={["card", { fini: !actif }]} data-share-card data-sorte={p.sorte} data-state={vu}>
    <div class="hd">
      <span class={["ic", p.sorte]} aria-hidden="true" data-share-icon={p.sorte === "salon" ? "salon" : "fichier"}>
        {#if p.sorte === "salon"}<MessagesSquare size={20} strokeWidth={1.75} />{:else}<File size={20} strokeWidth={1.75} />{/if}
      </span>
      {#if p.sorte === "salon"}
        <h3 class="name">{t("shares.room")}</h3>
      {:else if p.nom}
        <h3 class="name" data-share-title><bdi translate="no">{p.nom}</bdi></h3>
      {:else}
        <h3 class="name">{t("shares.share")}</h3>
      {/if}
      <span class={["tag", actif ? "on" : "off"]} data-share-tag={actif ? "en-cours" : "termine"}>{t(actif ? "shares.tag.on" : "shares.tag.off")}</span>
    </div>
    <ul class="m num" role="list">
      <li class="fin" data-share-end>{fin(p)}</li>
      {#if p.sorte === "envoi"}
        <li data-opens>{t("shares.opens", { u: p.ouvertures, max: p.ouverturesMax })}</li>
        <li>{t("shares.items", { n: p.elements })} · {formatBytes(p.taille, lang)}</li>
      {/if}
    </ul>
    {#if vu === "epuise"}<p class="sub">{t("manage.draining")}</p>{/if}
    {#if vu === "detruit"}<p class="sub">{t(p.detruitIci ? "shares.gone.here" : "shares.gone")}</p>{/if}
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
        <Button variant="ghost" dense aria-label={t("shares.remove.ended.name")} onpress={() => retirer(p)} data-share-remove>
          {#snippet icon()}<X size={18} strokeWidth={1.75} />{/snippet}
          {t("shares.remove.ended")}
        </Button>
      {/if}
    </div>
    {#if copie?.id === p.id}<p class="sub" role="status">{copie.texte}</p>{/if}
  </li>
{/snippet}

<style>
  .parts {
    width: min(100%, 1120px);
    margin-inline: auto;
    padding: 0 var(--sp-4) var(--sp-8);
    display: grid;
    gap: var(--sp-4);
    min-width: 0;
  }
  .ph {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--sp-1) var(--sp-4);
    min-width: 0;
  }
  .counts {
    margin: 0;
    color: var(--text-2);
    font-size: var(--fs-small);
    font-variant-numeric: tabular-nums;
  }
  .ic {
    display: grid;
    place-items: center;
    flex: none;
    width: 36px;
    height: 36px;
    border-radius: var(--r-md, 12px);
    background: var(--surface-1);
    box-shadow: inset 0 0 0 1px var(--hair);
    color: var(--text-2);
  }
  .ic.salon {
    color: var(--accent);
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
    background: var(--surface-1);
  }
  .hd {
    display: flex;
    align-items: center;
    gap: var(--sp-3);
    min-width: 0;
  }
  .name {
    flex: 1 1 0;
    min-width: 0;
    margin: 0;
    font-size: var(--fs-body, 1rem);
    font-weight: 600;
    color: var(--text);
    overflow-wrap: anywhere;
  }
  .card.fini .name {
    color: var(--text-2);
  }
  /* Étiquette d'état : petit carré arrondi, le mot porte l'information (jamais la couleur seule). */
  .tag {
    flex: none;
    padding: 2px 8px;
    border-radius: 6px;
    font-size: var(--fs-small);
    font-weight: 650;
    line-height: 1.5;
    white-space: nowrap;
  }
  .tag.on {
    background: var(--accent-tint);
    color: var(--accent);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 35%, transparent);
  }
  .tag.off {
    background: var(--surface-2);
    color: var(--text-2);
    box-shadow: inset 0 0 0 1px var(--hair);
  }
  .m {
    display: flex;
    flex-wrap: wrap;
    gap: var(--sp-1) var(--sp-4);
    margin: 0;
    padding: 0;
    list-style: none;
    color: var(--text-2);
  }
  .m .fin {
    flex-basis: 100%;
    color: var(--text);
    font-weight: 600;
  }
  .card.fini .m .fin {
    color: var(--text-2);
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
  @media (forced-colors: active) {
    .tag {
      border: 1px solid CanvasText;
    }
  }
  @media (max-width: 899px) {
    .parts {
      padding: 0 0 var(--sp-6);
    }
    .card {
      border-radius: var(--r-lg);
    }
  }
</style>
