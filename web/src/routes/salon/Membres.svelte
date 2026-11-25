<script lang="ts">
  // Participants (spec §39.5, v3 §14.1) : couleur, pseudonyme (jamais la couleur seule), « vous »,
  // créateur, en ligne ou dernière connexion (heure de cet appareil, à la minute), puis « Quitter
  // le salon ». Codes de vérification, exclusion (créateur) et réglages :.
  import { t, getLang } from "../../i18n/i18n.svelte";
  import { formatClock } from "../../i18n/format";
  import * as S from "../../salon/salon.svelte";
  import Gestion from "./Gestion.svelte";
  import InlineConfirm from "../../ui/InlineConfirm.svelte";

  const vue = S.vue;
  const conv = S.conversation()!;
  const lang = $derived(getLang());
  // Lignes recalculées à chaque changement du fil (conversation.ts n'est pas réactif lui-même).
  const lignes = $derived.by(() => {
    void vue.rev;
    void lang;
    return [...conv.presents].sort((a, b) => a - b).map((s) => ({ s, nom: nom(s), couleur: conv.couleur(s), enLigne: conv.presence.get(s)?.enLigne === true, vu: vu(s), avatar: conv.avatars.get(s) ? (S.masques.has(s) ? null : (S.pieces.urls[`avatar:${s}`] ?? null)) : null, aAvatar: !!conv.avatars.get(s), code: S.code(s), verifie: S.verifie(s) }));
  });

  // Avatars annoncés : relus du serveur et déchiffrés une fois (pièce de 64 Ko au plus, JPEG).
  $effect(() => {
    void vue.rev;
    for (const s of conv.presents) if (conv.avatars.get(s)) void S.avatarDe(s);
  });

  // Exclusion (spec §39.5, v3) : réservée au créateur, jamais sur lui-même.
  let exclusion = $state("");
  async function exclureMembre(siege: number, qui: string): Promise<void> {
    const e = await S.exclureSiege(siege);
    exclusion = e === null ? t("salon.exclure.fait", { nom: qui }) : t("salon.gestion.err.generique");
  }

  function nom(s: number): string {
    const n = conv.nom(s);
    return n.pseudo ?? t("salon.room.participant", { n: n.numero });
  }
  function vu(s: number): string {
    const p = conv.presence.get(s);
    if (p?.enLigne) return t("salon.room.seen.online");
    if (!p || p.derniereMin === 0) return t("salon.room.seen.offline");
    const ms = p.derniereMin * 60_000;
    const d = new Date(ms);
    const auj = new Date();
    const hier = new Date(auj.getFullYear(), auj.getMonth(), auj.getDate() - 1);
    const heure = formatClock(ms, lang);
    if (d.toDateString() === auj.toDateString()) return t("salon.room.seen.today", { heure });
    if (d.toDateString() === hier.toDateString()) return t("salon.room.seen.yesterday", { heure });
    const date = new Intl.DateTimeFormat(lang, { day: "numeric", month: "short" }).format(d);
    return t("salon.room.seen.date", { date, heure });
  }
</script>

<ul class="membres">
  {#each lignes as l (l.s)}
    <li class={`c${l.couleur}`}>
      <span class="pastille" aria-hidden="true">{#if l.avatar}<img src={l.avatar} alt="" />{:else}{[...l.nom][0]?.toLocaleUpperCase() ?? ""}{/if}{#if l.enLigne}<span class="point"></span>{/if}</span>
      <span class="qui">
        <span class="nom"><bdi>{l.nom}</bdi>{#if l.s === conv.moi}{" "}({t("salon.room.you")}){/if}{#if l.s === conv.createurSiege}{" · "}{t("salon.room.creator")}{/if}</span>
        <span class="vu">{l.vu}</span>
        {#if l.aAvatar && l.s !== conv.moi}<button type="button" class="masquer" aria-pressed={S.masques.has(l.s)} onclick={() => (S.masques.has(l.s) ? S.masques.delete(l.s) : S.masques.add(l.s))}>{t("salon.avatar.masquer")}</button>{/if}
        {#if vue.createur && l.s !== conv.moi}
          <InlineConfirm dense label={t("salon.exclure")} triggerName={t("salon.exclure.nom", { nom: l.nom })} message={t("salon.exclure.confirm", { nom: l.nom })} confirmLabel={t("salon.exclure")} kind="danger" triggerVariant="ghost" onconfirm={() => exclureMembre(l.s, l.nom)} />
        {/if}
        {#if l.code}
          <details class="code">
            <summary>{t("salon.code.voir", { nom: l.nom })}{#if l.verifie}{" · "}{t("salon.code.verifie")}{/if}</summary>
            <p class="chiffres" translate="no">{l.code}</p>
            {#if l.s !== conv.moi}
              <button type="button" class="masquer" aria-pressed={l.verifie} onclick={() => S.verifier(l.s, !l.verifie)}>{l.verifie ? t("salon.code.annuler") : t("salon.code.marquer")}</button>
            {/if}
          </details>
        {/if}
      </span>
    </li>
  {/each}
</ul>
{#if exclusion}<p class="note" role="status">{exclusion}</p>{/if}
{#if !vue.createur}
  <!-- Exigence C-3 32 : créateur revenu sans son lien de gestion (la page ne peut pas le savoir). -->
  <details class="code colle">
    <summary>{t("salon.colle.question")}</summary>
    <p class="note">{t("salon.colle.sans")}</p>
    <p class="note">{t("salon.colle.ou")}</p>
  </details>
{/if}
<section class="codes" aria-label={t("salon.code.titre")}>
  <p class="note">{t("salon.code.inciter")}</p>
  <p class="note">{t("salon.code.createur")}</p>
</section>
<Gestion />

<style>
  .membres {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: var(--sp-3);
    --p0: #5fe3b5;
    --p1: #7cc4ff;
    --p2: #b79cff;
    --p3: #ff8fc7;
    --p4: #ff9a7a;
    --p5: #f2c46d;
    --p6: #d8e86a;
    --p7: #4fd8e0;
    --p8: #e0a8f0;
    --p9: #d9c3a0;
  }
  /* Pastille alignée sur le nom (la fiche peut être haute : code, « Exclure »). */
  li {
    display: flex;
    align-items: flex-start;
    gap: var(--sp-3);
  }
  .c0 { --pc: var(--p0); }
  .c1 { --pc: var(--p1); }
  .c2 { --pc: var(--p2); }
  .c3 { --pc: var(--p3); }
  .c4 { --pc: var(--p4); }
  .c5 { --pc: var(--p5); }
  .c6 { --pc: var(--p6); }
  .c7 { --pc: var(--p7); }
  .c8 { --pc: var(--p8); }
  .c9 { --pc: var(--p9); }
  .pastille {
    position: relative;
    display: inline-grid;
    place-items: center;
    flex: none;
    width: 40px;
    height: 40px;
    border-radius: 50%;
    background: var(--pc);
    color: var(--on-fmt);
    font-weight: 700;
  }
  /* Zones tactiles de 44 px. */
  .code summary {
    min-height: 44px;
    padding-block: 12px;
    box-sizing: border-box;
    color: var(--text-2);
    font-size: 0.8125rem;
    cursor: pointer;
  }
  .chiffres {
    margin: var(--sp-1) 0;
    font-family: var(--font-mono, monospace);
    font-variant-numeric: tabular-nums;
    letter-spacing: 0.04em;
  }
  .codes {
    margin-top: var(--sp-4);
    display: grid;
    gap: var(--sp-2);
  }
  .note {
    margin: 0;
    color: var(--text-2);
    font-size: 0.875rem;
  }
  .pastille img {
    width: 100%;
    height: 100%;
    border-radius: 50%;
    object-fit: cover;
  }
  .masquer {
    justify-self: start;
    min-height: 44px;
    padding: 0;
    border: 0;
    background: transparent;
    color: var(--text-2);
    font: inherit;
    font-size: 0.8125rem;
    text-decoration: underline;
    cursor: pointer;
  }
  .masquer[aria-pressed="true"] {
    color: var(--accent);
  }
  .point {
    position: absolute;
    right: -1px;
    bottom: -1px;
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: var(--accent);
    border: 2px solid var(--bg);
  }
  .qui {
    display: grid;
    justify-items: start;
    min-width: 0;
  }
  /* « Exclure » : action qui retire quelqu'un, en corail, alignée sur le texte de la fiche. */
  .qui :global(.btn.ghost) {
    margin-inline-start: -14px;
    color: var(--danger);
  }
  .nom {
    font-weight: 600;
    overflow-wrap: anywhere;
  }
  .vu {
    color: var(--text-2);
    font-size: 0.8125rem;
  }
  .quitter {
    margin-top: var(--sp-5);
  }
</style>
