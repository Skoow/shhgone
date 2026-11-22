<script lang="ts">
  // Retour de la page hébergée du prestataire (/offres/retour, conception du paiement §2 point 5) :
  // aucune donnée dans l'adresse. La page lit le pass de la commande la plus récente gardé sur cet
  // appareil et demande son état au serveur (seule source de vérité, nourrie par les webhooks
  // signés) : toutes les 3 s pendant 2 min, puis toutes les 30 s, jusqu'à un état final. Le retour
  // de la personne ne prouve rien.
  import { href } from "../app/router.svelte";
  import { getLang, t } from "../i18n/i18n.svelte";
  import { lireEtat, lireOffre, resilier, type EtatPaiement } from "../paiement/api";
  import { telechargerNote } from "../paiement/note";
  import { garder, idbDuNavigateur, lirePasses, oublier, oublierEtat, type PassGarde } from "../paiement/pass";

  let { rapide = 3000, lent = 30000 }: { rapide?: number; lent?: number } = $props();
  const lang = $derived(getLang());
  let g = $state<PassGarde | null | undefined>(undefined); // undefined : lecture en cours
  let e = $state<EtatPaiement | null>(null);
  let arret = $state<"rien" | "ok" | "erreur">("rien");
  const FINAUX: readonly EtatPaiement["etat"][] = ["payee", "non_aboutie", "anomalie", "revoquee", "inconnue"];

  $effect(() => {
    let vivant = true;
    let minuterie: ReturnType<typeof setTimeout> | undefined;
    const idb = idbDuNavigateur();
    void (async () => {
      const tous = idb === null ? [] : await lirePasses(idb);
      if (!vivant) return;
      const cible = tous.find((x) => x.enAttente) ?? tous[0] ?? null;
      g = cible;
      if (cible === null || idb === null) return;
      let essais = 0;
      let enAttente = cible.enAttente;
      const tour = async () => {
        const r = await lireEtat(cible.pass);
        if (!vivant) return;
        if (r !== null) e = r;
        // Retour de paiement : l'état gardé pour l'écran d'envoi (jetons.ts) est relu au prochain chargement.
        if (r !== null) await oublierEtat(idb, cible.id).catch(() => {});
        if (r !== null && r.etat === "payee" && enAttente) {
          enAttente = false;
          await garder(idb, { ...cible, enAttente: false }).catch(() => {});
        }
        if (r !== null && FINAUX.includes(r.etat)) return;
        essais++;
        minuterie = setTimeout(tour, essais < 40 ? rapide : lent);
      };
      await tour();
    })();
    return () => {
      vivant = false;
      clearTimeout(minuterie);
    };
  });

  /** Dernier jour valable (fin exclue) en toutes lettres. */
  const jusqua = (fin: string) =>
    new Intl.DateTimeFormat(lang, { dateStyle: "long", timeZone: "UTC" }).format(new Date(Date.parse(fin + "T00:00:00Z") - 86400000));

  async function arreter(): Promise<void> {
    if (!g) return;
    const r = await resilier(g.pass);
    const idb = idbDuNavigateur();
    if (idb) await oublierEtat(idb, g.id).catch(() => {});
    arret = r === "erreur" ? "erreur" : "ok";
    if (r !== "erreur" && e) e = { ...e, renouvelle: false };
  }

  // Note de vente (conception §9.3, S4) : assemblée ici ; seul GET /api/paiement est lu (régime
  // de TVA, public), rien n'est envoyé.
  let noteErr = $state(false);
  async function noteDeVente(): Promise<void> {
    noteErr = false;
    const o = await lireOffre();
    if (!g || !e?.fin || !o?.tva) {
      noteErr = true;
      return;
    }
    telechargerNote({ id: g.id, offre: g.offre, jours: g.jours, renouvelle: g.renouvelle, moyen: g.moyen, pays: g.pays, cree: g.cree, fin: e.fin, tva: o.tva, maintenant: Date.now() });
  }

  async function oublierCommande(): Promise<void> {
    const idb = idbDuNavigateur();
    if (g && idb) await oublier(idb, g.id).catch(() => {});
    g = null;
    e = null;
  }
  const vue = $derived(
    g === undefined ? "lecture" : g === null ? "aucune" : e === null || e.etat === "attente" ? "attente" : e.etat === "inconnue" ? "non_aboutie" : e.etat,
  );
</script>

<section class="ret" aria-live="polite" data-return={vue}>
  {#if vue === "lecture"}
    <p class="body">…</p>
  {:else if vue === "aucune"}
    <h2>{t("offers.ret.none")}</h2>
    <p class="body">{t("offers.ret.none.body")}</p>
  {:else if vue === "payee" && e}
    <h2>{t("offers.ret.paid")}</h2>
    <p class="body">{t("offers.ret.paid.body", { tier: t(`paid.badge.${e.offre ?? "plus"}`), date: e.fin ? jusqua(e.fin) : "" })}</p>
    <p class="body">{t("offers.ret.notyet")}</p>
    {#if e.renouvelle}
      <p class="body">{t("offers.ret.renew")}</p>
      <button type="button" class="act" onclick={arreter} data-stop>{t("offers.ret.stop")}</button>
    {/if}
    {#if arret === "ok"}<p class="body" data-stopped>{t("offers.ret.stopped")}</p>{/if}
    {#if arret === "erreur"}<p class="err" role="alert">{t("offers.ret.stop.err")}</p>{/if}
    {#if g && e.fin}
      <button type="button" class="act" onclick={noteDeVente} data-note>{t("offers.ret.note")}</button>
      <p class="body">{t("offers.ret.note.hint")}</p>
      {#if noteErr}<p class="err" role="alert">{t("offers.ret.note.err")}</p>{/if}
    {/if}
  {:else if vue === "attente"}
    <h2>{t("offers.ret.wait")}</h2>
    <p class="body">{t("offers.ret.wait.body")}</p>
  {:else if vue === "revoquee"}
    <h2>{t("offers.ret.revoked")}</h2>
    <p class="body">{t("offers.ret.revoked.body")}</p>
  {:else}
    <h2>{t("offers.ret.failed")}</h2>
    <p class="body">{vue === "anomalie" ? t("offers.ret.anomaly.body") : t("offers.ret.failed.body")}</p>
  {/if}
  <p class="links">
    <a href={href("/offres")} data-back>{t("offers.ret.back")}</a>
    {#if g && vue !== "payee"}<button type="button" class="lnk" onclick={oublierCommande} data-forget>{t("offers.ret.forget")}</button>{/if}
  </p>
</section>

<style>
  .ret {
    display: grid;
    gap: var(--sp-3);
    max-width: 40rem;
    padding: var(--sp-5);
    border-radius: var(--r-xl);
    background: linear-gradient(180deg, rgb(255 255 255 / 0.07), rgb(255 255 255 / 0.03));
    box-shadow: inset 0 0 0 1px rgb(150 175 255 / 0.2);
  }
  h2 {
    margin: 0;
    font-size: var(--fs-h3);
  }
  .body {
    margin: 0;
    color: var(--text-2);
  }
  .err {
    margin: 0;
    color: var(--danger);
  }
  .links {
    display: flex;
    flex-wrap: wrap;
    gap: var(--sp-4);
    align-items: center;
    margin: 0;
  }
  .links a {
    color: var(--accent);
  }
  .act,
  .lnk {
    min-height: 44px;
    padding: 0 var(--sp-4);
    border: 0;
    border-radius: var(--r-pill);
    background: var(--surface-3);
    color: var(--text);
    font: inherit;
    font-weight: 600;
    cursor: pointer;
    justify-self: start;
  }
  .lnk {
    background: transparent;
    color: var(--text-2);
    text-decoration: underline;
  }
  .act:focus-visible,
  .lnk:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
</style>
