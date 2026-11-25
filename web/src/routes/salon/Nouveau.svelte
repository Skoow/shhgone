<script lang="ts">
  // Création d'un salon (« /salon/nouveau », spec §39.6) : durée, places, bascule
  // « Les participants peuvent détruire le salon », « Garder dans mon historique ». Compte exigé
  // (D42-26, conception compte §10.4) : sans session, l'écran explique le salon (vitrine fictive,
  // Vitrine.svelte : aucun moteur ni requête) et mène à l'inscription ou à la connexion
  // (« ?suite=salon ») ; rejoindre un salon reste sans compte (D42-26 (2)). Le mot de passe est
  // tiré sur l'appareil (forme générée seulement).
  // Seulement avec __COMPTES__ (et __SALONS__) : le module de compte n'est importé que là.
  import { t, getLang } from "../../i18n/i18n.svelte";
  import { followLink, href, navigate } from "../../app/router.svelte";
  import { account, etatCompte } from "../../account/session.svelte";
  import { creer, type ErreurCreation } from "../../salon/salon.svelte";
  import { DUREES, PLACES_MAX, PLACES_MIN, type Duree } from "../../salon/creation";
  import Cadre from "../compte/Cadre.svelte";
  import Segmented from "../../ui/Segmented.svelte";
  import Stepper from "../../ui/Stepper.svelte";
  import Switch from "../../ui/Switch.svelte";
  import Button from "../../ui/Button.svelte";
  import Banner from "../../ui/Banner.svelte";
  import { formatDayTime } from "../../i18n/format";
  import { untrack } from "svelte";
  import { keepSentDefault, loadHistory, setHistoryEnabled } from "../../history/live.svelte";
  import Vitrine from "./Vitrine.svelte";
  import { Hourglass, Lock, Phone, UserX } from "../../ui/Icon";

  const connecte = $derived(__COMPTES__ && account.etat === "ouvert");
  // Sans session : le titre prend le focus à l'arrivée, comme celui de Cadre.svelte.
  let h1: HTMLHeadingElement | undefined = $state();
  $effect(() => {
    if (h1) untrack(() => h1?.focus({ preventScroll: true }));
  });
  let duree = $state<Duree>(24);
  let ouvert = $state(true);
  let places = $state(2);
  // Limites du palier du compte (conception compte §11) : places et durée au plus ; 10 et 24 h sans réponse.
  let maxPlaces = $state(PLACES_MAX);
  let maxHeures = $state(24);
  $effect(() => {
    if (!connecte) return;
    void etatCompte()
      .then((e) => {
        maxPlaces = Math.max(PLACES_MIN, Math.min(PLACES_MAX, e.limites.places));
        maxHeures = e.limites.heures;
        places = Math.min(places, maxPlaces);
      })
      .catch(() => undefined);
  });
  let detruire = $state(false);
  // « Garder dans mon historique » : le réglage de l'appareil (history/live.svelte.ts,
  // keepSentDefault), désactivé par défaut même avec un compte ; la
  // personne l'active. Changé ici, il vaut aussi pour les envois suivants, comme sur « Lien prêt ».
  // Décochée : « Salon prêt » montre le lien de gestion d'emblée, pour qu'il soit gardé à la main.
  let garder = $state(false);
  // Touchée avant la lecture de l'historique : le choix de la personne l'emporte.
  let touche = false;
  $effect(() => {
    untrack(() =>
      void loadHistory()
        .then(() => {
          if (!touche) garder = keepSentDefault();
        })
        .catch(() => undefined),
    );
  });
  let etape = $state<"cles" | "robot" | "envoi" | null>(null);
  let erreur = $state<ErreurCreation | null>(null);

  const durees = $derived(DUREES.filter((d) => d <= maxHeures).map((d) => ({ value: d, label: t("salon.new.hours", { n: d }) })));
  const choixPlaces = $derived([
    { value: "ouvert", label: t("salon.new.places.open", { n: maxPlaces }) },
    { value: "fixe", label: t("salon.new.places") },
  ]);
  let mode = $state<"ouvert" | "fixe">("ouvert");
  $effect(() => {
    ouvert = mode === "ouvert";
  });

  async function lancer(): Promise<void> {
    erreur = null;
    // Le réglage de l'appareil suit la case, comme la bascule de « Lien prêt ».
    if (garder !== keepSentDefault()) await setHistoryEnabled(garder).catch(() => undefined);
    const e = await creer({ ttlHours: duree, maxMembers: ouvert ? maxPlaces : places, membersCanDestroy: detruire, garder, onEtape: (x) => (etape = x) });
    etape = null;
    if (e) {
      erreur = e;
      return;
    }
    navigate("/salon");
  }

  function texteErreur(e: ErreurCreation): string {
    switch (e.code) {
      case "palier":
        return t("salon.new.err.palier", { salons: e.salons, places: e.places, heures: e.heures });
      case "banni":
        return t("salon.new.err.banni", { date: e.jusqu ? formatDayTime(Date.parse(e.jusqu), getLang()) : "" });
      case "compte_requis":
        return t("salon.new.err.compte");
      default:
        return t(`salon.new.err.${e.code}`);
    }
  }
</script>

{#if !connecte}
  <!-- Sans session : à droite (dessous sur téléphone) ce qu'il faut faire, à gauche (dessus) la
       vitrine. Dans le DOM, le bloc d'action vient d'abord : son titre prend le focus. -->
  <div class="entree" data-salon-entree>
    <section class="action" aria-labelledby="salon-entree-titre">
      <div class="col">
        <div class="tete titre-bandeau">
          <h1 id="salon-entree-titre" class="titre" tabindex="-1" data-large-title bind:this={h1}>{t("salon.vitrine.title")}</h1>
          <p class="sous">{t("salon.vitrine.sub")}</p>
        </div>
        <ul class="points" data-points>
          <li><span class="pic" aria-hidden="true"><Lock size={18} strokeWidth={1.8} /></span><span class="ptx"><strong>{t("salon.vitrine.p1")}</strong><span class="pd">{t("salon.vitrine.p1.d")}</span></span></li>
          <li><span class="pic" aria-hidden="true"><UserX size={18} strokeWidth={1.8} /></span><span class="ptx"><strong>{t("salon.vitrine.p2")}</strong><span class="pd">{t("salon.vitrine.p2.d")}</span></span></li>
          <li><span class="pic" aria-hidden="true"><Hourglass size={18} strokeWidth={1.8} /></span><span class="ptx"><strong>{t("salon.vitrine.p3")}</strong><span class="pd">{t("salon.vitrine.p3.d")}</span></span></li>
          <li><span class="pic" aria-hidden="true"><Phone size={18} strokeWidth={1.8} /></span><span class="ptx"><strong>{t("salon.vitrine.p4")}</strong><span class="pd">{t("salon.vitrine.p4.d")}</span></span></li>
        </ul>
        <!-- Liens de navigation : l'élément reste <a> ; « Créer un compte » en principal. -->
        <div class="entrer">
          <a class="b-entrer principal" data-inscription href={href("/compte/inscription?suite=salon")} onclick={(e) => followLink(e, "/compte/inscription?suite=salon")}>{t("account.signup.title")}</a>
          <a class="lien" data-connexion href={href("/compte/connexion?suite=salon")} onclick={(e) => followLink(e, "/compte/connexion?suite=salon")}>{t("salon.vitrine.login")}</a>
        </div>
        <p class="note rejoindre" data-rejoindre>{t("salon.vitrine.join")}</p>
      </div>
    </section>
    <Vitrine />
  </div>
{:else}
  <Cadre titre={t("salon.new.title")} sous={t("salon.new.sub")}>
    <div class="form">
      <Segmented label={t("salon.new.duration")} options={durees} bind:value={duree} />
      <Segmented label={t("salon.new.places")} options={choixPlaces} bind:value={mode} />
      {#if !ouvert}
        <div class="places">
          <Stepper label={t("salon.new.places")} bind:value={places} min={PLACES_MIN} max={maxPlaces} />
          <span class="val" aria-live="polite">{t("salon.new.places.value", { n: places })}</span>
        </div>
      {/if}
      <Switch label={t("salon.new.destroy")} checked={detruire} onchange={(v) => (detruire = v)} />
      <Switch label={t("salon.new.keep")} hint={t("salon.manage.warn")} checked={garder} onchange={(v) => ((touche = true), (garder = v))} />
      <p class="note">{t("salon.new.password")}</p>
      {#if erreur}
        <Banner kind="danger">{texteErreur(erreur)}</Banner>
      {/if}
      <div class="actions">
        <Button onpress={lancer} busy={etape !== null}>{etape ? t(`salon.new.step.${etape}`) : t("salon.new.create")}</Button>
      </div>
    </div>
  </Cadre>
{/if}

<style>
  /* ---------- Sans session : bloc d'action et vitrine ---------- */
  /* Comme les pages du compte (Cadre.svelte, « panneaux ») : d'un bord à l'autre de la fenêtre
     (100cqw, pas 100vw : pas de défilement horizontal), collée sous l'en-tête et sur le pied. */
  .entree {
    display: grid;
    grid-template-columns: minmax(0, 1.2fr) minmax(min(100%, 30rem), 0.8fr);
    grid-template-areas: "vitrine action";
    min-height: calc(100dvh - 64px);
    margin-inline: calc(50% - 50cqw);
    margin-block: calc(-1 * var(--sp-5)) calc(-1 * var(--sp-5));
  }
  .entree > :global([data-vitrine]) {
    grid-area: vitrine;
  }
  .action {
    grid-area: action;
    display: grid;
    align-content: center;
    justify-items: center;
    min-width: 0;
    padding: var(--sp-6) clamp(24px, 4vw, 56px);
    background: linear-gradient(180deg, rgb(255 255 255 / 0.03), rgb(255 255 255 / 0.008)), var(--surface-1);
    box-shadow: inset 1px 0 0 var(--hair);
  }
  .col {
    display: grid;
    gap: var(--sp-5);
    width: min(100%, 30rem);
    min-width: 0;
  }
  .tete {
    display: grid;
    gap: var(--sp-2);
  }
  .titre {
    margin: 0;
    font-size: clamp(1.625rem, 1.2rem + 0.9vw, 2rem);
    font-weight: 680;
    font-stretch: 108%;
    letter-spacing: -0.025em;
    line-height: 1.1;
    text-wrap: balance;
  }
  .titre:focus {
    outline: none;
  }
  .sous {
    margin: 0;
    color: var(--text-2);
    text-wrap: pretty;
  }
  /* Avantages : pastille ronde (icône menthe), titre, une phrase (points forts du compte). */
  .points {
    display: grid;
    gap: var(--sp-4);
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .points li {
    display: grid;
    grid-template-columns: auto 1fr;
    align-items: start;
    gap: var(--sp-3);
  }
  .pic {
    display: grid;
    place-items: center;
    width: 36px;
    height: 36px;
    border-radius: 50%;
    background: rgb(95 227 181 / 0.1);
    box-shadow: inset 0 0 0 1px rgb(95 227 181 / 0.3);
    color: var(--accent);
  }
  .ptx {
    display: grid;
    gap: 2px;
    padding-top: 2px;
  }
  .ptx strong {
    color: var(--text);
    font-weight: 600;
  }
  .pd {
    color: var(--text-2);
    font-size: var(--fs-small);
    line-height: 1.5;
    text-wrap: pretty;
  }
  .lien {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: 1 1 200px;
    min-height: 48px;
    color: var(--text);
    font-weight: 600;
    text-decoration: underline;
    text-decoration-color: var(--hair-2);
    text-underline-offset: 4px;
    border-radius: 12px;
  }
  @media (hover: hover) {
    .lien:hover {
      color: var(--accent);
      text-decoration-color: currentColor;
    }
  }
  .lien:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  .rejoindre {
    padding-top: var(--sp-4);
    border-top: 1px solid var(--hair);
  }
  /* Tablette et téléphone : la vitrine passe au-dessus, le bloc d'action dessous. */
  @media (max-width: 899px) {
    .entree {
      grid-template-columns: minmax(0, 1fr);
      grid-template-areas: "vitrine" "action";
      min-height: 0;
      margin-block-end: 0;
    }
    .action {
      align-content: start;
      padding: var(--sp-5) var(--sp-4) var(--sp-7);
      box-shadow: inset 0 1px 0 var(--hair);
    }
  }

  /* Mêmes mesures que Button.svelte (48 px, rayon 12 px), en lien. */
  .entrer {
    display: flex;
    flex-wrap: wrap;
    gap: var(--sp-3);
  }
  .b-entrer {
    flex: 1 1 200px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 48px;
    padding: 0 20px;
    border: 1px solid transparent;
    border-radius: 12px;
    font-size: 0.9375rem;
    font-weight: 560;
    line-height: 1.2;
    text-decoration: none;
    -webkit-tap-highlight-color: transparent;
    touch-action: manipulation;
    transition:
      background-color var(--dur-fast) var(--ease-out),
      transform var(--dur-press) var(--ease-out);
  }
  .principal {
    background: var(--accent);
    color: var(--on-accent);
    box-shadow:
      inset 0 1px 0 rgb(255 255 255 / 0.4),
      inset 0 -1px 0 rgb(0 0 0 / 0.14),
      0 10px 24px -14px rgb(0 0 0 / 0.9);
  }
  @media (hover: hover) {
    .principal:hover {
      background: var(--accent-hover);
    }
  }
  .b-entrer:active {
    transform: scale(0.97);
  }
  .b-entrer:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  @media (prefers-reduced-motion: reduce) {
    .b-entrer {
      transition: none;
    }
    .b-entrer:active {
      transform: none;
    }
  }
  @media (forced-colors: active) {
    .b-entrer {
      border-color: LinkText;
    }
  }
  .form {
    display: grid;
    gap: var(--sp-5);
  }
  .places {
    display: flex;
    align-items: center;
    gap: var(--sp-4);
  }
  .val {
    color: var(--text-2);
    font-variant-numeric: tabular-nums;
  }
</style>
