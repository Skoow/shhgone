<script lang="ts">
  // Page Offres (décision du propriétaire du 16 novembre) : une seule présentation des offres,
  // sans redite. On choisit la facturation (mensuelle ou annuelle), puis son offre (Plus ou Pro ;
  // Gratuit est l'offre en cours, rien à choisir) ; un récapitulatif dit le prix et les moyens de
  // paiement. Chiffres lus dans PAID et limits.ts.
  //
  // Paiement (conception du paiement, 19 novembre) : le bouton n'est actif que si CE serveur
  // propose le moyen choisi (GET /api/paiement ; démo, serveur sans paiement : inactif, la raison
  // est dite), le pays (UE) choisi, le rythme de l'annuel choisi (jamais présélectionné) et la
  // case de renonciation cochée (jamais précochée, §38.1). Au clic : un pass P est tiré et rangé
  // sur l'appareil AVANT la commande, puis la page hébergée du prestataire s'ouvre (redirection,
  // aucun script tiers ici). Rien n'est payé sur Shhgone.
  //
  // Preuve anti-robot (audit du 20 novembre, S2) : la commande porte une preuve de travail ALTCHA
  // (défi lu et calculé dans son Worker dès que le bouton peut servir, comme les pages du compte) ;
  // aucun repli tiers ici (le pass est sur cette page).
  import { formatBytes, formatDuration } from "../i18n/format";
  import { getLang, t } from "../i18n/i18n.svelte";
  import { CONTENT_MAX, MAX_OPENS, PAID, TTL_MAX_HOURS, type PaidTier } from "../limits";
  import { commander, lireOffre, type ErreurCommande, type Moyen, type OffreServeur, type Preuve } from "../paiement/api";
  import { garder, idbDuNavigateur, lirePasses, nouvelId, oublier, tirerPass } from "../paiement/pass";
  import { paysProbable } from "../paiement/pays";
  import { href } from "../app/router.svelte";
  import { LimiteDefi, obtenirPreuve, preparerPreuve } from "../paiement/preuve";
  import { Check, Lock, Timer } from "./Icon";
  import Banner from "./Banner.svelte";

  type Billing = "month" | "year";
  // Mensuel sélectionné par défaut (décision du propriétaire du 16 novembre).
  let billing = $state<Billing>("month");
  let chosen = $state<PaidTier | null>(null);
  const uid = $props.id();
  const lang = $derived(getLang());
  const eur = (v: number) => new Intl.NumberFormat(lang, { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(v);
  /** Mois offerts par l'annuel (12 mois au prix mensuel, moins le prix annuel), le plus grand des deux offres. */
  const freeMonths = Math.max(...(["plus", "pro"] as const).map((x) => Math.round((12 * PAID[x].month - PAID[x].year) / PAID[x].month)));

  type Tier = "free" | PaidTier;
  const TIERS: readonly Tier[] = ["free", "plus", "pro"];
  const name = (x: Tier) => (x === "free" ? t("offers.free") : t(`paid.badge.${x}`));
  const details = (x: Tier) => [
    { k: t("offers.card.size"), v: formatBytes(x === "free" ? CONTENT_MAX : PAID[x].bytes, lang) },
    { k: t("offers.card.ttl"), v: x === "free" ? formatDuration(TTL_MAX_HOURS * 3600, lang) : t("paid.days", { n: Math.max(...PAID[x].ttlDays) }) },
    { k: t("offers.card.opens"), v: String(x === "free" ? MAX_OPENS : PAID[x].opens) },
  ];
  const price = (x: PaidTier) => (billing === "month" ? PAID[x].month : PAID[x].year);
  const per = $derived(billing === "month" ? t("offers.per.month") : t("offers.per.year"));
  // Moyen de paiement (propriétaire, 18 et 19 novembre) : carte bancaire (Stripe), PayPal, crypto
  // (NOWPayments). Noms de l'écran (clés de texte) → noms de l'API.
  type Means = "card" | "paypal" | "crypto";
  let means = $state<Means>("card");
  const TOUS: readonly Means[] = ["card", "paypal", "crypto"];
  const API: Readonly<Record<Means, Moyen>> = { card: "carte", paypal: "paypal", crypto: "crypto" };
  // Appels des salons (19 novembre) : prévus, jamais vendus ni promis comme disponibles.
  // Ce que l'offre choisie ajoute au gratuit (lu dans PAID et limits.ts). Le départ du compte à
  // rebours à la première ouverture n'est pas encore codé : dit « bientôt » (24 novembre).
  const adds = $derived(
    chosen
      ? [
          t("offers.adds.size", { size: formatBytes(PAID[chosen].bytes, lang), free: formatBytes(CONTENT_MAX, lang) }),
          t("offers.adds.ttl", { n: Math.max(...PAID[chosen].ttlDays), free: formatDuration(TTL_MAX_HOURS * 3600, lang) }),
          t("offers.adds.opens", { n: PAID[chosen].opens, free: MAX_OPENS }),
          t("offers.adds.first"),
        ]
      : [],
  );

  // Offre de CE serveur (null : pas de paiement ici, ou pas encore lue). Une seule lecture par
  // affichage de la page. `ferme` : réponse reçue, paiement non ouvert (404, démo, injoignable) ;
  // dit en tête de page et sur les boutons « Bientôt » (revue du 20 novembre, U12), plutôt qu'au
  // bout du parcours seulement.
  let serveur = $state<OffreServeur | null>(null);
  let lue = $state(false);
  const ferme = $derived(lue && serveur === null);
  // Moyens montrés : ceux que CE serveur propose (conception §9.1 : sous SHH_TVA=oss, la crypto
  // n'est pas montrée ; un prestataire non configuré non plus) ; paiement fermé ou pas encore lu :
  // les trois, pour information (le bouton reste inactif).
  const MEANS = $derived(serveur === null ? TOUS : TOUS.filter((m) => serveur!.moyens.includes(API[m])));
  $effect(() => {
    if (MEANS.length > 0 && !MEANS.includes(means)) means = MEANS[0]!;
  });
  // Une offre déjà gardée sur cet appareil (lecture locale seulement, aucune requête) : lien vers
  // sa page (état, arrêt du renouvellement à tout moment, note de vente ; revue du 25 novembre :
  // la résiliation n'était joignable qu'au retour du paiement).
  let mien = $state(false);
  $effect(() => {
    let vivant = true;
    void lireOffre().then((o) => {
      if (!vivant) return;
      serveur = o;
      lue = true;
    });
    const idb = idbDuNavigateur();
    if (idb !== null)
      void lirePasses(idb).then((l) => {
        if (vivant) mien = l.length > 0;
      });
    return () => {
      vivant = false;
    };
  });
  // Annuel par carte ou PayPal : paiement unique ou renouvellement, au choix, jamais présélectionné.
  let renew = $state<"once" | "auto" | null>(null);
  const renewAsked = $derived(billing === "year" && means !== "crypto");
  const renouvelle = $derived(means === "crypto" ? false : billing === "month" ? true : renew === "auto");
  let pays = $state("");
  // Pays proposé d'avance (24 novembre), une fois la liste du serveur lue : deviné sur l'appareil
  // (fuseau horaire, langue), jamais envoyé avant la commande ; la personne le vérifie.
  let propose = false;
  $effect(() => {
    if (propose || serveur === null) return;
    propose = true;
    if (pays === "") pays = paysProbable(serveur.pays);
  });
  let waiver = $state(false);
  const regions = $derived.by(() => {
    let dn: Intl.DisplayNames | null = null;
    try {
      dn = new Intl.DisplayNames([lang], { type: "region" });
    } catch {
      dn = null;
    }
    return (serveur?.pays ?? []).map((c) => ({ c, n: dn?.of(c) ?? c })).sort((a, b) => a.n.localeCompare(b.n, lang));
  });
  const who = $derived(t(`offers.who.${means}`));
  // Première raison qui empêche de payer (dite sous le bouton), ou null.
  const blocage = $derived(
    serveur === null
      ? t("offers.continue.wait")
      : !serveur.moyens.includes(API[means])
        ? t("offers.need.means")
        : renewAsked && renew === null
          ? t("offers.need.renew")
          : pays === ""
            ? t("offers.need.country")
            : !waiver
              ? t("offers.need.waiver")
              : null,
  );
  let busy = $state(false);
  let erreur = $state<ErreurCommande | "stockage" | null>(null);
  // Preuve calculée à l'avance, dès que rien n'empêche plus de payer.
  $effect(() => {
    if (chosen !== null && blocage === null) preparerPreuve();
  });
  let going = $state(false);

  async function payer(): Promise<void> {
    if (chosen === null || blocage !== null || busy) return;
    busy = true;
    erreur = null;
    try {
      const idb = idbDuNavigateur();
      if (idb === null) {
        erreur = "stockage";
        return;
      }
      let preuve: Preuve;
      try {
        preuve = await obtenirPreuve();
      } catch (e) {
        erreur = e instanceof LimiteDefi ? "limite" : "reseau";
        return;
      }
      const jours = billing === "month" ? 30 : 365;
      const g = { id: nouvelId(), pass: tirerPass(), offre: chosen, jours, renouvelle, moyen: API[means], enAttente: true, cree: Date.now(), pays } as const;
      try {
        await garder(idb, g);
      } catch {
        erreur = "stockage";
        return;
      }
      const r = await commander(g.pass, { offre: chosen, jours, renouvelle, moyen: API[means], pays, renonciation: waiver }, preuve);
      if ("url" in r) {
        going = true;
        location.assign(r.url);
        return;
      }
      await oublier(idb, g.id).catch(() => {});
      erreur = r.erreur;
    } finally {
      busy = false;
    }
  }
</script>

<div class="co" data-checkout>
  {#if ferme}
    <div class="ferme" data-pay-closed><Banner kind="info">{t("offers.continue.wait")}</Banner></div>
  {/if}
  {#if mien}
    <p class="ferme mine" data-mine>{t("offers.mine")} <a href={href("/offres/retour")}>{t("offers.mine.link")}</a></p>
  {/if}
  <!-- Mise en page « La trame », version 2 (propriétaire, 19 novembre) : étapes numérotées à
       gauche (offre et rythme, moyen de paiement, compte), récapitulatif à droite. -->
  <div class="main">
    <section class="blk" aria-labelledby="{uid}-s1">
      <h2 id="{uid}-s1"><span class="n num" aria-hidden="true">1</span>{t("offers.steps.offer")}</h2>
      <fieldset class="tiers">
        <legend class="sr-only">{t("offers.choose.label")}</legend>
        {#each TIERS as x (x)}
          <!-- Toute la carte choisit l'offre (propriétaire, 24 novembre) : clic n'importe où ; le
               clavier passe par le bouton radio de la pastille, en haut à droite. -->
          <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
          <div class={["card", x, { on: chosen === x, pickable: x !== "free" }]} data-tier={x} onclick={x === "free" ? undefined : () => (chosen = x)}>
            <p class="nm">{name(x)}{#if x === "free"}<span class="cur">{t("offers.free.now")}</span>{:else if ferme}<span class="sbadge" data-soon>{t("offers.soon")}</span>{/if}</p>
            {#if x !== "free"}
              {@const tier = x}
              <label class="pick">
                <input type="radio" name="{uid}-tier" value={tier} bind:group={chosen} />
                <span class="sr-only">{name(tier)}</span>
                <span class="ring" aria-hidden="true">{#if chosen === tier}<Check size={14} strokeWidth={3} />{/if}</span>
              </label>
            {/if}
            <p class="big num"><span class="bv">{details(x)[0]!.v}</span> <span class="bu">{t("offers.big.unit")}</span></p>
            {#if x === "free"}
              <p class="pr num"><span class="pv">{eur(0)}</span>{" "}<span class="pu">{t("offers.card.free")}</span></p>
            {:else}
              <p class="pr num" data-price><span class="pv">{eur(price(x))}</span>{" "}<span class="pu">{per}</span></p>
            {/if}
            <ul class="dt num">
              {#each details(x).slice(1) as d (d.k)}<li><span class="dk">{d.k}</span>{" "}<span class="dv">{d.v}</span></li>{/each}
              <!-- Appels des salons : Plus et Pro inclus (disponibles et réservés à ces offres depuis le 24 novembre), Gratuit non. -->
              <li data-calls={x}><span class="dk">{t("offers.calls.label")}</span>{" "}<span class={["dv", { no: x === "free" }]}>{x === "free" ? t("offers.calls.no") : t("offers.calls.yes")}</span></li>
            </ul>
          </div>
        {/each}
      </fieldset>
      <p class="sub">{t("offers.rhythm")}</p>
      <fieldset class="billing" data-billing>
        <legend class="sr-only">{t("offers.billing.label")}</legend>
        <label class={{ on: billing === "month" }}>
          <input type="radio" name="{uid}-billing" value="month" bind:group={billing} />{t("offers.billing.month")}
        </label>
        <label class={{ on: billing === "year" }}>
          <input type="radio" name="{uid}-billing" value="year" bind:group={billing} />{t("offers.billing.year")}
          {#if freeMonths > 0}<span class="gift">{t("price.freeMonths", { n: freeMonths })}</span>{/if}
        </label>
      </fieldset>
      {#if chosen}
        <div class="adds">
          <p class="sub">{t("offers.adds.title", { tier: name(chosen) })}</p>
          <ul>{#each adds as a (a)}<li>{a}</li>{/each}</ul>
          <p class="same"><Lock size={14} strokeWidth={2.2} aria-hidden="true" />{t("offers.adds.same")}</p>
        </div>
      {/if}
      <!-- Prix affichés sans « TTC » à chaque ligne (17 novembre) : dit une fois ici. -->
      <p class="ttc" data-ttc>{t("offers.ttc")}</p>
    </section>

    <section class="blk" aria-labelledby="{uid}-s2">
      <h2 id="{uid}-s2"><span class="n num" aria-hidden="true">2</span>{t("offers.means.title")}</h2>
      <fieldset class="means">
        <legend class="sr-only">{t("offers.means.title")}</legend>
        {#each MEANS as m (m)}
          <label class={["mn", { on: means === m }]} data-means={m}>
            <input type="radio" name="{uid}-means" value={m} bind:group={means} />
            <span class="mt">{t(`offers.means.${m}`)}</span>
            <span class="ms">{t(`offers.means.${m}.sub`)}</span>
          </label>
        {/each}
      </fieldset>
      <p class="note">{t("offers.means.note")}</p>
      {#if renewAsked}
        <p class="sub">{t("offers.renew.label")}</p>
        <fieldset class="means" data-renew>
          <legend class="sr-only">{t("offers.renew.label")}</legend>
          {#each [["once", "offers.renew.once"], ["auto", "offers.renew.auto"]] as const as [v, k] (v)}
            <label class={["mn", { on: renew === v }]}>
              <input type="radio" name="{uid}-renew" value={v} bind:group={renew} />
              <span class="mt">{t(k)}</span>
              <span class="ms">{t(`${k}.sub`)}</span>
            </label>
          {/each}
        </fieldset>
      {/if}
      <label class="field" for="{uid}-pays">{t("offers.country.label")}</label>
      <select id="{uid}-pays" class="pays" bind:value={pays} aria-describedby="{uid}-pays-note" data-pays>
        <option value="">{t("offers.country.pick")}</option>
        {#each regions as r (r.c)}<option value={r.c}>{r.n}</option>{/each}
      </select>
      <p id="{uid}-pays-note" class="note">{t("offers.country.note")}</p>
    </section>

    <section class="blk" aria-labelledby="{uid}-s3">
      <h2 id="{uid}-s3"><span class="n num" aria-hidden="true">3</span>{t("offers.steps.account")}</h2>
      <p class="note">{t("offers.account.body")}</p>
    </section>
  </div>

  <aside class="side">
    {#if chosen}
      <section class="sum" aria-live="polite" data-summary>
        <p class="sl"><span class="n num" aria-hidden="true">4</span>{t("offers.summary.label")}</p>
        <p class="st"><b>{name(chosen)}</b> · {billing === "month" ? t("offers.billing.month") : t("offers.billing.year")} · <span class="num">{eur(price(chosen))} {per}</span></p>
        <dl class="kv">
          <div><dt>{t("offers.means.title")}</dt><dd>{t(`offers.means.${means}`)}</dd></div>
          <div><dt>{t("offers.summary.total")}</dt><dd class="tot num">{eur(price(chosen))} <span>{per}</span></dd></div>
        </dl>
        <!-- Réserve de partages payants (information obligatoire avant paiement, 25 novembre ;
             mêmes chiffres que les Conditions de vente : PAID.shares = JetonsPeriod d'offres.go). -->
        <p class="sn" data-reserve>{t("offers.summary.reserve", { n: PAID[chosen].shares })}</p>
        <p class="sn">{means === "crypto" ? t("offers.summary.crypto") : billing === "month" ? t("offers.summary.month") : t("offers.summary.year")}</p>
        <label class="waiver">
          <input type="checkbox" bind:checked={waiver} data-waiver />
          <span>{t("offers.waiver")}</span>
        </label>
        <p class="wait">{t("offers.device")} <a href={href("/conditions")}>{t("offers.terms")}</a></p>
        <button type="button" class="go" disabled={blocage !== null || busy || going} aria-describedby="{uid}-wait" onclick={payer} data-pay>
          {ferme ? t("offers.soon") : going ? t("offers.going", { who }) : t("offers.continue", { who })}
        </button>
        {#if erreur}
          <p class="err" role="alert" data-pay-error>{t(`offers.err.${erreur}`)}</p>
        {/if}
        <p id="{uid}-wait" class="wait" data-wait>{blocage ?? ""}</p>
      </section>
    {:else}
      <div class="sum empty">
        <p class="sl"><span class="n num" aria-hidden="true">4</span>{t("offers.summary.label")}</p>
        <p class="sn"><Timer size={16} strokeWidth={2} aria-hidden="true" />{t("offers.summary.pick")}</p>
      </div>
    {/if}
  </aside>
</div>

<style>
  .co {
    display: grid;
    gap: var(--sp-6);
    align-items: start;
  }
  @media (min-width: 1024px) {
    .co {
      grid-template-columns: minmax(0, 1fr) minmax(300px, 360px);
      column-gap: var(--sp-7);
    }
    .side {
      position: sticky;
      inset-block-start: 96px;
    }
  }
  .ferme {
    grid-column: 1 / -1;
  }
  .mine {
    margin: 0;
  }
  .main {
    display: grid;
    gap: var(--sp-6);
    min-width: 0;
  }
  .blk {
    display: grid;
    gap: var(--sp-4);
    padding-block-start: var(--sp-5);
    border-block-start: 1px dashed rgb(150 175 255 / 0.22);
  }
  .blk:first-child {
    border-block-start: 0;
    padding-block-start: 0;
  }
  h2 {
    display: flex;
    align-items: center;
    gap: var(--sp-3);
    margin: 0;
    font-size: var(--fs-h3);
    letter-spacing: -0.01em;
  }
  .n {
    display: inline-grid;
    place-items: center;
    width: 28px;
    height: 28px;
    border-radius: 8px;
    background: rgb(95 227 181 / 0.12);
    color: var(--accent);
    font-family: var(--font-mono);
    font-size: 0.8125rem;
    font-weight: 700;
  }
  fieldset {
    margin: 0;
    padding: 0;
    border: 0;
    min-width: 0;
  }
  .sub {
    margin: 0;
    color: var(--text);
    font-weight: 600;
  }
  .tiers {
    display: grid;
    gap: var(--sp-3);
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 200px), 1fr));
  }
  .card {
    position: relative;
    display: grid;
    align-content: start;
    gap: var(--sp-2);
    padding: var(--sp-4);
    border-radius: var(--r-lg);
    background: var(--surface-1);
    box-shadow: inset 0 0 0 1px var(--hair-2);
    transition: box-shadow var(--dur-fast) var(--ease-out);
  }
  .card:not(.free) {
    outline: 1px dashed rgb(150 175 255 / 0.28);
    outline-offset: -1px;
    box-shadow: none;
  }
  .card.on {
    outline: 0;
    box-shadow: inset 0 0 0 2px var(--accent), 0 16px 40px -24px rgb(95 227 181 / 0.6);
  }
  .nm {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    margin: 0;
    font-weight: 700;
  }
  .plus .nm {
    color: var(--plus);
  }
  .pro .nm {
    color: var(--pro);
  }
  .cur {
    padding: 1px 8px;
    border-radius: var(--r-pill);
    background: rgb(95 227 181 / 0.12);
    color: var(--accent);
    font-size: var(--fs-micro);
    font-weight: 600;
  }
  .big {
    margin: 0;
    line-height: 1;
  }
  .bv {
    font-size: clamp(2rem, 1.6rem + 1.4vw, 2.75rem);
    font-weight: 800;
    letter-spacing: -0.03em;
  }
  .bu {
    color: var(--text-2);
    font-size: var(--fs-small);
  }
  .pr {
    margin: 0;
  }
  .pv {
    font-weight: 700;
  }
  .pu {
    color: var(--text-2);
    font-size: var(--fs-small);
  }
  .dt {
    display: grid;
    gap: 4px;
    margin: 0;
    padding: 0;
    list-style: none;
    font-size: var(--fs-small);
  }
  .dt li {
    display: flex;
    justify-content: space-between;
    gap: var(--sp-2);
  }
  .dk {
    color: var(--text-2);
  }
  .dv {
    font-weight: 600;
  }
  .dv.no {
    color: var(--text-3);
    font-weight: 500;
  }
  .sbadge {
    display: inline-block;
    margin-inline-start: 4px;
    padding: 0 7px;
    border-radius: var(--r-pill);
    background: rgb(95 227 181 / 0.1);
    color: var(--accent);
    font-family: var(--font-mono);
    font-size: 0.6875rem;
    font-weight: 600;
    vertical-align: 1px;
  }
  /* Carte cliquable en entier (24 novembre) ; pastille ronde en haut à droite : vide, puis
     pleine et cochée quand l'offre est choisie. Zone de 44 px autour de la pastille. */
  .card.pickable .nm {
    padding-inline-end: 36px;
  }
  .card.pickable {
    cursor: pointer;
    transition:
      box-shadow var(--dur-fast) var(--ease-out),
      background-color var(--dur-fast) var(--ease-out);
  }
  @media (hover: hover) {
    .card.pickable:not(.on):hover {
      background: var(--surface-2);
    }
  }
  .pick {
    position: absolute;
    inset-block-start: 6px;
    inset-inline-end: 6px;
    display: grid;
    place-items: center;
    width: 44px;
    height: 44px;
    border-radius: var(--r-pill);
    cursor: pointer;
  }
  .ring {
    display: grid;
    place-items: center;
    width: 22px;
    height: 22px;
    border-radius: var(--r-pill);
    box-shadow: inset 0 0 0 2px rgb(233 236 242 / 0.35);
    color: var(--on-accent);
    transition:
      background-color var(--dur-fast) var(--ease-out),
      box-shadow var(--dur-fast) var(--ease-out);
  }
  .card.on .ring {
    background: var(--accent);
    box-shadow: 0 0 0 4px rgb(95 227 181 / 0.18);
  }
  @media (forced-colors: active) {
    .ring {
      border: 2px solid ButtonText;
    }
    .card.on .ring {
      background: Highlight;
    }
  }
  .pick input,
  .billing input,
  .mn input {
    position: absolute;
    opacity: 0;
    pointer-events: none;
  }
  .pick:has(input:focus-visible),
  .billing label:has(input:focus-visible),
  .mn:has(input:focus-visible) {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  .billing {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--sp-2);
    max-width: 30rem;
  }
  .billing label {
    position: relative;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--sp-2);
    min-height: 52px;
    padding: var(--sp-2) var(--sp-4);
    border-radius: var(--r-md);
    outline: 1px dashed rgb(150 175 255 / 0.28);
    outline-offset: -1px;
    font-weight: 600;
    cursor: pointer;
  }
  .billing label.on {
    outline: 0;
    box-shadow: inset 0 0 0 2px var(--accent);
  }
  .gift {
    padding: 1px 8px;
    border-radius: var(--r-pill);
    box-shadow: inset 0 0 0 1px rgb(95 227 181 / 0.5);
    color: var(--accent);
    font-size: var(--fs-micro);
  }
  .adds ul {
    display: grid;
    gap: 0;
    margin: var(--sp-2) 0 0;
    padding: 0;
    list-style: none;
  }
  .adds li {
    padding: var(--sp-2) 0;
    border-block-end: 1px solid var(--hair);
    color: var(--text-2);
    font-size: var(--fs-small);
  }
  .same {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    margin: var(--sp-3) 0 0;
    color: var(--text-2);
    font-size: var(--fs-small);
  }
  .same :global(svg) {
    color: var(--accent);
  }
  .ttc,
  .note {
    margin: 0;
    color: var(--text-3);
    font-size: var(--fs-small);
  }
  .means {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 160px), 1fr));
    gap: var(--sp-2);
  }
  .mn {
    position: relative;
    display: grid;
    gap: 2px;
    min-height: 76px;
    padding: var(--sp-3) var(--sp-4);
    border-radius: var(--r-md);
    outline: 1px dashed rgb(150 175 255 / 0.28);
    outline-offset: -1px;
    cursor: pointer;
  }
  .mn.on {
    outline: 0;
    box-shadow: inset 0 0 0 2px var(--accent);
  }
  .mt {
    font-weight: 650;
  }
  .ms {
    color: var(--text-2);
    font-size: var(--fs-small);
  }
  /* Récapitulatif : la carte claire de la maquette, en verre clair sur le fond sombre. */
  .sum {
    display: grid;
    gap: var(--sp-3);
    padding: var(--sp-5);
    border-radius: var(--r-xl);
    background: linear-gradient(180deg, rgb(255 255 255 / 0.07), rgb(255 255 255 / 0.03));
    box-shadow: inset 0 0 0 1px rgb(150 175 255 / 0.2), 0 30px 70px -40px rgb(0 0 0 / 0.8);
  }
  .sl {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    margin: 0;
    font-size: var(--fs-h3);
    font-weight: 700;
  }
  .st {
    margin: 0;
  }
  .kv {
    display: grid;
    gap: var(--sp-2);
    margin: 0;
    padding-block-start: var(--sp-3);
    border-block-start: 1px dashed rgb(150 175 255 / 0.25);
  }
  .kv div {
    display: grid;
    gap: 2px;
  }
  dt {
    color: var(--text-3);
    font-size: var(--fs-micro);
  }
  dd {
    margin: 0;
    font-weight: 600;
  }
  .tot {
    font-size: 2rem;
    font-weight: 800;
  }
  .tot span {
    color: var(--text-2);
    font-size: var(--fs-small);
    font-weight: 500;
  }
  .sn {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    margin: 0;
    color: var(--text-2);
    font-size: var(--fs-small);
  }
  .go {
    min-height: 52px;
    border: 0;
    border-radius: var(--r-pill);
    background: var(--surface-3);
    color: var(--text-2);
    font: inherit;
    font-weight: 650;
  }
  .wait {
    margin: 0;
    color: var(--text-3);
    font-size: var(--fs-micro);
  }
  .empty {
    background: transparent;
    outline: 1px dashed rgb(150 175 255 / 0.25);
    outline-offset: -1px;
  }
  .soon {
    margin: 0;
    color: var(--text-3);
    font-size: var(--fs-micro);
  }
  .field {
    color: var(--text);
    font-weight: 600;
  }
  .pays {
    min-height: 48px;
    max-width: 30rem;
    padding: 0 var(--sp-3);
    border: 0;
    border-radius: var(--r-md);
    background: var(--surface-2);
    color: var(--text);
    font: inherit;
  }
  .pays:focus-visible,
  .waiver:has(input:focus-visible) {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  .waiver {
    display: flex;
    align-items: flex-start;
    gap: var(--sp-2);
    color: var(--text-2);
    font-size: var(--fs-small);
    cursor: pointer;
  }
  .waiver input {
    flex: none;
    width: 20px;
    height: 20px;
    margin: 2px 0 0;
    accent-color: var(--accent);
  }
  .go:not(:disabled) {
    background: var(--accent);
    color: var(--on-accent);
    cursor: pointer;
  }
  .err {
    margin: 0;
    color: var(--danger);
    font-size: var(--fs-small);
  }
  .wait a {
    color: inherit;
  }
</style>
