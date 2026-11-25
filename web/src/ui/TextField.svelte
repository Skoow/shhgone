<script lang="ts">
  import type { HTMLInputAttributes } from "svelte/elements";
  import { Check, X } from "./Icon";

  type Props = Omit<HTMLInputAttributes, "value" | "class" | "id" | "aria-describedby" | "aria-invalid"> & {
    label: string;
    value?: string;
    hint?: string;
    /** Message d'erreur : relié au champ par aria-describedby, champ marqué invalide. */
    error?: string;
    /** Étiquette lue par les lecteurs d'écran seulement (le contexte visuel la remplace). */
    labelHidden?: boolean;
    el?: HTMLInputElement | undefined;
    /** Petite icône dans le champ, à droite : vérification en cours (rond qui tourne), valeur
     *  acceptée (coche verte) ou refusée (croix rouge). Décorative : la raison passe par `error`
     *  et par la région annoncée de l'écran. */
    status?: "verif" | "ok" | "ko";
  };
  let { label, value = $bindable(""), hint, error, labelHidden = false, el = $bindable(), status, ...rest }: Props = $props();

  const uid = $props.id();
  const describedBy = $derived([hint ? `${uid}-hint` : "", error ? `${uid}-err` : ""].filter(Boolean).join(" ") || undefined);
</script>

<div class="field">
  <label for={uid} class={{ "sr-only": labelHidden }}>{label}</label>
  <div class="box">
    <input
      bind:this={el}
      bind:value
      {...rest}
      id={uid}
      class={["input", { invalid: !!error, "with-st": !!status }]}
      aria-invalid={error ? "true" : undefined}
      aria-describedby={describedBy}
    />
    {#if status}
      <span class="st {status}" aria-hidden="true" data-field-status={status}>
        {#if status === "verif"}<span class="spin"></span>{:else if status === "ok"}<Check size={18} strokeWidth={2.4} />{:else}<X size={18} strokeWidth={2.4} />{/if}
      </span>
    {/if}
  </div>
  {#if hint}<p id="{uid}-hint" class="hint">{hint}</p>{/if}
  {#if error}<p id="{uid}-err" class="err" role="alert">{error}</p>{/if}
</div>

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
  .input {
    width: 100%;
    min-height: 48px;
    padding: 0 var(--sp-4);
    border: 1px solid var(--line-strong);
    border-radius: var(--r-md);
    background: var(--surface-1);
    color: var(--text);
    font: inherit;
    font-size: max(1rem, 16px); /* jamais sous 16 px : iOS zoomerait au focus */
  }
  .box {
    position: relative;
    display: grid;
  }
  /* Place réservée à droite pour l'icône d'état. */
  .input.with-st {
    padding-inline-end: 44px;
  }
  .st {
    position: absolute;
    inset-block: 0;
    inset-inline-end: 14px;
    display: grid;
    place-items: center;
    pointer-events: none;
  }
  .st.ok {
    color: var(--accent);
  }
  .st.ko {
    color: var(--danger);
  }
  .st.verif {
    color: var(--text-3);
  }
  .spin {
    width: 16px;
    height: 16px;
    border: 2px solid currentColor;
    border-right-color: transparent;
    border-radius: 50%;
    animation: tf-spin 0.8s linear infinite;
  }
  @keyframes tf-spin {
    to {
      transform: rotate(360deg);
    }
  }
  /* Mouvement réduit : le rond reste immobile. */
  @media (prefers-reduced-motion: reduce) {
    .spin {
      animation: none;
    }
  }
  .input::placeholder {
    color: var(--text-3);
  }
  .input:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  .input.invalid {
    border-color: var(--danger);
  }
  .input[readonly] {
    color: var(--text-2);
    background: rgb(255 255 255 / 0.02);
    cursor: default;
  }
  .input:disabled {
    color: var(--text-disabled);
    background: var(--surface-2);
  }
  .hint,
  .err {
    margin: 0;
    font-size: var(--fs-small);
    line-height: var(--lh-small);
  }
  .hint {
    color: var(--text-3);
  }
  .err {
    color: var(--danger);
  }
</style>
