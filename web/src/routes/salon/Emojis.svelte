<script lang="ts">
  // Sélecteur d'émojis (spec §39.5) : la liste du moteur (Unicode émoji 15.0, séquences
  // « fully-qualified », emojis.gen.ts), 9 groupes, rendus par la police du système (aucune image
  // téléchargée), teinte de peau par modificateur, « récents » en mémoire de la page seulement.
  // Échap ferme et rend le focus au champ.
  import { t, type Key } from "../../i18n/i18n.svelte";
  import { GROUPES, TEINTABLES } from "../../salon/emojis.gen";

  type Props = { onpick: (e: string) => void; onclose: () => void };
  let { onpick, onclose }: Props = $props();

  const TONS = [0, 0x1f3fb, 0x1f3fc, 0x1f3fd, 0x1f3fe, 0x1f3ff] as const;
  let groupe = $state(0);
  let ton = $state(0);
  const decalage = GROUPES.map((_, i) => GROUPES.slice(0, i).reduce((a, g) => a + g.e.length, 0));

  function teinter(e: string, idx: number): string {
    if (ton === 0 || !TEINTABLES.has(idx)) return e;
    const cps = [...e].map((c) => c.codePointAt(0)!);
    const reste = cps.slice(1);
    if (reste[0] === 0xfe0f) reste.shift();
    return String.fromCodePoint(cps[0]!, TONS[ton]!, ...reste);
  }
  const NOMS = ["smileys", "people", "animals", "food", "travel", "activities", "objects", "symbols", "flags"] as const;
</script>

<div class="picker" role="dialog" aria-label={t("salon.room.emoji")} tabindex="-1" onkeydown={(e) => e.key === "Escape" && (e.stopPropagation(), onclose())}>
  <div class="groupes" role="tablist" aria-label={t("salon.room.emoji")}>
    {#each GROUPES as g, i (g.nom)}
      <button type="button" role="tab" aria-selected={groupe === i} aria-label={t(`salon.emoji.${NOMS[i]!}`)} onclick={() => (groupe = i)}>{g.e[0]}</button>
    {/each}
  </div>
  <div class="tons" role="radiogroup" aria-label={t("salon.emoji.tone")}>
    {#each TONS as _, i (i)}
      <button type="button" role="radio" aria-checked={ton === i} aria-label={t(`salon.emoji.tone.${i}` as Key)} class={`t${i}`} onclick={() => (ton = i)}></button>
    {/each}
  </div>
  <div class="grille" role="tabpanel">
    {#each GROUPES[groupe]!.e as e, j (e)}
      {@const x = teinter(e, decalage[groupe]! + j)}
      <button type="button" aria-label={x} onclick={() => onpick(x)}>{x}</button>
    {/each}
  </div>
</div>

<style>
  .picker {
    display: grid;
    gap: var(--sp-2);
    padding: var(--sp-2);
    border: 1px solid var(--line);
    border-radius: 14px;
    background: var(--surface-1);
  }
  .groupes,
  .tons {
    display: flex;
    flex-wrap: wrap;
    gap: var(--sp-1);
  }
  /* Zones tactiles de 44 px ; le dessin des teintes reste un disque
     de 28 px, au centre d'un bouton de 44 px. */
  .groupes button {
    min-width: 44px;
    min-height: 44px;
    border: 1px solid transparent;
    border-radius: 10px;
    background: transparent;
    font-size: 1.25rem;
    cursor: pointer;
  }
  .groupes button[aria-selected="true"] {
    border-color: var(--accent);
    background: var(--surface-2);
  }
  .tons {
    gap: 0;
  }
  .tons button {
    display: grid;
    place-items: center;
    width: 44px;
    height: 44px;
    padding: 0;
    border: 0;
    border-radius: 50%;
    background: transparent;
    cursor: pointer;
  }
  .tons button::before {
    content: "";
    box-sizing: border-box;
    width: 28px;
    height: 28px;
    border: 2px solid var(--line);
    border-radius: 50%;
    background: var(--ton);
  }
  .tons button[aria-checked="true"]::before {
    border-color: var(--accent);
  }
  .t0 { --ton: #f2c46d; }
  .t1 { --ton: #f7dcc4; }
  .t2 { --ton: #e5b896; }
  .t3 { --ton: #c68e64; }
  .t4 { --ton: #8d5a3b; }
  .t5 { --ton: #5a3825; }
  .grille {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(44px, 1fr));
    max-height: 14rem;
    overflow-y: auto;
  }
  .grille button {
    min-height: 44px;
    border: 0;
    border-radius: 10px;
    background: transparent;
    font-size: 1.5rem;
    cursor: pointer;
  }
  .grille button:hover,
  .grille button:focus-visible,
  .groupes button:focus-visible,
  .tons button:focus-visible {
    background: var(--surface-2);
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
  @media (forced-colors: active) {
    .tons button {
      forced-color-adjust: none;
    }
  }
</style>
