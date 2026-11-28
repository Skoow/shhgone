<script lang="ts">
  // Pseudo du compte (conception compte §21.5, §21.15.2 ; création de compte et page Compte).
  // Liste de règles à cocher, mise à jour à chaque frappe (28 novembre, décision du propriétaire) :
  // caractères permis et longueur (ui/regles-pseudo.ts, mêmes règles que le moteur), puis
  // « Disponible » (vérifiée par `verifier` 400 ms après la dernière frappe, seulement quand les
  // deux premières sont tenues : aucune requête pour un pseudo déjà refusé ici), et en
  // information non bloquante « 3 changements par an au plus ». Chaque règle a sa coche verte ou
  // sa croix rouge ET son état dit en texte (lecteurs d'écran) ; avant toute frappe, rien n'est
  // coché ni barré.
  // Dans le champ, à droite, un petit carré : coche blanche sur fond vert quand le pseudo est
  // valide et libre, rond qui tourne pendant la vérification, croix rouge s'il est pris ou
  // invalide. Décoratif : l'état passe par aria-invalid, les règles (aria-describedby), l'erreur
  // (role="alert") et une région polie qui dit seulement « Disponible ».
  // Réponses de `verifier` : « libre », « actuel » (pseudo actuel du compte : rien à changer),
  // « pris », « plus_tard » (pas encore d'étape : rien n'est affirmé), un code pseudo_* (message
  // de §39.4) ou « erreur » (rien d'affirmé). Une réponse d'une frappe précédente est ignorée.
  // `error` (venu de l'écran, ex. pseudo_pris à la fin) l'emporte. `relance` : changer sa valeur
  // refait la vérification (étape prête après la frappe).
  import { untrack } from "svelte";
  import { PSEUDO_MAX, PSEUDO_MIN, reglesPseudo } from "./regles-pseudo";
  import { t } from "../i18n/i18n.svelte";
  import { Check, Info, X } from "./Icon";

  type Props = {
    value?: string;
    verifier: (p: string) => Promise<string>;
    error?: string;
    /** État courant, pour l'écran (bouton d'envoi). */
    onstatut?: (s: string) => void;
    /** Chaque frappe (l'écran efface alors une erreur venue du serveur). */
    onsaisie?: () => void;
    el?: HTMLInputElement | undefined;
    relance?: number;
    autocomplete?: "nickname" | "username";
  };
  let { value = $bindable(""), verifier, error, onstatut, onsaisie, el = $bindable(), relance = 0, autocomplete = "nickname" }: Props = $props();
  const uid = $props.id();

  // Erreurs dites en phrase sous le champ ; longueur et caractères sont dits par la liste.
  const MESSAGES: Record<string, Parameters<typeof t>[0]> = {
    pris: "account.pseudo.taken",
    pseudo_ecritures: "account.err.pseudoEcritures",
    pseudo_reserve: "account.err.pseudoReserve",
  };
  // "", "regles" (règles locales non tenues), "verif", "libre", "actuel", "plus_tard", "erreur",
  // ou un code (pris, pseudo_*).
  let statut = $state("");
  let seq = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  $effect(() => () => clearTimeout(timer));

  const regles = $derived(reglesPseudo(value));
  const vide = $derived(value.trim() === "");
  const reglesOk = $derived(regles.caracteres && regles.longueur);
  const mine = $derived(MESSAGES[statut] ? t(MESSAGES[statut]!) : "");
  const shown = $derived(error ?? mine);
  const libre = $derived(statut === "libre" || statut === "actuel");
  /** Refus : règle non tenue (après la frappe), pseudo pris ou refusé par le moteur, erreur de l'écran. */
  const refus = $derived(!!shown || (!vide && !reglesOk) || statut.startsWith("pseudo_"));
  const carre = $derived(vide && !shown ? "vide" : refus ? "ko" : statut === "verif" ? "verif" : libre ? "ok" : "attente");
  const describedBy = $derived([`${uid}-regles`, shown ? `${uid}-err` : ""].filter(Boolean).join(" "));

  type Marque = "ok" | "ko" | "neutre" | "verif";
  const marque = (tenue: boolean): Marque => (vide ? "neutre" : tenue ? "ok" : "ko");
  const dispo = $derived<Marque>(statut === "verif" ? "verif" : libre ? "ok" : statut === "pris" || statut === "pseudo_reserve" || statut === "pseudo_ecritures" ? "ko" : "neutre");
  const ETAT_REGLE: Record<Marque, Parameters<typeof t>[0]> = { ok: "account.pseudo.rule.ok", ko: "account.pseudo.rule.ko", neutre: "account.pseudo.rule.wait", verif: "account.pseudo.rule.checking" };

  function poser(s: string) {
    statut = s;
    onstatut?.(s);
  }
  function oninput(e: Event) {
    value = (e.currentTarget as HTMLInputElement).value;
    onsaisie?.();
    planifier();
  }
  // Champ monté déjà rempli (étape suivante d'un écran), ou relance demandée : vérifié lui aussi.
  $effect(() => {
    void relance;
    untrack(() => void (value.trim() !== "" && planifier()));
  });
  function planifier() {
    const n = ++seq;
    clearTimeout(timer);
    if (value.trim() === "") return poser("");
    if (!reglesPseudo(value).caracteres || !reglesPseudo(value).longueur) return poser("regles");
    poser("verif");
    const v = value;
    timer = setTimeout(async () => {
      let r: string;
      try {
        r = await verifier(v);
      } catch {
        r = "erreur";
      }
      if (n === seq) poser(r);
    }, 400);
  }
</script>

<div class="field">
  <label for={uid}>{t("account.pseudo")}</label>
  <div class="box">
    <input
      bind:this={el}
      {value}
      {oninput}
      id={uid}
      type="text"
      {autocomplete}
      autocapitalize="off"
      spellcheck="false"
      maxlength={64}
      class={["input", { invalid: refus }]}
      aria-invalid={refus ? "true" : undefined}
      aria-describedby={describedBy}
    />
    <span class={["carre", carre]} aria-hidden="true" data-field-status={carre}>
      {#if carre === "verif"}<span class="spin"></span>{:else if carre === "ok"}<Check size={16} strokeWidth={2.8} />{:else if carre === "ko"}<X size={16} strokeWidth={2.6} />{/if}
    </span>
  </div>
  {#if shown}<p id="{uid}-err" class="err" role="alert">{shown}</p>{/if}
  <!-- Région polie, sobre : elle ne dit que « Disponible » (ou « vérifié plus tard »). -->
  <p class="sr-only" role="status" data-dispo data-pseudo-status>{libre && !shown ? t("account.pseudo.free") : statut === "plus_tard" ? t("account.pseudo.later") : ""}</p>
  <ul id="{uid}-regles" class="regles" aria-label={t("account.pseudo.rules")} data-pseudo-regles>
    {@render regle(marque(regles.caracteres), t("account.pseudo.rule.chars"), "caracteres")}
    {@render regle(marque(regles.longueur), t("account.pseudo.rule.length", { min: PSEUDO_MIN, max: PSEUDO_MAX }), "longueur")}
    {@render regle(dispo, statut === "plus_tard" ? t("account.pseudo.later") : statut === "actuel" ? t("account.pseudo.rule.current") : t("account.pseudo.rule.free"), "disponible")}
    <li class="info" data-regle="info">
      <span class="ic" aria-hidden="true"><Info size={14} strokeWidth={2} /></span>
      <span>{t("account.pseudo.rule.info")}</span>
    </li>
  </ul>
</div>

{#snippet regle(m: Marque, texte: string, id: string)}
  <li class={["r", m]} data-regle={id} data-etat={m}>
    <span class="ic" aria-hidden="true">
      {#if m === "ok"}<Check size={14} strokeWidth={2.8} />{:else if m === "ko"}<X size={14} strokeWidth={2.6} />{:else if m === "verif"}<span class="spin petit"></span>{/if}
    </span>
    <span>{texte}<span class="sr-only">{` : ${t(ETAT_REGLE[m])}`}</span></span>
  </li>
{/snippet}

<style>
  .field {
    display: grid;
    gap: var(--sp-2);
  }
  label {
    font-size: var(--fs-small);
    line-height: var(--lh-small);
    font-weight: 600;
    color: var(--text-2);
  }
  .box {
    position: relative;
    display: grid;
  }
  .input {
    width: 100%;
    min-height: 48px;
    padding: 0 52px 0 var(--sp-4);
    border: 1px solid var(--line-strong);
    border-radius: var(--r-md);
    background: var(--surface-1);
    color: var(--text);
    font: inherit;
    font-size: max(1rem, 16px); /* jamais sous 16 px : iOS zoomerait au focus */
  }
  .input:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  .input.invalid {
    border-color: var(--danger);
  }
  /* Le petit carré dans le champ. */
  .carre {
    position: absolute;
    inset-block: 0;
    inset-inline-end: 12px;
    margin-block: auto;
    display: grid;
    place-items: center;
    width: 26px;
    height: 26px;
    border-radius: 7px;
    pointer-events: none;
    box-shadow: inset 0 0 0 1.5px var(--line-strong);
    color: var(--text-3);
    transition:
      background-color var(--dur-fast, 120ms) var(--ease-out, ease-out),
      box-shadow var(--dur-fast, 120ms) var(--ease-out, ease-out);
  }
  .carre.ok {
    background: var(--accent);
    box-shadow: none;
    color: var(--bg, #0b0d12);
  }
  .carre.ko {
    background: var(--danger-tint);
    box-shadow: inset 0 0 0 1.5px var(--danger);
    color: var(--danger);
  }
  .carre.verif {
    box-shadow: none;
  }
  .spin {
    width: 16px;
    height: 16px;
    border: 2px solid currentColor;
    border-right-color: transparent;
    border-radius: 50%;
    animation: pf-spin 0.8s linear infinite;
  }
  .spin.petit {
    width: 11px;
    height: 11px;
    border-width: 1.5px;
  }
  @keyframes pf-spin {
    to {
      transform: rotate(360deg);
    }
  }
  .err {
    margin: 0;
    font-size: var(--fs-small);
    line-height: var(--lh-small);
    color: var(--danger);
  }
  .regles {
    display: grid;
    gap: 6px;
    margin: 0;
    padding: 0;
    list-style: none;
    font-size: var(--fs-small);
    line-height: var(--lh-small);
    color: var(--text-2);
  }
  .regles li {
    display: flex;
    align-items: flex-start;
    gap: var(--sp-2);
  }
  .ic {
    flex: none;
    display: grid;
    place-items: center;
    width: 18px;
    height: 18px;
    margin-top: 1px;
    border-radius: 50%;
    box-shadow: inset 0 0 0 1.5px var(--line-strong);
    color: var(--text-3);
  }
  .r.ok .ic {
    background: var(--accent);
    box-shadow: none;
    color: var(--bg, #0b0d12);
  }
  .r.ok {
    color: var(--text);
  }
  .r.ko .ic {
    background: var(--danger-tint);
    box-shadow: inset 0 0 0 1.5px var(--danger);
    color: var(--danger);
  }
  .r.ko {
    color: var(--danger);
  }
  .r.verif .ic {
    box-shadow: none;
  }
  .info {
    color: var(--text-3);
  }
  .info .ic {
    box-shadow: none;
  }
  @media (prefers-reduced-motion: reduce) {
    .spin {
      animation: none;
    }
    .carre {
      transition: none;
    }
  }
  @media (forced-colors: active) {
    .carre,
    .ic {
      border: 1px solid CanvasText;
    }
  }
</style>
