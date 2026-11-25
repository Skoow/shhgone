<script lang="ts">
  // Appareils connectés (conception compte §8.5, §21.15.4 point 5 ; monté seulement
  // avec __COMPTES__) : nom d'appareil déchiffré sur cet appareil (le serveur ne le voit jamais en
  // clair), mois d'ajout, « Cet appareil », « Reste connecté » ; ni adresse IP, ni lieu, ni heure.
  // « Déconnecter » par ligne et « Déconnecter tous les autres appareils ».
  import { untrack } from "svelte";
  import { appareils, deconnecterAppareil, deconnecterAutres, type Appareil } from "../../../account/session.svelte";
  import { getLang, t } from "../../../i18n/i18n.svelte";
  import { announce } from "../../../ui/announce";
  import Button from "../../../ui/Button.svelte";
  import { erreur } from "../erreurs";
  import Section from "./Section.svelte";

  let liste = $state.raw<Appareil[] | null>(null);
  let global = $state("");

  async function charger() {
    try {
      liste = await appareils();
    } catch (e) {
      global = erreur(e, "parametres").texte;
    }
  }
  $effect(() => untrack(() => void charger()));

  /** « 2026-11 » → « novembre 2026 ». */
  function mois(m: string): string {
    const d = new Date(`${m}-01T00:00:00Z`);
    return Number.isNaN(d.getTime()) ? m : new Intl.DateTimeFormat(getLang(), { month: "long", year: "numeric", timeZone: "UTC" }).format(d);
  }
  async function fermer(a: Appareil) {
    global = "";
    try {
      await deconnecterAppareil(a.sid);
    } catch (e) {
      global = erreur(e, "parametres").texte;
      return;
    }
    announce(t("account.devices.done"));
    await charger();
  }
  async function autres() {
    global = "";
    try {
      await deconnecterAutres();
    } catch (e) {
      global = erreur(e, "parametres").texte;
      return;
    }
    announce(t("account.devices.othersDone"));
    await charger();
  }
</script>

<Section id="sec-devices" titre={t("account.section.devices")}>
  {#if liste === null && !global}
    <p class="note" aria-busy="true">{t("account.devices.loading")}</p>
  {:else if liste}
    <ul class="apps">
      {#each liste as a (a.sid)}
        <li class="ligne">
          <div class="lib">
            <span class="nom"><bdi>{a.nom ?? t("account.devices.unnamed")}</bdi>{#if a.courante}<span class="puce">{t("account.devices.this")}</span>{/if}</span>
            <span class="val">{t("account.devices.added", { mois: mois(a.ajoutee) })}{#if a.persistante}{" · "}{t("account.devices.stay")}{/if}</span>
          </div>
          {#if !a.courante}
            <Button variant="secondary" dense aria-label={t("account.devices.logoutName", { nom: a.nom ?? t("account.devices.unnamed") })} onpress={() => fermer(a)}>{t("account.devices.logout")}</Button>
          {/if}
        </li>
      {/each}
    </ul>
    {#if liste.some((a) => !a.courante)}
      <div class="actions"><Button variant="ghost" onpress={autres}>{t("account.devices.others")}</Button></div>
    {/if}
  {/if}
  {#if global}<p class="err" role="alert">{global}</p>{/if}
</Section>

<style>
  .apps {
    display: grid;
    gap: var(--sp-1);
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .nom {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--sp-2);
    font-weight: 560;
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .puce {
    padding: 2px 8px;
    border-radius: 999px;
    background: var(--accent-tint);
    color: var(--accent);
    font-size: var(--fs-micro);
    font-weight: 600;
  }
</style>
