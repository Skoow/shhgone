<script lang="ts">
  // Trois assurances de la page d'envoi : dans le cadre
  // de dépôt de « Votre envoi », sous « Déposez des fichiers ». Trois pastilles égales, sur une
  // ligne : libellé complet si la rangée est large, libellé court en dessous de 800 px, et sur
  // téléphone (rangée de 420 px au plus) l'icône au-dessus du libellé court. Le libellé complet
  // reste lu par les lecteurs d'écran.
  import { t } from "../i18n/i18n.svelte";
  import { Lock, Timer, UserX } from "./Icon";

  const ITEMS = [
    { I: Lock, k: "send.assure.browser", s: "send.assure.browser.short" },
    { I: UserX, k: "home.fact.account", s: "send.assure.account.short" },
    { I: Timer, k: "send.assure.burn", s: "send.assure.burn.short" },
  ] as const;
</script>

<ul class="assure" aria-label={t("home.facts.label")} data-assure>
  {#each ITEMS as a (a.k)}
    <li><a.I size={15} strokeWidth={2} aria-hidden="true" /><span class="al">{t(a.k)}</span><span class="as" aria-hidden="true">{t(a.s)}</span></li>
  {/each}
</ul>

<style>
  .assure {
    container: assure / inline-size;
    width: 100%;
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: var(--sp-2);
    color: var(--text-2);
    font-size: var(--fs-small);
  }
  li {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    min-width: 0;
    min-height: 40px;
    padding-inline: 10px;
    border-radius: 12px;
    background: rgb(255 255 255 / 0.03);
    box-shadow: inset 0 0 0 1px var(--hair);
    white-space: nowrap;
  }
  li :global(svg) {
    flex: none;
    color: var(--accent);
  }
  .al,
  .as {
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .as {
    display: none;
  }
  /* Libellé complet seulement s'il tient entier (« Chiffré dans votre navigat… »
     était coupé vers 680 px de large) : trois pastilles de 250 px environ. */
  @container assure (max-width: 800px) {
    .al {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip-path: inset(50%);
    }
    .as {
      display: inline;
    }
  }
  @container assure (max-width: 420px) {
    li {
      flex-direction: column;
      gap: 3px;
      min-height: 56px;
      padding: 6px;
      font-size: var(--fs-micro);
    }
  }
</style>
