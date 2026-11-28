<script lang="ts">
  // État du service (page à part, 28 novembre) : ce que le serveur dit de lui-même par
  // GET /api/etat-service (aucune donnée envoyée, aucune gardée) : maintenance annoncée, puis un
  // voyant par service. Relu chaque minute tant que l'onglet est visible. Au build, la page est
  // écrite sans état (« Lecture de l'état… ») : le navigateur le lit au chargement.
  import { formatClock } from "../i18n/format";
  import { getLang, t } from "../i18n/i18n.svelte";
  import { maintenance, rafraichir, SERVICES, texteBandeau, type EtatService } from "../maintenance/etat.svelte";
  import PageHeader from "../ui/PageHeader.svelte";

  const PERIODE_MS = 60_000;
  /** null : pas encore lu ; faux : dernière lecture en échec. */
  let joint = $state<boolean | null>(null);

  $effect(() => {
    let minuterie: ReturnType<typeof setTimeout> | undefined;
    let fini = false;
    const tour = async () => {
      clearTimeout(minuterie);
      joint = await rafraichir();
      if (!fini) minuterie = setTimeout(tour, PERIODE_MS);
    };
    const visible = () => {
      if (document.visibilityState === "visible") void tour();
    };
    void tour();
    document.addEventListener("visibilitychange", visible);
    return () => {
      fini = true;
      clearTimeout(minuterie);
      document.removeEventListener("visibilitychange", visible);
    };
  });

  const DETAIL: Partial<Record<EtatService, "etat.maintenance.d" | "etat.suspendu.d">> = { maintenance: "etat.maintenance.d", suspendu: "etat.suspendu.d" };
  const services = $derived(maintenance.services);
  const lu = $derived(maintenance.lu === null ? "" : t("etat.lu", { heure: formatClock(maintenance.lu, getLang()) }));
</script>

<article class="etat" aria-labelledby="etat-title">
  <PageHeader id="etat-title" title={t("title.etat")} lede={t("etat.lede")} />

  {#if maintenance.annonce}
    <section class="maint" aria-labelledby="etat-maint" data-etat-maintenance>
      <h2 id="etat-maint">{t("etat.maint.title")}</h2>
      <p>{texteBandeau()}</p>
    </section>
  {/if}

  <section aria-labelledby="etat-list">
    <h2 id="etat-list" class="sr-only">{t("etat.list")}</h2>
    <p class="statut" role="status" data-etat-statut>
      {#if joint === false}{t("etat.injoignable")}{:else if services === null}{t("etat.lecture")}{:else}{lu}{/if}
    </p>
    {#if services !== null}
      <ul class="liste">
        {#each SERVICES as s (s)}
          {@const e = services[s]}
          <li class="ligne" data-service={s} data-etat={e}>
            <span class="nom">{t(`etat.s.${s}`)}</span>
            <span class="valeur"><span class={["pastille", e]} aria-hidden="true"></span>{t(`etat.${e}`)}</span>
            {#if DETAIL[e]}<span class="detail">{t(DETAIL[e]!)}</span>{/if}
          </li>
        {/each}
      </ul>
    {/if}
  </section>

  <p class="note">{t("etat.note")}</p>
</article>

<style>
  .etat {
    display: grid;
    gap: var(--sp-5);
    max-width: 48rem;
    padding-block: var(--sp-5) var(--sp-7);
  }
  h2 {
    margin: 0 0 var(--sp-2);
    font-size: 1.125rem;
  }
  .maint {
    padding: var(--sp-4);
    border-radius: var(--r-lg);
    background: var(--warn-tint);
    box-shadow: inset 0 0 0 1px rgb(242 196 109 / 0.35);
  }
  .maint p {
    margin: 0;
  }
  .statut {
    margin: 0 0 var(--sp-3);
    color: var(--text-2);
    font-size: var(--fs-small);
  }
  .liste {
    display: grid;
    margin: 0;
    padding: 0;
    list-style: none;
    border-radius: var(--r-lg);
    box-shadow: inset 0 0 0 1px rgb(233 236 242 / 0.1);
  }
  .ligne {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: var(--sp-1) var(--sp-3);
    padding: var(--sp-3) var(--sp-4);
  }
  .ligne + .ligne {
    border-top: 1px solid rgb(233 236 242 / 0.08);
  }
  .nom {
    font-weight: 600;
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .valeur {
    display: inline-flex;
    align-items: center;
    gap: var(--sp-2);
    color: var(--text-2);
    text-align: end;
  }
  .detail {
    grid-column: 1 / -1;
    color: var(--text-3);
    font-size: var(--fs-small);
  }
  .pastille {
    flex: none;
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: var(--text-3);
  }
  .pastille.ok {
    background: var(--accent);
  }
  .pastille.maintenance,
  .pastille.suspendu {
    background: var(--warn);
  }
  .note {
    margin: 0;
    color: var(--text-3);
    font-size: var(--fs-small);
  }
  @media (forced-colors: active) {
    .pastille {
      forced-color-adjust: none;
      border: 1px solid CanvasText;
    }
  }
</style>
