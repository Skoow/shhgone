<script lang="ts">
  // Détail d'une entrée de l'accueil (conception compte §21.15.1) : à droite sur ordinateur, à la
  // place de la liste sur téléphone. Envoi : la carte complète (ShareCard). Partage reçu : mesures,
  // temps restant, « Rouvrir » (page d'ouverture, mot de passe redemandé ; d'un autre appareil,
  // une ouverture de plus), « Actualiser » (au plus une relecture toutes les 5 min). Salon :
  // libellé, temps restant ; l'entrée dans le salon arrive avec ses écrans (C-3, C-5).
  import { href } from "../app/router.svelte";
  import { lienDuSalon } from "../history/room-link";
  import { formatBytes, formatClock, formatDayTime, formatDuration } from "../i18n/format";
  import { getLang, t } from "../i18n/i18n.svelte";
  import type { ShareInfo } from "../history/live.svelte";
  import { REFRESH_MIN_MS } from "../history/poll";
  import { effectiveState, type HistoryEntry } from "../history/store";
  import Button from "./Button.svelte";
  import { ChevronLeft, LockOpen, RefreshCw, X } from "./Icon";
  import ShareCard from "./ShareCard.svelte";
  import StateChip from "./StateChip.svelte";

  type Props = {
    entry: HistoryEntry;
    now: number;
    info?: ShareInfo;
    /** Vue en deux colonnes (accueil connecté) : sur ordinateur, pas de bouton Retour. */
    split?: boolean;
    onback: () => void;
    onrefresh: () => Promise<void>;
    ondestroy: () => Promise<boolean>;
    onremove: () => void;
    /** Renommer un envoi sur cet appareil. */
    onrename?: (title: string) => Promise<boolean>;
  };
  let { entry, now, info = {}, split = true, onback, onrefresh, ondestroy, onremove, onrename }: Props = $props();
  const lang = $derived(getLang());
  const uid = $props.id();

  const state = $derived(effectiveState(entry, now));
  const ended = $derived(state === "gone" || state === "expired");
  const room = $derived(entry.sorte === "salon_cree" || entry.sorte === "salon_rejoint");
  const leftS = $derived(Math.max(0, Math.ceil((entry.expiresAt - now) / 1000)));
  const items = $derived(t("hist.items", { n: entry.itemsCount }));
  const title = $derived(room ? entry.label || t("home.inbox.room") : entry.sorte === "recu" ? t("home.inbox.detail.recu") : "");
  const date = $derived(formatDayTime(entry.createdAt, lang));
  const seen = $derived(
    new Date(entry.lastSeenAt).toDateString() === new Date(now).toDateString()
      ? t("hist.seen.today", { time: formatClock(entry.lastSeenAt, lang), n: REFRESH_MIN_MS / 60_000 })
      : t("hist.seen.day", { date: formatDayTime(entry.lastSeenAt, lang), n: REFRESH_MIN_MS / 60_000 }),
  );
  const freshText = $derived(info.nextAt && info.nextAt > now ? t("hist.fresh", { duration: formatDuration((info.nextAt - now) / 1000, lang) }) : "");
  const errorText = $derived(
    info.error === "reseau" ? t("hist.err.reseau") : info.error === "limite" ? t("hist.err.limite", { duration: formatDuration(info.retryAfterS ?? 60, lang) }) : info.error === "serveur" ? t("hist.err.serveur") : "",
  );

  /** Rouvrir : la page d'ouverture lit le lien puis le retire de la barre d'adresse (spec §5.3). */
  function reopen() {
    location.assign(href("/s") + entry.link.slice(entry.link.lastIndexOf("#")));
  }
</script>

<section class="detail" aria-labelledby="{uid}-t" data-inbox-detail>
  <div class="hd">
    <span class={["back", split && "split"]}><Button variant="ghost" dense onpress={onback}>
      {#snippet icon()}<ChevronLeft size={18} />{/snippet}
      {t("home.inbox.back")}
    </Button></span>
    {#if title}<h2 class="t" id="{uid}-t"><bdi>{title}</bdi></h2>{:else}<h2 class="sr-only" id="{uid}-t">{t("home.inbox.row.envoi", { items })}</h2>{/if}
  </div>

  {#if entry.sorte === "envoi"}
    <ul class="one" role="list">
      <ShareCard {entry} {now} {info} {onrefresh} {ondestroy} {onremove} {onrename} />
    </ul>
  {:else}
    <div class="card">
      <p class="state">
        {#if ended}<StateChip state={state} destroyedHere={true} />{:else}<span class="num">{t("home.inbox.left", { duration: formatDuration(leftS, lang, { coarse: true }) })}</span>{/if}
      </p>
      {#if entry.sorte === "recu"}
        <p class="facts num">{items} · {formatBytes(entry.sizeBytes, lang)}</p>
        <p class="sub">{t("home.inbox.opened", { date })}</p>
        {#if ended}
          <p class="sub">{state === "expired" ? t("home.inbox.ended.expired") : t("home.inbox.ended.gone")}</p>
        {:else}
          {#if entry.origine === "compte"}<p class="warn" id="{uid}-cost">{t("home.inbox.reopenCost")}</p>{/if}
          <p class="sub" id="{uid}-pw">{t("home.inbox.reopen.pw")}</p>
          <div class="acts">
            <Button variant="primary" onpress={reopen} aria-describedby={entry.origine === "compte" ? `${uid}-cost ${uid}-pw` : `${uid}-pw`}>
              {#snippet icon()}<LockOpen size={18} />{/snippet}
              {t("home.inbox.reopen")}
            </Button>
            <Button variant="ghost" busy={info.busy} onpress={() => void onrefresh()}>
              {#snippet icon()}<RefreshCw size={18} />{/snippet}
              {t("hist.refresh")}
            </Button>
          </div>
          <p class="sub num">{seen}</p>
          {#if freshText}<p class="sub" role="status">{freshText}</p>{/if}
          {#if errorText}<p class="err" role="alert">{errorText}</p>{/if}
        {/if}
      {:else}
        <p class="sub">{entry.sorte === "salon_cree" ? t("home.inbox.created", { date }) : t("home.inbox.joined", { date })}</p>
        {#if __SALONS__}
          <!-- Salon : le lien d'invitation gardé ouvre la page du salon (le mot de passe reste demandé). -->
          <div class="acts"><Button variant="primary" onpress={() => location.assign(lienDuSalon(entry.link))}>{t("home.inbox.room.open")}</Button></div>
        {:else}
          <p class="sub">{t("home.inbox.room.later")}</p>
        {/if}
      {/if}
      <div class="acts">
        <Button variant="ghost" onpress={onremove}>
          {#snippet icon()}<X size={18} />{/snippet}
          {t("home.inbox.remove")}
        </Button>
      </div>
    </div>
  {/if}
</section>

<style>
  .detail {
    display: grid;
    align-content: start;
    gap: var(--sp-4);
    min-width: 0;
  }
  .hd {
    display: grid;
    gap: var(--sp-2);
    justify-items: start;
  }
  .t {
    margin: 0;
    font-size: var(--fs-h2);
    overflow-wrap: anywhere;
  }
  .one {
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .card {
    display: grid;
    gap: var(--sp-3);
    padding: var(--sp-5);
    border: 1px solid var(--hair-2);
    border-radius: var(--r-xl);
    background: var(--vessel);
    box-shadow: var(--edge-hi);
  }
  .state,
  .facts,
  .sub,
  .warn,
  .err {
    margin: 0;
  }
  .state {
    font-size: var(--fs-h3, 1.125rem);
    font-weight: 600;
  }
  .facts {
    font-weight: 600;
  }
  .num {
    font-variant-numeric: tabular-nums;
  }
  .sub {
    color: var(--text-2);
    font-size: var(--fs-small);
    max-width: 62ch;
  }
  .warn {
    justify-self: start;
    padding: 2px 8px;
    border-radius: 6px;
    background: var(--warn-tint);
    color: var(--warn);
    font-size: var(--fs-small);
    font-weight: 600;
  }
  .err {
    color: var(--danger);
    font-size: var(--fs-small);
  }
  .acts {
    display: flex;
    flex-wrap: wrap;
    gap: var(--sp-2);
  }
  @media (min-width: 960px) {
    .back.split {
      display: none;
    }
  }
</style>
