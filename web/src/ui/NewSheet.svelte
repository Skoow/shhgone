<script lang="ts">
  // Feuille « Nouveau » de l'accueil connecté (conception compte §21.15.1) : Envoyer des fichiers,
  // Écrire une note (page d'envoi, geste joué par le composeur à son montage), Créer un salon
  // (bientôt : il dépend des écrans du salon, C-3 ; annoncé, rien n'est demandé au serveur).
  import { goToSend, type AddGesture } from "../app/chrome.svelte";
  import { navigate } from "../app/router.svelte";
  import { formatBytes } from "../i18n/format";
  import { getLang, t } from "../i18n/i18n.svelte";
  import { CONTENT_MAX } from "../limits";
  import { announce } from "./announce";
  import { ChevronRight, MessagesSquare, Type, Upload } from "./Icon";
  import Sheet from "./Sheet.svelte";

  let { open = $bindable(false) }: { open: boolean } = $props();

  function go(g: AddGesture) {
    open = false;
    goToSend(g);
  }
</script>

<Sheet bind:open title={t("home.inbox.new.title")}>
  <ul class="items">
    <li>
      <button type="button" class="it" data-new-item onclick={() => go("fichiers")}>
        <span class="ic"><Upload size={22} /></span>
        <span class="tx"><span class="t">{t("home.inbox.new.files")}</span> · <span class="d">{t("home.inbox.new.files.d", { size: formatBytes(CONTENT_MAX, getLang()) })}</span></span>
        <ChevronRight size={18} aria-hidden="true" />
      </button>
    </li>
    <li>
      <button type="button" class="it" data-new-item onclick={() => go("texte")}>
        <span class="ic"><Type size={22} /></span>
        <span class="tx"><span class="t">{t("home.inbox.new.note")}</span> · <span class="d">{t("home.inbox.new.note.d")}</span></span>
        <ChevronRight size={18} aria-hidden="true" />
      </button>
    </li>
    <li>
      {#if __SALONS__}
        <!-- Salon : la page de création. -->
        <button type="button" class="it" data-new-item onclick={() => ((open = false), navigate("/salon/nouveau"))}>
          <span class="ic room"><MessagesSquare size={22} /></span>
          <span class="tx"><span class="t">{t("home.inbox.new.room")}</span> · <span class="d">{t("home.inbox.new.room.live")}</span></span>
          <ChevronRight size={18} aria-hidden="true" />
        </button>
      {:else}
        <button type="button" class="it soon" data-new-item aria-disabled="true" onclick={() => announce(t("home.inbox.new.room.d"))}>
          <span class="ic room"><MessagesSquare size={22} /></span>
          <span class="tx"><span class="t">{t("home.inbox.new.room")}</span> · <span class="d">{t("home.inbox.new.room.d")}</span></span>
        </button>
      {/if}
    </li>
  </ul>
</Sheet>

<style>
  .items {
    display: grid;
    gap: var(--sp-2);
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .it {
    display: flex;
    align-items: center;
    gap: var(--sp-3);
    width: 100%;
    min-height: 56px;
    padding: var(--sp-2) var(--sp-3);
    border: 1px solid var(--hair-2);
    border-radius: var(--r-lg);
    background: var(--surface-1);
    color: var(--text);
    font: inherit;
    text-align: start;
    cursor: pointer;
  }
  .it:hover {
    background: var(--surface-3);
  }
  .it:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  .it.soon {
    cursor: default;
    opacity: 0.7;
  }
  .ic {
    display: grid;
    place-items: center;
    flex: none;
    width: 40px;
    height: 40px;
    border-radius: 50%;
    background: var(--surface-3);
    color: var(--accent);
  }
  .ic.room {
    color: var(--info);
  }
  .tx {
    flex: 1 1 auto;
    min-width: 0;
    color: var(--text-3);
  }
  .t {
    color: var(--text);
    font-weight: 600;
  }
  .d {
    color: var(--text-2);
    font-size: var(--fs-small);
  }
</style>
