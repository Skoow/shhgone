<script lang="ts">
  // « Téléchargements » (/telechargements, conception compte §21.15.5), avec ou sans compte :
  // historique des fichiers enregistrés, sur cet appareil seulement (downloads/store.ts, chiffré,
  // 30 jours ; désactivé par défaut). Aucune
  // requête réseau. Le site ne peut pas rouvrir un fichier enregistré : il est dans le dossier
  // Téléchargements de l'appareil (dit dans le sous-titre).
  import { untrack } from "svelte";
  import { clearDownloads, downloads, loadDownloads, removeDownload, setDownloadsEnabled } from "../downloads/live.svelte";
  import { byDay } from "../downloads/store";
  import { formatBytes, formatClock } from "../i18n/format";
  import { getLang, t } from "../i18n/i18n.svelte";
  import { announce } from "../ui/announce";
  import Button from "../ui/Button.svelte";
  import EmptyState from "../ui/EmptyState.svelte";
  import FormatIcon from "../ui/FormatIcon.svelte";
  import { Trash2, X } from "../ui/Icon";
  import IconButton from "../ui/IconButton.svelte";
  import InlineConfirm from "../ui/InlineConfirm.svelte";
  import { midSplitName } from "../ui/midname";
  import PageHeader from "../ui/PageHeader.svelte";
  import Switch from "../ui/Switch.svelte";

  const lang = $derived(getLang());
  let now = $state(Date.now());
  $effect(() => {
    untrack(() => void loadDownloads());
    // Changement de jour pendant que la page est ouverte : « Aujourd'hui » et « Hier » suivent.
    const id = setInterval(() => (now = Date.now()), 60_000);
    return () => clearInterval(id);
  });

  const groups = $derived(byDay(downloads.entries, now));
  const dayLabel = (day: "today" | "yesterday" | number) =>
    day === "today" ? t("downloads.today") : day === "yesterday" ? t("downloads.yesterday") : new Intl.DateTimeFormat(lang, { day: "numeric", month: "long" }).format(day);

  let title: HTMLHeadingElement | undefined = $state();
  $effect(() => {
    if (title) untrack(() => title?.focus({ preventScroll: true }));
  });

  async function toggle(v: boolean) {
    await setDownloadsEnabled(v);
    announce(t(v ? "downloads.on.done" : "downloads.off.done"));
  }
  async function clear() {
    await clearDownloads();
    announce(t("downloads.cleared"));
  }
  async function remove(id: string) {
    await removeDownload(id);
    announce(t("downloads.removed"));
  }
</script>

{#snippet tray()}
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <path d="M12 3v12m-5-5 5 5 5-5" />
    <path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
  </svg>
{/snippet}

<section class="dls" aria-labelledby="d-title" aria-busy={downloads.status === "loading" || downloads.status === "idle" ? "true" : undefined}>
  <PageHeader id="d-title" title={t("downloads.title")} lede={t("downloads.sub")} bind:titleEl={title} />

  {#if downloads.status === "unavailable"}
    <p class="sub" data-downloads-unavailable>{t("downloads.unavailable")}</p>
  {:else if downloads.status === "ready"}
    <div class="tools">
      <div class="sw"><Switch label={t("downloads.keep")} hint={t("downloads.keep.hint")} checked={downloads.enabled} onchange={(v) => void toggle(v)} /></div>
      {#if downloads.entries.length > 0}
        <InlineConfirm label={t("downloads.clear")} message={t("downloads.clear.confirm")} confirmLabel={t("downloads.clear.yes")} kind="danger" triggerVariant="ghost" onconfirm={clear}>
          {#snippet icon()}<Trash2 size={18} strokeWidth={1.75} />{/snippet}
        </InlineConfirm>
      {/if}
    </div>

    {#if !downloads.enabled}
      <EmptyState title={t("downloads.off.title")} data-downloads-off>
        {#snippet art()}{@render tray()}{/snippet}
        <Button variant="secondary" onpress={() => toggle(true)}>{t("downloads.off.cta")}</Button>
      </EmptyState>
    {:else if downloads.entries.length === 0}
      <EmptyState title={t("downloads.empty")} level="p" data-downloads-empty>
        {#snippet art()}{@render tray()}{/snippet}
      </EmptyState>
    {:else}
      {#each groups as g (g.day)}
        <section class="day" aria-labelledby="day-{g.day}" data-day>
          <h2 id="day-{g.day}" class="dt">{dayLabel(g.day)}</h2>
          <ul class="rows" role="list">
            {#each g.items as e (e.id)}
              {@const mid = midSplitName(e.name)}
              <li class="row" data-download-row>
                <FormatIcon format={e.format} size={40} />
                <div class="tx">
                  <bdi class="name" title={e.name} translate="no"><span class="b">{mid.head}</span><span class="e">{mid.tail}</span></bdi>
                  <span class="meta num">
                    <span>{formatBytes(e.sizeBytes, lang)}</span>
                    <span class="chip">{t(e.source === "salon" ? "downloads.source.salon" : "downloads.source.partage")}</span>
                    <span>{formatClock(e.savedAt, lang)}</span>
                  </span>
                </div>
                <IconButton label={t("downloads.remove")} onpress={() => void remove(e.id)}><X size={18} /></IconButton>
              </li>
            {/each}
          </ul>
        </section>
      {/each}
    {/if}
    {#if downloads.enabled}<p class="foot">{t("downloads.foot")}</p>{/if}
  {/if}
</section>

<style>
  .dls {
    width: min(100%, 1120px);
    margin-inline: auto;
    padding: 0 var(--sp-4) var(--sp-8);
    display: grid;
    gap: var(--sp-5);
    min-width: 0;
  }
  /* En-tête sur toute la largeur, comme les autres écrans ; la liste garde une mesure de lecture. */
  .dls > :global(:not(.ph)) {
    max-width: 52rem;
  }
  .sub,
  .foot {
    margin: 0;
    color: var(--text-2);
    max-width: 62ch;
  }
  .foot {
    font-size: var(--fs-small);
  }
  .tools {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--sp-3);
  }
  .tools :global(button.ghost) {
    color: var(--danger);
  }
  .sw {
    min-width: min(100%, 280px);
  }
  .day {
    display: grid;
    min-width: 0;
  }
  .dt {
    margin: 0 0 var(--sp-1);
    padding-inline: var(--sp-3);
    font-size: var(--fs-small);
    font-weight: 600;
    color: var(--text-2);
  }
  .rows {
    margin: 0;
    padding: 0;
    list-style: none;
    min-width: 0;
  }
  .row {
    display: grid;
    grid-template-columns: 40px minmax(0, 1fr) auto;
    align-items: center;
    gap: var(--sp-3);
    min-height: 64px;
    padding: var(--sp-2) var(--sp-1) var(--sp-2) var(--sp-3);
    border-bottom: 1px solid var(--line);
  }
  .tx {
    display: grid;
    gap: 2px;
    min-width: 0;
  }
  .name {
    display: flex;
    min-width: 0;
    font-size: var(--fs-small);
    font-weight: 560;
    line-height: 1.35;
    color: var(--text);
  }
  .b {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .e {
    flex: none;
    white-space: pre;
  }
  .meta {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0 8px;
    color: var(--text-2);
    font-size: var(--fs-micro);
    line-height: var(--lh-micro);
  }
  .num {
    font-variant-numeric: tabular-nums;
  }
  .chip {
    padding: 1px 8px;
    border-radius: 999px;
    border: 1px solid var(--hair-2);
    background: var(--surface-1);
    color: var(--text-2);
  }
  @media (max-width: 899px) {
    .dls {
      padding: 0 0 var(--sp-6);
      gap: var(--sp-4);
    }
  }
  @media (forced-colors: active) {
    .chip {
      border-color: CanvasText;
    }
  }
</style>
