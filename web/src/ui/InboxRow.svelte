<script lang="ts">
  // Ligne de l'accueil (conception compte §21.15.1) et du filtre « Reçus » de Mes partages : 72 px,
  // pastille de 48 px (salon : bulle ; reçu : format dominant ; envoi : format et flèche), anneau
  // de temps, titre local (<bdi>), sous-titre (temps restant, « Expiré », « Détruit »), heure ou
  // date de la dernière activité locale, puces. Aucun lien ni secret dans le DOM : la ligne
  // n'affiche que des mesures. Entrée finie : atténuée, « Retirer de la liste » (glissement au
  // doigt, toujours doublé d'un bouton au clavier).
  import { formatBytes, formatClock, formatDuration } from "../i18n/format";
  import { getLang, t, type Key } from "../i18n/i18n.svelte";
  import { effectiveState, type HistoryEntry } from "../history/store";
  import type { Family } from "./formats";
  import FormatIcon from "./FormatIcon.svelte";
  import { ArrowUp, MessagesSquare, X } from "./Icon";
  import IconButton from "./IconButton.svelte";
  import StateChip from "./StateChip.svelte";
  import TimeRim from "./TimeRim.svelte";
  import { swipeToRemove } from "./swipe";

  type Props = {
    entry: HistoryEntry;
    /** Horloge (ms), rafraîchie par la page. */
    now: number;
    selected?: boolean;
    /** Rang à l'arrivée : lignes décalées de 40 ms (12 au plus, §21.15.1) ; mouvement réduit : rien. */
    index?: number;
    onopen: () => void;
    onremove: () => void;
  };
  let { entry, now, selected = false, index = 12, onopen, onremove }: Props = $props();
  const lang = $derived(getLang());

  const state = $derived(effectiveState(entry, now));
  const ended = $derived(state === "gone" || state === "expired");
  const room = $derived(entry.sorte === "salon_cree" || entry.sorte === "salon_rejoint");
  const day = (ms: number) => new Intl.DateTimeFormat(lang, { day: "numeric", month: "short" }).format(ms);
  const items = $derived(t("hist.items", { n: entry.itemsCount }));
  const title = $derived(
    room
      ? t(`home.inbox.row.${entry.sorte}` as Key, { label: entry.label || t("home.inbox.room"), date: day(entry.createdAt) })
      : entry.sorte === "recu"
        ? t("home.inbox.row.recu", { items, size: formatBytes(entry.sizeBytes, lang) })
        : // Envoi : son titre, sinon le nombre d'éléments.
          entry.label || t("home.inbox.row.envoi", { items }),
  );
  const leftS = $derived(Math.max(0, Math.ceil((entry.expiresAt - now) / 1000)));
  const totalS = $derived(Math.max(leftS, Math.ceil((entry.expiresAt - entry.createdAt) / 1000)));
  const sameDay = (a: number, b: number) => new Date(a).toDateString() === new Date(b).toDateString();
  const when = $derived(sameDay(entry.createdAt, now) ? formatClock(entry.createdAt, lang) : day(entry.createdAt));
  const format = $derived({ family: (entry.format || "file") as Family, label: "" });
  const reduced = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
</script>

<li class={["row", ended && "ended", selected && "sel", index < 12 && "arrive"]} style:--i={index} data-inbox-row data-sorte={entry.sorte} data-ended={ended ? "true" : undefined} {@attach ended ? swipeToRemove(onremove, { reduced }) : undefined}>
  <button type="button" class="main" aria-current={selected ? "true" : undefined} onclick={onopen}>
    <span class="pill" aria-hidden="true">
      {#if !ended && entry.expiresAt > now}<TimeRim remainingS={leftS} totalS={totalS} radius={24} />{/if}
      {#if room}
        <span class="room" data-room><MessagesSquare size={24} /></span>
      {:else}
        <span class="fmt"><FormatIcon {format} size={26} /></span>
        {#if entry.sorte === "envoi"}<span class="sent" data-sent><ArrowUp size={12} strokeWidth={2.4} /></span>{/if}
      {/if}
    </span>
    <span class="tx">
      <bdi class="t">{title}</bdi>
      <span class="s">
        {#if ended}
          <StateChip state={state} destroyedHere={entry.sorte !== "envoi" || entry.destroyedHere} />
        {:else}
          <span class="num">{t("home.inbox.left", { duration: formatDuration(leftS, lang, { coarse: true }) })}</span>
        {/if}
      </span>
    </span>
    <span class="meta">
      <time class="when num" datetime={new Date(entry.createdAt).toISOString()}>{when}</time>
      {#if entry.sorte === "salon_cree"}<span class="chip">{t("home.inbox.mine")}</span>{/if}
      {#if entry.sorte === "recu" && entry.origine === "compte" && !ended}<span class="chip warn">{t("home.inbox.reopenCost")}</span>{/if}
    </span>
  </button>
  {#if ended}
    <span class="rm"><IconButton label={t("home.inbox.remove")} onpress={onremove} data-remove><X size={18} /></IconButton></span>
  {/if}
</li>

<style>
  .row {
    position: relative;
    display: flex;
    align-items: center;
    min-width: 0;
    border-radius: var(--r-lg);
    background: color-mix(in srgb, var(--danger-tint) calc(var(--swipe, 0) * 100%), transparent);
    transition: background-color 120ms;
  }
  .row.ended .main {
    opacity: 0.55;
  }
  .main {
    flex: 1 1 auto;
    display: flex;
    align-items: center;
    gap: var(--sp-3);
    min-width: 0;
    min-height: 72px;
    padding: var(--sp-2) var(--sp-3);
    border: 0;
    border-radius: var(--r-lg);
    background: transparent;
    color: inherit;
    font: inherit;
    text-align: start;
    cursor: pointer;
  }
  .main:hover {
    background: var(--surface-1);
  }
  .sel .main,
  .main[aria-current] {
    background: var(--surface-2);
  }
  .main:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }
  .pill {
    position: relative;
    flex: none;
    display: grid;
    place-items: center;
    width: 48px;
    height: 48px;
    border-radius: 50%;
    background: var(--surface-2);
    color: var(--text-2);
  }
  .pill :global(.rim) {
    position: absolute;
    inset: 0;
  }
  .room {
    display: grid;
    place-items: center;
    color: var(--info);
  }
  .fmt {
    display: grid;
    place-items: center;
    margin-top: 2px;
  }
  .sent {
    position: absolute;
    right: -2px;
    bottom: -2px;
    display: grid;
    place-items: center;
    width: 20px;
    height: 20px;
    border: 2px solid var(--bg);
    border-radius: 50%;
    background: var(--accent);
    color: var(--on-accent);
  }
  .tx {
    flex: 1 1 auto;
    display: grid;
    gap: 2px;
    min-width: 0;
  }
  .t {
    overflow: hidden;
    font-weight: 600;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .s {
    display: flex;
    min-width: 0;
    color: var(--text-2);
    font-size: var(--fs-small);
  }
  .meta {
    flex: none;
    display: grid;
    justify-items: end;
    gap: 4px;
    max-width: 40%;
  }
  .when {
    color: var(--text-3);
    font-size: var(--fs-micro, 0.75rem);
  }
  .num {
    font-variant-numeric: tabular-nums;
  }
  .chip {
    padding: 1px 6px;
    border-radius: 6px;
    background: var(--surface-3);
    color: var(--text-2);
    font-size: var(--fs-micro, 0.75rem);
    line-height: 1.35;
    text-align: end;
  }
  .chip.warn {
    background: var(--warn-tint);
    color: var(--warn);
  }
  .rm {
    flex: none;
    padding-inline-end: var(--sp-1);
  }
  .arrive {
    animation: arrive 240ms cubic-bezier(0.2, 0, 0, 1) backwards;
    animation-delay: calc(var(--i) * 40ms);
  }
  @keyframes arrive {
    from {
      opacity: 0;
      transform: translateY(6px);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .row {
      transition: none;
    }
    .arrive {
      animation: none;
    }
  }
  @media (forced-colors: active) {
    .main[aria-current] {
      outline: 2px solid CanvasText;
    }
  }
</style>
