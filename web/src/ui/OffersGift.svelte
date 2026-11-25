<script lang="ts">
  // Accès offert (/offres/offert#<pass>, conception du paiement, « Accès offerts ») : lien donné
  // par l'exploitant depuis son tableau de bord. Le pass P suit « # » : jamais envoyé au serveur
  // par le navigateur. Il est lu une fois, à l'initialisation du composant (avant tout effet, donc
  // avant que l'application retire le « # »), puis effacé aussitôt de l'adresse et de
  // l'historique ; vérifié chez le serveur (POST /api/paiement/etat, en-tête du pass posé par
  // paiement/api.ts, comme la page de retour de paiement) ; rangé sur l'appareil comme un pass payé (paiement/pass.ts), puis
  // dans le coffre privé du compte : tout de suite si une session est ouverte, sinon à la prochaine
  // connexion ou création de compte (account/session.svelte.ts, synchroniser). Un autre appareil
  // connecté au même compte le retrouve depuis le coffre, sans repasser par le lien.
  import { href } from "../app/router.svelte";
  import { unb64u, b64u } from "../engine/pure";
  import { getLang, t } from "../i18n/i18n.svelte";
  import { lireEtat, type EtatPaiement } from "../paiement/api";
  import { garder, idbDuNavigateur, lirePasses, nouvelId } from "../paiement/pass";

  /** Compte (App.svelte, seulement avec __COMPTES__) : session ouverte, et rangement du pass dans le coffre. */
  export type CompteOffert = { connecte: () => boolean; ranger: () => Promise<boolean> };
  let { net, compte }: { net?: Parameters<typeof lireEtat>[1]; compte?: CompteOffert } = $props();

  /** Pass du fragment (32 octets, base64url canonique sans bourrage), ou null. */
  function lirePassDuFragment(): Uint8Array<ArrayBuffer> | null {
    if (typeof location === "undefined") return null;
    const h = location.hash;
    // Effacé tout de suite, quoi qu'il contienne : ni l'adresse ni l'historique ne le gardent.
    if (h !== "") history.replaceState(history.state, "", location.pathname);
    if (!/^#[A-Za-z0-9_-]{43}$/.test(h)) return null;
    try {
      const p = unb64u(h.slice(1)) as Uint8Array<ArrayBuffer>;
      // Forme canonique seulement (le serveur refuse les autres) : derniers bits nuls.
      if (p.length !== 32 || b64u(p) !== h.slice(1)) return null;
      return p;
    } catch {
      return null;
    }
  }

  const pass = lirePassDuFragment();
  const lang = $derived(getLang());
  type Vue = "lecture" | "invalide" | "reseau" | "revoque" | "echu" | "ok" | "stockage";
  let vue = $state<Vue>(pass === null ? "invalide" : "lecture");
  let e = $state<EtatPaiement | null>(null);
  let range = $state(false); // rangé sur l'appareil
  let dansCompte = $state<"rien" | "ajoute" | "erreur">("rien");

  const aujourdhui = () => new Date().toISOString().slice(0, 10);
  const meme = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

  async function verifier(): Promise<void> {
    if (pass === null) return;
    vue = "lecture";
    const r = await lireEtat(pass, net);
    if (r === null) {
      vue = "reseau";
      return;
    }
    e = r;
    if (r.etat === "revoquee") vue = "revoque";
    else if (r.etat !== "payee" || r.offre === null || r.fin === null) vue = "invalide";
    else if (r.fin <= aujourdhui()) vue = "echu";
    else {
      const idb = idbDuNavigateur();
      if (idb === null) {
        vue = "stockage";
        return;
      }
      try {
        // Déjà rangé (lien rouvert) : rien en double.
        if (!(await lirePasses(idb)).some((g) => meme(g.pass, pass))) {
          await garder(idb, { id: nouvelId(), pass, offre: r.offre, jours: 365, renouvelle: false, moyen: "offert", enAttente: false, cree: Date.now() });
        }
        range = true;
        vue = "ok";
      } catch {
        vue = "stockage";
      }
    }
  }

  $effect(() => {
    void verifier();
  });

  // Compte ouvert (tout de suite, ou une fois « Rester connecté » relu au démarrage) : le pass
  // part dans le coffre privé. Sans compte : à la prochaine connexion ou inscription.
  $effect(() => {
    if (!range || !compte?.connecte() || dansCompte !== "rien") return;
    void compte.ranger().then(
      (ok) => {
        if (ok) dansCompte = "ajoute";
      },
      () => (dansCompte = "erreur"),
    );
  });

  /** Dernier jour valable (fin exclue) en toutes lettres. */
  const jusqua = (fin: string) =>
    new Intl.DateTimeFormat(lang, { dateStyle: "long", timeZone: "UTC" }).format(new Date(Date.parse(fin + "T00:00:00Z") - 86400000));
</script>

<section class="gift" aria-live="polite" data-gift={vue}>
  {#if vue === "lecture"}
    <p class="body">…</p>
  {:else if vue === "ok" && e?.fin}
    <h2>{t("offers.gift.ok", { date: jusqua(e.fin) })}</h2>
    <p class="body">{t("offers.gift.ok.body")}</p>
    {#if dansCompte === "ajoute"}
      <p class="body done" data-account="ajoute">{t("offers.gift.account.added")}</p>
    {:else if dansCompte === "erreur"}
      <p class="err" role="alert" data-account="erreur">{t("offers.gift.account.err")}</p>
    {:else if compte && !compte.connecte()}
      <p class="body" data-account="aucun">{t("offers.gift.account.none")}</p>
      <p class="links">
        <a class="act" href={href("/compte/connexion")} data-signin>{t("offers.gift.signin")}</a>
        <a class="act" href={href("/compte/inscription")} data-signup>{t("offers.gift.signup")}</a>
      </p>
    {:else if !compte}
      <p class="body">{t("offers.gift.device")}</p>
    {/if}
    <p class="body">{t("offers.ret.use", { tier: t("paid.badge.pro") })}</p>
  {:else if vue === "revoque"}
    <h2>{t("offers.gift.revoked")}</h2>
    <p class="body">{t("offers.gift.revoked.body")}</p>
  {:else if vue === "echu"}
    <h2>{t("offers.gift.expired")}</h2>
    <p class="body">{t("offers.gift.expired.body")}</p>
  {:else if vue === "reseau"}
    <h2>{t("offers.gift.network")}</h2>
    <p class="body">{t("offers.gift.network.body")}</p>
    <button type="button" class="act" onclick={verifier} data-retry>{t("offers.gift.retry")}</button>
  {:else if vue === "stockage"}
    <h2>{t("offers.gift.storage")}</h2>
    <p class="body">{t("offers.gift.storage.body")}</p>
  {:else}
    <h2>{t("offers.gift.invalid")}</h2>
    <p class="body">{t("offers.gift.invalid.body")}</p>
  {/if}
  <p class="links">
    <a href={href("/offres")} data-back>{t("offers.ret.back")}</a>
  </p>
</section>

<style>
  .gift {
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
  .done {
    color: var(--text);
  }
  .err {
    margin: 0;
    color: var(--danger);
  }
  .links {
    display: flex;
    flex-wrap: wrap;
    gap: var(--sp-3) var(--sp-4);
    align-items: center;
    margin: 0;
  }
  .links a:not(.act) {
    color: var(--accent);
  }
  .act {
    display: inline-flex;
    align-items: center;
    min-height: 44px;
    padding: 0 var(--sp-4);
    border: 0;
    border-radius: var(--r-pill);
    background: var(--surface-3);
    color: var(--text);
    font: inherit;
    font-weight: 600;
    text-decoration: none;
    cursor: pointer;
    justify-self: start;
  }
  .act:focus-visible,
  .links a:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
</style>
