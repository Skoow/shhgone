<script lang="ts">
  // Passkeys (conception du compte par passkey §3.5 ; plan, lot W2 ; monté seulement avec
  // __COMPTES__). Liste : libellé déchiffré sur cet appareil (jamais lu par le serveur), mois
  // d'ajout, « liée à cet appareil » (non synchronisable), « ouvre vos données » (enveloppe PRF),
  // « cette passkey » (celle de la session). Ajouter (3 actions : « Ajouter », « Créer la passkey »,
  // le geste), renommer, retirer (jamais la dernière). Ajout et retrait demandent une session
  // récente : sinon « Confirmer avec une passkey » d'abord. Chaque cérémonie est chargée avant le
  // clic qui appelle le navigateur (Safari).
  import { tick, untrack } from "svelte";
  import { account, ajouterPasskey, confirmerParPasskey, deuxiemeGesteAjout, listePasskeys, nommerPasskey, preparerAjout, preparerReauth, retirerPasskey, type PasskeyVue } from "../../../account/session.svelte";
  import { t } from "../../../i18n/i18n.svelte";
  import { announce } from "../../../ui/announce";
  import Banner from "../../../ui/Banner.svelte";
  import Button from "../../../ui/Button.svelte";
  import InlineConfirm from "../../../ui/InlineConfirm.svelte";
  import TextField from "../../../ui/TextField.svelte";
  import { annulee, codeDe, erreur, moisLong } from "../erreurs";
  import Section from "./Section.svelte";

  let liste = $state.raw<PasskeyVue[] | null>(null);
  let global = $state("");
  let ok = $state("");
  /** Ajout : fermé, confirmation d'abord (session pas récente), prêt (cérémonie chargée), deuxième geste. */
  let ajout = $state<"ferme" | "recent" | "pret" | "second">("ferme");
  let nom = $state("");
  /** Retrait en attente d'une confirmation par passkey. */
  let aRetirer = $state<string | null>(null);
  let renomme = $state<string | null>(null);
  let nouveauNom = $state("");
  let elNom: HTMLInputElement | undefined = $state();

  async function charger() {
    try {
      liste = await listePasskeys();
    } catch (e) {
      global = erreur(e, "parametres").texte;
    }
  }
  $effect(() =>
    untrack(() => {
      void charger();
      preparerReauth().catch(() => undefined);
      // Cérémonie rechargée avant son échéance (5 min au serveur) : le geste n'attend jamais de requête.
      const m = setInterval(() => preparerReauth().catch(() => undefined), 240_000);
      return () => clearInterval(m);
    }),
  );

  const nomDe = (p: PasskeyVue) => p.nom ?? t("account.passkeys.unnamed");
  const sansSync = $derived(liste !== null && liste.length > 0 && liste.every((p) => !p.synchronisable));

  function montrer(e: unknown) {
    if (annulee(e)) return;
    global = erreur(e, "parametres").texte;
    announce(global);
  }

  async function ouvrirAjout() {
    global = ok = "";
    try {
      ajout = (await preparerAjout()) === "pret" ? "pret" : "recent";
    } catch (e) {
      montrer(e);
    }
    await tick();
    elNom?.focus();
  }

  // Geste « Confirmer avec une passkey » (cérémonie chargée à l'ouverture de la section).
  async function confirmer() {
    global = "";
    try {
      await confirmerParPasskey();
    } catch (e) {
      montrer(e);
      preparerReauth().catch(() => undefined);
      return;
    }
    preparerReauth().catch(() => undefined);
    if (aRetirer) {
      const id = aRetirer;
      aRetirer = null;
      return retirer(id);
    }
    try {
      ajout = (await preparerAjout()) === "pret" ? "pret" : "recent";
    } catch (e) {
      montrer(e);
    }
  }

  // Geste « Créer la passkey » : aucune requête avant navigator.credentials.create.
  async function creer() {
    global = "";
    try {
      if ((await ajouterPasskey(nom)) === "second") return void (ajout = "second");
    } catch (e) {
      montrer(e);
      if (!annulee(e) && codeDe(e) !== "passkeys_max") ajout = "ferme";
      else ajout = (await preparerAjout().catch(() => "recent")) === "pret" ? "pret" : "recent";
      return;
    }
    await ajoutee();
  }
  async function second() {
    try {
      await deuxiemeGesteAjout();
    } catch (e) {
      return montrer(e);
    }
    await ajoutee();
  }
  async function ajoutee() {
    ajout = "ferme";
    nom = "";
    ok = t("account.passkeys.added");
    announce(ok);
    await charger();
  }

  async function retirer(id: string) {
    global = ok = "";
    let prevenu: boolean;
    try {
      prevenu = await retirerPasskey(id);
    } catch (e) {
      if (codeDe(e) === "recent") {
        aRetirer = id;
        global = t("account.reauth.needed");
        return;
      }
      return montrer(e);
    }
    ok = prevenu ? t("account.passkeys.removed") : t("account.passkeys.removed.manual");
    announce(ok);
    await charger();
  }

  async function enregistrerNom(id: string) {
    global = "";
    try {
      await nommerPasskey(id, nouveauNom);
    } catch (e) {
      return montrer(e);
    }
    renomme = null;
    await charger();
  }
</script>

<Section id="sec-passkeys" titre={t("account.section.passkeys")}>
  {#if account.cleLocale}<p class="note" data-cle-locale>{t("account.localKey")}</p>{/if}
  {#if sansSync}<Banner kind="warn">{t("account.passkeys.nosync")}</Banner>{/if}
  {#if liste === null && !global}
    <p class="note" aria-busy="true">{t("account.passkeys.loading")}</p>
  {:else if liste}
    <ul class="pks">
      {#each liste as p (p.id)}
        <li class="ligne">
          <div class="lib">
            <span class="nom"><bdi>{nomDe(p)}</bdi>{#if p.courante}<span class="puce">{t("account.passkeys.this")}</span>{/if}</span>
            <span class="val">
              {t("account.passkeys.added.on", { mois: moisLong(p.ajoutee) })}{#if !p.synchronisable}{" · "}{t("account.passkeys.bound")}{/if}{#if p.ouvre}{" · "}{t("account.passkeys.opens")}{/if}
            </span>
            {#if renomme === p.id}
              <form class="form" novalidate onsubmit={(e) => e.preventDefault()}>
                <TextField label={t("account.passkeys.name")} maxlength={35} bind:value={nouveauNom} />
                <div class="actions">
                  <Button type="submit" dense onpress={() => enregistrerNom(p.id)}>{t("account.profile.save")}</Button>
                  <Button variant="ghost" dense onpress={() => void (renomme = null)}>{t("common.cancel")}</Button>
                </div>
              </form>
            {/if}
          </div>
          {#if renomme !== p.id}
            <div class="acts">
              <Button variant="ghost" dense aria-label={t("account.passkeys.renameName", { nom: nomDe(p) })} onpress={() => void ((renomme = p.id), (nouveauNom = p.nom ?? ""))}>{t("account.passkeys.rename")}</Button>
              {#if liste.length > 1}
                <InlineConfirm dense label={t("account.passkeys.remove")} triggerName={t("account.passkeys.removeName", { nom: nomDe(p) })} message={t("account.passkeys.remove.confirm")} confirmLabel={t("account.passkeys.remove")} kind="danger" onconfirm={() => retirer(p.id)} />
              {/if}
            </div>
          {/if}
        </li>
      {/each}
    </ul>
    {#if liste.length === 1}<p class="note">{t("account.passkeys.last")}</p>{/if}
  {/if}

  {#if aRetirer || ajout === "recent"}
    <p class="note">{t("account.reauth.needed")}</p>
    <div class="actions">
      <Button onpress={confirmer}>{t("account.reauth.go")}</Button>
      <Button variant="ghost" onpress={() => void ((ajout = "ferme"), (aRetirer = null), (global = ""))}>{t("common.cancel")}</Button>
    </div>
  {:else if ajout === "ferme"}
    <div class="actions"><Button variant="secondary" onpress={ouvrirAjout}>{t("account.passkeys.add")}</Button></div>
  {:else if ajout === "pret"}
    <form class="form" novalidate onsubmit={(e) => e.preventDefault()}>
      <TextField label={t("account.passkeys.name")} hint={t("account.passkeys.name.hint")} maxlength={35} bind:value={nom} bind:el={elNom} />
      <div class="actions">
        <Button type="submit" onpress={creer}>{t("account.passkeys.create")}</Button>
        <Button variant="ghost" onpress={() => void (ajout = "ferme")}>{t("common.cancel")}</Button>
      </div>
    </form>
  {:else}
    <p class="note">{t("account.second.body")}</p>
    <div class="actions"><Button onpress={second}>{t("account.second.go")}</Button></div>
  {/if}
  {#if ok}<p class="ok" role="status">{ok}</p>{/if}
  {#if global}<p class="err" role="alert">{global}</p>{/if}
</Section>

<style>
  .pks {
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
  .acts {
    display: flex;
    flex-wrap: wrap;
    gap: var(--sp-2);
  }
</style>
