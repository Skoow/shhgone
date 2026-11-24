<script lang="ts">
  // Création d'un salon (« /salon/nouveau », spec §39.6 ; plan C-3) : durée, places, bascule
  // « Les participants peuvent détruire le salon », « Garder dans mon historique ». Compte exigé
  // (D42-26, conception compte §10.4) : sans session, l'écran mène à la connexion
  // (« ?suite=salon »). Le mot de passe est tiré sur l'appareil (forme générée seulement).
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

  const connecte = $derived(__COMPTES__ && account.etat === "ouvert");
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
  // keepSentDefault), désactivé par défaut même avec un compte (décision du 24 novembre, B) ; la
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

<Cadre titre={t("salon.new.title")} sous={t("salon.new.sub")}>
  {#if !connecte}
    <p class="note">{t("salon.new.login")}</p>
    <!-- Seule action de l'écran (revue du 20 novembre, U19) : de vrais boutons, « Se connecter »
         en principal. Liens de navigation : l'élément reste <a>. -->
    <div class="entrer">
      <a class="b-entrer principal" href={href("/compte/connexion?suite=salon")} onclick={(e) => followLink(e, "/compte/connexion?suite=salon")}>{t("account.login.title")}</a>
      <a class="b-entrer second" href={href("/compte/inscription?suite=salon")} onclick={(e) => followLink(e, "/compte/inscription?suite=salon")}>{t("account.signup.title")}</a>
    </div>
  {:else}
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
  {/if}
</Cadre>

<style>
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
  .second {
    background: rgb(255 255 255 / 0.045);
    color: var(--text);
    border-color: var(--hair-2);
    box-shadow: var(--edge-hi);
  }
  @media (hover: hover) {
    .principal:hover {
      background: var(--accent-hover);
    }
    .second:hover {
      background: rgb(255 255 255 / 0.08);
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
