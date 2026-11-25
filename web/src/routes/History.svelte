<script lang="ts">
  // « Vos envois » (/envois) : tableau de bord de l'historique local (spec §33, §33.1 ; UI §9.6.2).
  // D'abord l'état LOCAL (lecture d'IndexedDB, aucune requête) ; puis, page visible, une relecture
  // des partages actifs dont l'état date de plus de 5 min, l'un après l'autre, chacun après une
  // gigue de 0,5 à 4 s (history/poll.ts). Jamais en arrière-plan, aucune boucle.
  // Filtre « Reçus » (conception §21.7) : les partages ouverts sur cet
  // appareil avec « Garder » coché, mêmes lignes que l'accueil connecté (InboxRow) ; jamais relus
  // au chargement (seulement « Actualiser » dans leur détail). Les compteurs restent ceux des envois.
  import { untrack } from "svelte";
  import { followLink, href, navigate } from "../app/router.svelte";
  import { t } from "../i18n/i18n.svelte";
  import {
    clearHistory,
    destroyFromHistory,
    forgetShare,
    renameShare,
    loadHistory,
    refreshAll,
    refreshShare,
    keepSentDefault,
    setHistoryEnabled,
    shares,
    stopRefresh,
  } from "../history/live.svelte";
  import { isActive, type HistoryEntry } from "../history/store";
  import { announce } from "../ui/announce";
  import Button from "../ui/Button.svelte";
  import EmptyState from "../ui/EmptyState.svelte";
  import { Plus, Trash2 } from "../ui/Icon";
  import InboxDetail from "../ui/InboxDetail.svelte";
  import InboxRow from "../ui/InboxRow.svelte";
  import PageHeader from "../ui/PageHeader.svelte";
  import InlineConfirm from "../ui/InlineConfirm.svelte";
  import Segmented from "../ui/Segmented.svelte";
  import ShareCard from "../ui/ShareCard.svelte";

  let now = $state(Date.now());
  $effect(() => {
    untrack(() =>
      void loadHistory(true).then(async (h) => {
        if (h && document.visibilityState === "visible") await refreshAll();
      }),
    );
    const id = setInterval(() => (now = Date.now()), 30_000);
    const back = () => {
      if (document.visibilityState === "visible") now = Date.now();
    };
    document.addEventListener("visibilitychange", back);
    return () => {
      stopRefresh();
      clearInterval(id);
      document.removeEventListener("visibilitychange", back);
    };
  });

  type Filter = "active" | "ended" | "all" | "received";
  let filter = $state<Filter>("all");
  const filters = $derived([
    { value: "active" as const, label: t("hist.filter.active") },
    { value: "ended" as const, label: t("hist.filter.ended") },
    { value: "all" as const, label: t("hist.filter.all") },
    { value: "received" as const, label: t("hist.filter.received") },
  ]);
  const activeCount = $derived(shares.entries.filter((e) => isActive(e, now)).length);
  const endedCount = $derived(shares.entries.length - activeCount);
  const shown = $derived(shares.entries.filter((e) => filter === "all" || (filter === "active") === isActive(e, now)));
  const received = $derived(shares.all.filter((e) => e.sorte === "recu"));
  let picked = $state<string | null>(null);
  const pickedEntry = $derived(picked === null ? null : (received.find((e) => e.id === picked) ?? null));
  async function removeReceived(e: HistoryEntry) {
    if (picked === e.id) picked = null;
    await forgetShare(e.id);
    announce(t("home.inbox.removed"));
  }

  let title: HTMLHeadingElement | undefined = $state();
  $effect(() => {
    if (title) untrack(() => title?.focus({ preventScroll: true }));
  });

  async function clear() {
    await clearHistory();
    announce(t("hist.cleared"));
  }
  async function enable() {
    await setHistoryEnabled(true);
    announce(t("hist.on.done"));
  }
</script>

<section class="hist" aria-labelledby="h-title" aria-busy={shares.status === "loading" || shares.status === "idle" ? "true" : undefined}>
  <PageHeader id="h-title" title={t("hist.title")} bind:titleEl={title}>
    {#if shares.status === "ready" && shares.entries.length > 0}
      <p class="counts num" data-counts>{t("hist.count.active", { n: activeCount })} · {t("hist.count.ended", { n: endedCount })}</p>
    {/if}
    {#snippet actions()}
      <Button variant="primary" onpress={() => navigate("/envoyer")}>
        {#snippet icon()}<Plus size={20} strokeWidth={2} />{/snippet}
        {t("hist.new")}
      </Button>
    {/snippet}
  </PageHeader>

  {#if shares.status === "unavailable"}
    <EmptyState title={t("hist.unavailable.title")} data-history-unavailable>
      <p>{t("hist.unavailable.body")}</p>
    </EmptyState>
  {:else if shares.status !== "ready"}
    <ul class="list" role="list" aria-label={t("hist.loading")}>
      {#each [0, 1] as k (k)}<li class="skel" aria-hidden="true"></li>{/each}
    </ul>
  {:else if shares.all.length === 0}
    <EmptyState title={keepSentDefault() ? t("hist.empty.title") : t("hist.off.title")} data-history-empty>
      {#snippet art()}
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
          <path d="M14 3v5h5M9 13h6M9 17h4" />
        </svg>
      {/snippet}
      {#if keepSentDefault()}
        <p>{t("hist.empty.body")}</p>
        <p>{t("hist.honest")}</p>
        <a class="cta" href={href("/envoyer")} onclick={(e) => followLink(e, "/envoyer")}>{t("hist.empty.cta")}</a>
      {:else}
        <p>{t("hist.off.body")}</p>
        <Button variant="secondary" onpress={enable}>{t("hist.off.cta")}</Button>
      {/if}
    </EmptyState>
  {:else}
    <div class="filters"><Segmented label={t("hist.filter")} options={filters} bind:value={filter} /></div>
    {#if filter === "received"}
      {#if pickedEntry}
        <InboxDetail
          entry={pickedEntry}
          {now}
          split={false}
          info={shares.info[pickedEntry.id]}
          onback={() => (picked = null)}
          onrefresh={async () => void (await refreshShare(pickedEntry.id))}
          ondestroy={async () => false}
          onremove={() => void removeReceived(pickedEntry)}
        />
      {:else if received.length === 0}
        <p class="sub">{t("hist.empty.received")}</p>
      {:else}
        <ul class="rows" role="list">
          {#each received as e, i (e.id)}
            <InboxRow entry={e} {now} index={i} onopen={() => (picked = e.id)} onremove={() => void removeReceived(e)} />
          {/each}
        </ul>
      {/if}
    {:else if shown.length === 0}
      <p class="sub">{t("hist.empty.filter")}</p>
    {:else}
      <ul class="list" role="list">
        {#each shown as e (e.id)}
          <ShareCard
            entry={e}
            {now}
            info={shares.info[e.id]}
            onrefresh={async () => void (await refreshShare(e.id))}
            ondestroy={() => destroyFromHistory(e.id)}
            onremove={() => void forgetShare(e.id)}
            onrename={async (title) => (await renameShare(e.id, title)) !== null}
          />
        {/each}
      </ul>
    {/if}
    {#if !keepSentDefault()}
      <div class="off">
        <p class="sub">{t("hist.off.title")}. {t("hist.off.body")}</p>
        <Button variant="ghost" dense onpress={enable}>{t("hist.off.cta")}</Button>
      </div>
    {/if}
    <div class="foot">
      <p class="sub">{t("hist.honest")}</p>
      <InlineConfirm label={t("hist.clear")} message={t("hist.clear.confirm")} confirmLabel={t("hist.clear.yes")} kind="danger" triggerVariant="ghost" onconfirm={clear}>
        {#snippet icon()}<Trash2 size={18} strokeWidth={1.75} />{/snippet}
      </InlineConfirm>
    </div>
  {/if}
</section>

<style>
  .hist {
    width: min(100%, 1120px);
    margin-inline: auto;
    padding: 0 var(--sp-4) var(--sp-8);
    display: grid;
    gap: var(--sp-5);
  }
  .counts {
    color: var(--text-2);
    font-variant-numeric: tabular-nums;
  }
  .filters {
    width: min(100%, 420px);
  }
  .list {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: var(--sp-3);
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .rows {
    display: grid;
    gap: 2px;
    width: min(100%, 640px);
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
  .sub {
    margin: 0;
    color: var(--text-2);
    max-width: 62ch;
  }
  .cta {
    display: inline-flex;
    align-items: center;
    min-height: 44px;
    color: var(--accent);
    font-weight: 600;
    text-underline-offset: 0.2em;
  }
  .off,
  .foot {
    display: grid;
    justify-items: start;
    gap: var(--sp-2);
  }
  .foot {
    padding-top: var(--sp-4);
    border-top: 1px solid var(--line);
  }
  .foot :global(button.ghost) {
    color: var(--danger);
  }
  @media (max-width: 899px) {
    .hist {
      padding: 0 0 var(--sp-6);
      gap: var(--sp-4);
    }
  }
</style>
