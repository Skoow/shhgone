<script lang="ts">
  // Page Offres (maquette du lot 2 de l'audit de design, demande du propriétaire : « le panneau de
  // prix sur le côté, en haut ») : à gauche, le rythme (mensuel ou annuel), les trois offres (Plus
  // mis en avant ; toute la carte choisit l'offre) et le comparatif aligné sur leurs colonnes (les
  // cartes ne disent que le prix et une ligne-clé, le tableau seul porte le détail) ; à droite, le
  // panneau de paiement collant (récapitulatif, moyen, pays, renonciation, bouton). Téléphone :
  // carrousel des offres, panneau de paiement dessous, tableau qui défile en largeur (première
  // colonne fixe). Plus de questions fréquentes (retirées le 25 novembre). Chiffres lus dans PAID et limits.ts.
  //
  // Paiement (conception du paiement) : le bouton n'est actif que si CE serveur
  // propose le moyen choisi (GET /api/paiement ; démo, serveur sans paiement : inactif, la raison
  // est dite), le pays (UE) choisi, le rythme de l'annuel choisi (jamais présélectionné) et la
  // case de renonciation cochée (jamais précochée, §38.1). Au clic : un pass P est tiré et rangé
  // sur l'appareil AVANT la commande, puis la page hébergée du prestataire s'ouvre (redirection,
  // aucun script tiers ici). Rien n'est payé sur Shhgone.
  //
  // Preuve anti-robot : la commande porte une preuve de travail ALTCHA
  // (défi lu et calculé dans son Worker dès que le bouton peut servir, comme les pages du compte) ;
  // aucun repli tiers ici (le pass est sur cette page).
  import { formatBytes, formatDuration } from "../i18n/format";
  import { getLang, t } from "../i18n/i18n.svelte";
  import { creationsFermees, texteBandeau } from "../maintenance/etat.svelte";
  import { CONTENT_MAX, CREATES_PER_DAY, MAX_OPENS, PAID, TTL_MAX_HOURS, type PaidTier } from "../limits";
  import { commander, lireOffre, type ErreurCommande, type Moyen, type OffreServeur, type Preuve } from "../paiement/api";
  import { garder, idbDuNavigateur, lirePasses, nouvelId, oublier, tirerPass } from "../paiement/pass";
  import { paysProbable } from "../paiement/pays";
  import { formulesDisponibles } from "../paiement/disponibles";
  import { href } from "../app/router.svelte";
  import { LimiteDefi, obtenirPreuve, preparerPreuve } from "../paiement/preuve";
  import { Check, Lock, Timer } from "./Icon";
  import Banner from "./Banner.svelte";

  type Billing = "month" | "year";
  // Mensuel sélectionné par défaut.
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
  /** Ligne-clé de la carte : « 10 Go · 3 jours · 10 ouvertures ». */
  const key = (x: Tier) => {
    const [size, ttl] = details(x);
    return `${size!.v} · ${ttl!.v} · ${t("options.opens.count", { n: x === "free" ? MAX_OPENS : PAID[x].opens })}`;
  };
  // Comparatif, par groupes : seulement ce que les cartes ne disent pas en détail. La durée de
  // vidéo filmée par offre (CAPTURE_MAX_S) n'y est pas : la capture applique encore la limite
  // gratuite à tous (CAPTURE_TIER), ce serait promettre ce qui n'est pas codé.
  type Row = { k: string; v: (x: Tier) => string; calls?: true; same?: true };
  const groups = $derived<{ g: string; rows: Row[] }[]>([
    {
      g: t("offers.cmp.g.shares"),
      rows: [
        ...details("free").map((d, i) => ({ k: d.k, v: (x: Tier) => details(x)[i]!.v })),
        { k: t("offers.cmp.shares"), v: (x: Tier) => (x === "free" ? t("offers.cmp.perDay", { n: CREATES_PER_DAY }) : t("offers.cmp.perPeriod", { n: PAID[x].shares })) },
      ],
    },
    { g: t("offers.cmp.g.onsite"), rows: [{ k: t("offers.calls.label"), v: (x: Tier) => (x === "free" ? t("offers.calls.no") : t("offers.calls.yes")), calls: true }] },
    { g: t("offers.cmp.g.security"), rows: [{ k: t("offers.cmp.e2e"), v: () => t("offers.cmp.same"), same: true }] },
  ]);
  const price = (x: PaidTier) => (billing === "month" ? PAID[x].month : PAID[x].year);
  const per = $derived(billing === "month" ? t("offers.per.month") : t("offers.per.year"));
  // Moyen de paiement : carte bancaire (Stripe), PayPal, crypto
  // (NOWPayments). Noms de l'écran (clés de texte) → noms de l'API.
  type Means = "card" | "paypal" | "crypto";
  let means = $state<Means>("card");
  const TOUS: readonly Means[] = ["card", "paypal", "crypto"];
  const API: Readonly<Record<Means, Moyen>> = { card: "carte", paypal: "paypal", crypto: "crypto" };
  // Ce que l'offre choisie ajoute au gratuit (lu dans PAID et limits.ts). Le départ du compte à
  // rebours à la première ouverture n'est pas encore codé : dit « bientôt ».
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
  // dit en tête de page et sur les boutons « Bientôt », plutôt qu'au
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
  // sa page (état, arrêt du renouvellement à tout moment, note de vente ; :
  // la résiliation n'était joignable qu'au retour du paiement).
  let mien = $state(false);
  let detenue = $state<"free" | PaidTier>("free");
  $effect(() => {
    let vivant = true;
    void lireOffre().then((o) => {
      if (!vivant) return;
      serveur = o;
      lue = true;
    });
    const idb = idbDuNavigateur();
    if (idb !== null) {
      void lirePasses(idb).then((l) => {
        if (vivant) mien = l.length > 0;
      });
      // Offre réellement détenue (28 novembre) : « votre offre » sur sa carte, plus sur Gratuit.
      void formulesDisponibles(idb)
        .then((l) => {
          if (vivant) detenue = l.includes("pro") ? "pro" : l.includes("plus") ? "plus" : "free";
        })
        .catch(() => undefined);
    }
    return () => {
      vivant = false;
    };
  });
  // Annuel par carte ou PayPal : paiement unique ou renouvellement, au choix, jamais présélectionné.
  let renew = $state<"once" | "auto" | null>(null);
  const renewAsked = $derived(billing === "year" && means !== "crypto");
  const renouvelle = $derived(means === "crypto" ? false : billing === "month" ? true : renew === "auto");
  let pays = $state("");
  // Pays proposé d'avance, une fois la liste du serveur lue : deviné sur l'appareil
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
  // Raison dite sous le bouton : paiement fermé d'abord, puis l'offre à choisir, puis le blocage.
  const pourquoi = $derived(serveur !== null && chosen === null ? t("offers.summary.pick") : blocage);
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
  <div class="top">
    {#if ferme}
      <div class="ferme" data-pay-closed><Banner kind="info">{t("offers.continue.wait")}</Banner></div>
    {/if}
    {#if mien}
      <p class="mine" data-mine>{t("offers.mine")} <a href={href("/offres/retour")}>{t("offers.mine.link")}</a></p>
    {/if}
    <!-- Grille commune aux cartes et au comparatif : une colonne d'intitulés, puis Gratuit, Plus, Pro. -->
    <div class="plans">
      <div class="lead">
        <h2 id="{uid}-pick">{t("offers.choose.label")}</h2>
        <p class="same"><Lock size={14} strokeWidth={2.2} aria-hidden="true" />{t("offers.adds.same")}</p>
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
        <!-- Prix affichés sans « TTC » à chaque ligne : dit une fois ici. -->
        <p class="ttc" data-ttc>{t("offers.ttc")}</p>
      </div>
      <fieldset class="tiers" aria-labelledby="{uid}-pick">
        {#each TIERS as x (x)}
          <!-- Toute la carte choisit l'offre : clic n'importe où ; le clavier passe par le bouton
               radio du bas de la carte (« Choisir Plus »). -->
          <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
          <div class={["card", x, { on: chosen === x, pickable: x !== "free" }]} data-tier={x} onclick={x === "free" ? undefined : () => (chosen = x)}>
            {#if x === "plus"}<span class="badge">{t("offers.badge.plus")}</span>{/if}
            <p class="nm">{name(x)}{#if x !== "free" && ferme}<span class="sbadge" data-soon>{t("offers.soon")}</span>{/if}</p>
            {#if x === "free"}
              <p class="big num"><span class="pv">{eur(0)}</span>{" "}<span class="pu">{t("offers.card.free")}</span></p>
              <p class="alt" aria-hidden="true">&nbsp;</p>
            {:else}
              <p class="big num" data-price><span class="pv">{eur(price(x))}</span>{" "}<span class="pu">{per}</span></p>
              <p class="alt num">{billing === "month" ? t("offers.card.year", { price: eur(PAID[x].year) }) : t("offers.card.monthAlt", { price: eur(PAID[x].month) })}</p>
            {/if}
            <p class="key num">{key(x)}</p>
            {#if x === detenue && x !== "free"}<p class="cur-mark" data-current-tier>{t("offers.free.now")}</p>{/if}
            {#if x === "free"}
              <span class="cta cur"><span class="cap">{x === detenue ? t("offers.free.now") : "\u00a0"}</span></span>
            {:else}
              {@const tier = x}
              <label class="cta pick">
                <input type="radio" name="{uid}-tier" value={tier} bind:group={chosen} />
                {#if chosen === tier}<Check size={16} strokeWidth={3} aria-hidden="true" />{t("offers.picked", { tier: name(tier) })}{:else}{t("offers.pick", { tier: name(tier) })}{/if}
              </label>
            {/if}
          </div>
        {/each}
      </fieldset>
    </div>
  </div>

  <!-- Panneau de paiement : à droite et collant sur ordinateur, sous les offres sur téléphone. -->
  <aside class="side" aria-labelledby="{uid}-pay">
    <div class="pay" data-summary={chosen ? "" : undefined}>
      <h2 id="{uid}-pay" class="pt">{t("offers.pay.title")}</h2>
      <div class="rc" aria-live="polite">
        <p class="sl">{t("offers.summary.label")}</p>
        {#if chosen}
          <p class="st"><b>{name(chosen)}</b> · {billing === "month" ? t("offers.billing.month") : t("offers.billing.year")} · <span class="num">{eur(price(chosen))} {per}</span></p>
          <ul class="adds">
            {#each adds as a, i (a)}<li>{#if i === 3}<Timer size={14} strokeWidth={2.2} aria-hidden="true" />{:else}<Check size={14} strokeWidth={2.6} aria-hidden="true" />{/if}<span>{a}</span></li>{/each}
          </ul>
          <!-- Réserve de partages payants (information obligatoire avant paiement ;
               mêmes chiffres que les Conditions de vente : PAID.shares = JetonsPeriod d'offres.go). -->
          <p class="sn" data-reserve>{t("offers.summary.reserve", { n: PAID[chosen].shares })}</p>
        {:else}
          <p class="sn pickme"><Timer size={16} strokeWidth={2} aria-hidden="true" />{t("offers.summary.pick")}</p>
        {/if}
      </div>

      <section class="stp" aria-labelledby="{uid}-s1">
        <h3 id="{uid}-s1"><span class="n num" aria-hidden="true">1</span>{t("offers.means.title")}</h3>
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
      </section>

      <section class="stp">
        <h3><span class="n num" aria-hidden="true">2</span><label for="{uid}-pays">{t("offers.country.label")}</label></h3>
        <select id="{uid}-pays" class="pays" bind:value={pays} aria-describedby="{uid}-pays-note" data-pays>
          <option value="">{t("offers.country.pick")}</option>
          {#each regions as r (r.c)}<option value={r.c}>{r.n}</option>{/each}
        </select>
        <p id="{uid}-pays-note" class="note">{t("offers.country.note")}</p>
      </section>

      <section class="stp" aria-labelledby="{uid}-s3">
        <h3 id="{uid}-s3"><span class="n num" aria-hidden="true">3</span>{t("offers.waiver.title")}</h3>
        <label class="waiver">
          <input type="checkbox" bind:checked={waiver} data-waiver />
          <span>{t("offers.waiver")}</span>
        </label>
      </section>

      {#if chosen}
        <p class="tot"><span>{t("offers.summary.total")}</span><span class="num">{eur(price(chosen))} <small>{per}</small></span></p>
        <p class="sn">{means === "crypto" ? t("offers.summary.crypto") : billing === "month" ? t("offers.summary.month") : t("offers.summary.year")}</p>
      {/if}
      <!-- Redémarrage annoncé (D42-32) : aucune nouvelle commande d'ici la fin de la maintenance. -->
      <button type="button" class="go" disabled={chosen === null || blocage !== null || busy || going || creationsFermees()} aria-describedby="{uid}-wait" onclick={payer} data-pay>
        {ferme ? t("offers.soon") : going ? t("offers.going", { who }) : t("offers.continue", { who })}
      </button>
      {#if erreur}
        <p class="err" role="alert" data-pay-error>{erreur === "maintenance" ? texteBandeau() || t("offers.err.maintenance") : t(`offers.err.${erreur}`)}</p>
      {:else if creationsFermees()}
        <p class="err" data-pay-maintenance>{texteBandeau()}</p>
      {/if}
      <p id="{uid}-wait" class={["wait", { warn: chosen !== null && blocage !== null && !ferme }]} data-wait>{pourquoi ?? ""}</p>
      <p class="dev">{t("offers.device")} <a href={href("/conditions")}>{t("offers.terms")}</a></p>
    </div>
  </aside>

  <!-- Comparatif aligné sur les colonnes des cartes ; défile en largeur sur téléphone (première
       colonne fixe). Les en-têtes de colonne ne se voient que sur téléphone (les cartes sont au-dessus
       sur ordinateur) ; les lecteurs d'écran les ont partout. Zone qui défile : focusable pour le
       clavier (règle axe scrollable-region-focusable). -->
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <div class="cmpw" role="region" aria-labelledby="{uid}-cmp" tabindex="0">
    <table class="cmp">
      <caption id="{uid}-cmp" class="sr-only">{t("offers.cmp.label")}</caption>
      <colgroup><col class="c1" /><col /><col /><col /></colgroup>
      <thead class="chd">
        <tr><th scope="col"><span class="sr-only">{t("offers.cmp.what")}</span></th>{#each TIERS as x (x)}<th scope="col" class={x}>{name(x)}</th>{/each}</tr>
      </thead>
      {#each groups as gr (gr.g)}
        <tbody>
          <tr class="grp"><th scope="colgroup" colspan="4">{gr.g}</th></tr>
          {#each gr.rows as r (r.k)}
            <tr>
              <th scope="row">{r.k}</th>
              {#each TIERS as x (x)}<td class={[x, { no: r.calls && x === "free", eq: r.same }]} data-calls={r.calls ? x : undefined}>{r.v(x)}</td>{/each}
            </tr>
          {/each}
        </tbody>
      {/each}
    </table>
  </div>

</div>

<style>
  .co {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: var(--sp-6);
    align-items: start;
  }
  /* Ordinateur : offres et comparatif à gauche, panneau de paiement à droite, en haut, collant. */
  @media (min-width: 1024px) {
    .co {
      grid-template-columns: minmax(0, 1fr) minmax(320px, 360px);
      grid-template-areas:
        "top side"
        "cmp side";
      grid-template-rows: auto 1fr;
      column-gap: clamp(32px, 3.5vw, 56px);
      row-gap: 0;
    }
    .top {
      grid-area: top;
    }
    .side {
      grid-area: side;
      position: sticky;
      inset-block-start: 88px;
    }
    .cmpw {
      grid-area: cmp;
    }
  }
  .top {
    display: grid;
    gap: var(--sp-5);
    min-width: 0;
  }
  .mine,
  .ferme {
    margin: 0;
  }
  h2 {
    margin: 0;
  }
  fieldset {
    margin: 0;
    padding: 0;
    border: 0;
    min-width: 0;
  }

  /* ---------- Offres : grille commune (intitulés 1,1 part, puis trois colonnes égales) ---------- */
  .plans {
    display: grid;
    grid-template-columns: 1.1fr 3fr;
    align-items: end;
    min-width: 0;
  }
  .tiers {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    align-items: stretch;
    padding-block-start: 14px;
  }
  .lead {
    display: grid;
    gap: var(--sp-3);
    align-content: end;
    padding: 0 var(--sp-4) var(--sp-4) 0;
    min-width: 0;
  }
  .lead h2 {
    font-size: 1.125rem;
    font-weight: 650;
  }
  .same {
    display: flex;
    align-items: flex-start;
    gap: var(--sp-2);
    margin: 0;
    color: var(--text-2);
    font-size: var(--fs-small);
    line-height: 1.45;
  }
  .same :global(svg) {
    flex: none;
    margin-block-start: 3px;
    color: var(--accent);
  }
  .ttc {
    margin: 0;
    color: var(--text-3);
    font-size: var(--fs-micro);
  }
  /* Rythme : interrupteur segmenté. */
  .billing {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 4px;
    padding: 4px;
    border-radius: 14px;
    background: var(--surface-1);
    box-shadow: inset 0 0 0 1px var(--hair-2);
  }
  .billing label {
    position: relative;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: center;
    column-gap: 6px;
    min-height: 44px;
    padding: 4px var(--sp-2);
    border-radius: 10px;
    color: var(--text-2);
    font-weight: 600;
    text-align: center;
    cursor: pointer;
    transition:
      background-color var(--dur-fast) var(--ease-out),
      color var(--dur-fast) var(--ease-out);
  }
  .billing label.on {
    background: var(--surface-3);
    color: var(--text);
    box-shadow: var(--edge-hi), 0 2px 8px -2px rgb(0 0 0 / 0.8);
  }
  .gift {
    color: var(--accent);
    font-size: 0.75rem;
    font-weight: 600;
  }
  .card {
    position: relative;
    display: grid;
    grid-template-rows: auto auto auto 1fr auto;
    gap: 4px;
    min-width: 0;
    padding: var(--sp-5) var(--sp-4) var(--sp-4);
    border-radius: 20px 20px 0 0;
    background: linear-gradient(180deg, rgb(255 255 255 / 0.04), transparent 90%);
    box-shadow: inset 0 1px 0 var(--hair-2);
    transition:
      background-color var(--dur-fast) var(--ease-out),
      box-shadow var(--dur-fast) var(--ease-out);
  }
  .card.plus {
    background: linear-gradient(180deg, rgb(62 193 245 / 0.13), rgb(62 193 245 / 0.03) 90%);
    box-shadow:
      inset 1px 0 0 rgb(62 193 245 / 0.5),
      inset -1px 0 0 rgb(62 193 245 / 0.5),
      inset 0 1px 0 rgb(62 193 245 / 0.5);
  }
  .card.pro {
    background: linear-gradient(180deg, rgb(92 128 255 / 0.1), transparent 90%);
  }
  .card.pickable {
    cursor: pointer;
  }
  @media (hover: hover) {
    .card.pickable:not(.on):hover {
      background-color: rgb(255 255 255 / 0.03);
    }
  }
  .card.on {
    box-shadow:
      inset 2px 0 0 var(--accent),
      inset -2px 0 0 var(--accent),
      inset 0 2px 0 var(--accent);
  }
  .badge {
    position: absolute;
    inset-block-start: -12px;
    inset-inline-start: var(--sp-4);
    padding: 3px 10px;
    border-radius: var(--r-pill);
    background: var(--plus);
    color: #04121b;
    font-size: 0.75rem;
    font-weight: 700;
  }
  /* Offre payante détenue (28 novembre) : dite sur sa carte. */
  .cur-mark {
    justify-self: start;
    margin: 0;
    padding: 2px 10px;
    border-radius: var(--r-pill);
    background: var(--accent-tint);
    color: var(--accent);
    font-size: 0.75rem;
    font-weight: 700;
  }
  .nm {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--sp-2);
    margin: 0;
    font-size: 1.0625rem;
    font-weight: 700;
  }
  .plus .nm {
    color: var(--plus);
  }
  .pro .nm {
    color: var(--pro);
  }
  .sbadge {
    padding: 1px 8px;
    border-radius: var(--r-pill);
    background: rgb(255 255 255 / 0.07);
    color: var(--text-2);
    font-size: 0.6875rem;
    font-weight: 600;
  }
  .big {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    column-gap: 6px;
    margin: var(--sp-2) 0 0;
  }
  .pv {
    font-size: clamp(2rem, 1.4rem + 1.2vw, 2.75rem);
    font-weight: 750;
    font-stretch: 112%;
    letter-spacing: -0.03em;
    line-height: 1;
  }
  .pu {
    color: var(--text-2);
    font-size: var(--fs-small);
  }
  .alt {
    margin: 0;
    min-height: 1.25rem;
    color: var(--text-3);
    font-size: 0.8125rem;
  }
  .key {
    margin: var(--sp-3) 0 0;
    font-family: var(--font-mono);
    font-size: 0.8125rem;
    font-weight: 600;
    line-height: 1.45;
  }
  .cta {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    min-height: 44px;
    margin-block-start: var(--sp-4);
    padding: 0 var(--sp-3);
    border-radius: var(--r-md);
    font-size: 0.9375rem;
    font-weight: 650;
    text-align: center;
  }
  .cta.cur {
    box-shadow: inset 0 0 0 1px var(--hair-2);
    color: var(--text-2);
  }
  .cap {
    display: inline-block;
  }
  .cap::first-letter {
    text-transform: uppercase;
  }
  .pick {
    background: var(--surface-2);
    box-shadow: inset 0 0 0 1px var(--hair-2);
    color: var(--text);
    cursor: pointer;
  }
  .plus .pick {
    background: var(--plus);
    box-shadow: none;
    color: #04121b;
  }
  .card.on .pick {
    background: var(--accent);
    box-shadow: none;
    color: var(--on-accent);
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

  /* ---------- Comparatif ---------- */
  .cmpw {
    min-width: 0;
  }
  .cmpw:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 4px;
    border-radius: 8px;
  }
  .cmp {
    width: 100%;
    border-collapse: collapse;
    table-layout: fixed;
  }
  /* Même partage que .plans : 1,1 / 4,1 pour les intitulés. */
  .cmp col.c1 {
    width: 26.83%;
  }
  .cmp th,
  .cmp td {
    padding: 14px var(--sp-4);
    border-block-start: 1px solid var(--hair);
    font-size: 0.9375rem;
    text-align: start;
    vertical-align: top;
    overflow-wrap: break-word;
  }
  .cmp tbody th {
    padding-inline-start: 0;
    color: var(--text-2);
    font-weight: 500;
  }
  .cmp td {
    font-variant-numeric: tabular-nums;
    font-weight: 600;
  }
  .cmp .grp th {
    padding-block: var(--sp-5) var(--sp-2);
    border-block-start: 0;
    color: var(--text);
    font-size: 0.875rem;
    font-weight: 650;
  }
  .cmp td.plus {
    background: rgb(62 193 245 / 0.04);
    box-shadow:
      inset 1px 0 0 rgb(62 193 245 / 0.5),
      inset -1px 0 0 rgb(62 193 245 / 0.5);
  }
  /* La colonne Plus reste ouverte entre deux groupes (la ligne de groupe n'a qu'une cellule). */
  .cmp tbody:last-of-type tr:last-child td.plus {
    border-radius: 0 0 20px 20px;
    box-shadow:
      inset 1px 0 0 rgb(62 193 245 / 0.5),
      inset -1px 0 0 rgb(62 193 245 / 0.5),
      inset 0 -1px 0 rgb(62 193 245 / 0.5);
  }
  .cmp td.no {
    color: var(--text-3);
    font-weight: 450;
  }
  .cmp td.eq {
    color: var(--accent);
  }
  .chd th {
    padding-block: var(--sp-2);
    border-block-start: 0;
    font-size: var(--fs-small);
    font-weight: 700;
  }
  .chd th.plus {
    color: var(--plus);
  }
  .chd th.pro {
    color: var(--pro);
  }
  /* Ordinateur : les cartes font office d'en-tête de colonne (en-tête lu, pas montré). */
  @media (min-width: 640px) {
    .chd {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip-path: inset(50%);
      white-space: nowrap;
    }
  }

  /* ---------- Panneau de paiement ---------- */
  .pay {
    display: grid;
    gap: var(--sp-4);
    padding: var(--sp-5);
    border-radius: var(--r-xl);
    background: linear-gradient(180deg, #161a23, #11141b);
    box-shadow:
      inset 0 0 0 1px var(--hair-2),
      var(--edge-hi),
      0 30px 60px -30px rgb(0 0 0 / 0.9);
  }
  .pt {
    font-size: var(--fs-h3);
    font-weight: 700;
    letter-spacing: -0.01em;
  }
  .rc {
    display: grid;
    gap: var(--sp-2);
    padding-block-end: var(--sp-4);
    border-block-end: 1px solid var(--hair);
  }
  .sl {
    margin: 0;
    color: var(--text-3);
    font-size: var(--fs-micro);
    font-weight: 600;
    letter-spacing: 0.02em;
  }
  .st {
    margin: 0;
  }
  .adds {
    display: grid;
    gap: 6px;
    margin: 0;
    padding: 0;
    list-style: none;
    color: var(--text-2);
    font-size: var(--fs-small);
  }
  .adds li {
    display: flex;
    gap: var(--sp-2);
  }
  .adds :global(svg) {
    flex: none;
    margin-block-start: 3px;
    color: var(--accent);
  }
  .sn {
    margin: 0;
    color: var(--text-2);
    font-size: var(--fs-small);
  }
  .pickme {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
  }
  .stp {
    display: grid;
    gap: var(--sp-2);
  }
  h3 {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    margin: 0;
    font-size: 1rem;
    font-weight: 650;
  }
  .n {
    display: inline-grid;
    place-items: center;
    width: 22px;
    height: 22px;
    border-radius: 6px;
    background: rgb(95 227 181 / 0.12);
    color: var(--accent);
    font-family: var(--font-mono);
    font-size: 0.75rem;
    font-weight: 700;
  }
  .sub {
    margin: var(--sp-2) 0 0;
    font-size: var(--fs-small);
    font-weight: 600;
  }
  .means {
    display: grid;
    gap: 6px;
  }
  .mn {
    position: relative;
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    justify-content: space-between;
    column-gap: var(--sp-3);
    min-height: 44px;
    padding: 10px var(--sp-3);
    border-radius: var(--r-md);
    background: var(--surface-1);
    box-shadow: inset 0 0 0 1px var(--hair-2);
    cursor: pointer;
  }
  .mn.on {
    background: rgb(95 227 181 / 0.05);
    box-shadow: inset 0 0 0 1.5px var(--accent);
  }
  .mt {
    font-weight: 620;
  }
  .ms {
    color: var(--text-2);
    font-size: 0.8125rem;
  }
  .note {
    margin: 0;
    color: var(--text-3);
    font-size: 0.8125rem;
    line-height: 1.45;
  }
  .pays {
    min-height: 48px;
    width: 100%;
    padding: 0 var(--sp-3);
    border: 0;
    border-radius: var(--r-md);
    background: var(--surface-2);
    box-shadow: inset 0 0 0 1px var(--hair-2);
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
  .tot {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: var(--sp-3);
    margin: 0;
    padding-block-start: var(--sp-4);
    border-block-start: 1px solid var(--hair);
    font-size: 1.125rem;
    font-weight: 700;
  }
  .tot small {
    color: var(--text-2);
    font-size: var(--fs-small);
    font-weight: 500;
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
  .go:not(:disabled) {
    background: var(--accent);
    color: var(--on-accent);
    cursor: pointer;
  }
  .go:focus-visible {
    outline: 2px solid var(--text);
    outline-offset: 3px;
  }
  .wait,
  .dev {
    margin: 0;
    color: var(--text-3);
    font-size: var(--fs-micro);
  }
  .wait.warn {
    color: var(--warn);
  }
  .dev a {
    color: inherit;
  }
  .err {
    margin: 0;
    color: var(--danger);
    font-size: var(--fs-small);
  }

  /* ---------- Téléphone et tablette ---------- */
  @media (max-width: 1023px) {
    .side {
      max-width: 40rem;
    }
  }
  @media (max-width: 639px) {
    .plans {
      grid-template-columns: minmax(0, 1fr);
      gap: var(--sp-2);
    }
    .lead {
      padding: 0;
    }
    /* Carrousel aimanté : Plus visible au bord dès le chargement. */
    .tiers {
      display: flex;
      gap: var(--sp-3);
      margin-inline: -16px;
      padding: 14px 16px 4px;
      overflow-x: auto;
      scroll-snap-type: x mandatory;
      scroll-padding-inline: 16px;
      scrollbar-width: none;
    }
    .tiers::-webkit-scrollbar {
      display: none;
    }
    .card,
    .card.plus,
    .card.on {
      flex: 0 0 78%;
      scroll-snap-align: start;
      border-radius: 20px;
    }
    .card {
      box-shadow: inset 0 0 0 1px var(--hair-2);
    }
    .card.plus {
      box-shadow: inset 0 0 0 1px rgb(62 193 245 / 0.5);
    }
    .card.on {
      box-shadow: inset 0 0 0 2px var(--accent);
    }
    .cmpw {
      margin-inline: -16px;
      padding-inline: 16px;
      overflow-x: auto;
    }
    .cmp {
      min-width: 520px;
    }
    .cmp col.c1 {
      width: 30%;
    }
    .cmp th,
    .cmp td {
      padding: 12px 10px;
      font-size: 0.8125rem;
    }
    /* Première colonne fixe pendant le défilement. */
    .cmp th[scope="row"],
    .chd th:first-child {
      position: sticky;
      inset-inline-start: 0;
      z-index: 1;
      background: var(--bg);
    }
    .cmp .grp th {
      position: sticky;
      inset-inline-start: 0;
    }
    .cmp tbody:last-of-type tr:last-child td.plus {
      border-radius: 0 0 12px 12px;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .card,
    .billing label {
      transition: none;
    }
  }
  @media (forced-colors: active) {
    .card.on,
    .mn.on,
    .billing label.on {
      outline: 2px solid Highlight;
    }
  }
</style>
