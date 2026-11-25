<script lang="ts">
  // Page d'information (Sécurité, avec sa section « Vérifier cette version », Confidentialité,
  // Conditions, Mentions légales, Signaler un abus, Contact) : lecture d'abord, colonne de texte de 70 à 80 signes par ligne, titres
  // ancrés par id (sans « # » dans l'adresse : le « # » est réservé aux clés). Bandeau « En cours de rédaction »
  // pour les pages juridiques que doit compléter.
  // Refonte (« ancien, trop serré, pavé ») : plus de carte ni de
  // cadre ; un grand en-tête sur le fond du site, fermé par une couture en demi-teinte ; sur
  // ordinateur, le sommaire reste à gauche pendant la lecture et suit la section lue ; sur
  // téléphone, il devient une rangée de pastilles. Sections espacées, texte plus grand.
  import { followLink, href } from "../app/router.svelte";
  import { getLang, t } from "../i18n/i18n.svelte";
  import { announce } from "../ui/announce";
  import { copyText } from "../ui/clipboard";
  import { Check, Copy } from "../ui/Icon";
  import PageHeader from "../ui/PageHeader.svelte";
  import { CONTACT_EMAIL, infoPage, type InfoName } from "./pages/content";

  /** `section` : id d'une section ouverte au chargement (« /verifier » : la section de Sécurité). */
  let { name, section }: { name: InfoName; section?: string } = $props();
  const page = $derived(infoPage(name, getLang()));
  const idOf = (b: { id?: string }, i: number) => b.id ?? `info-b-${i}`;
  let current = $state("");

  function go(id: string, smooth = true) {
    const el = document.getElementById(id);
    if (!el) return;
    el.scrollIntoView({ behavior: smooth && !matchMedia("(prefers-reduced-motion: reduce)").matches ? "smooth" : "auto", block: "start" });
    el.querySelector<HTMLElement>("h2")?.focus({ preventScroll: true });
    current = id;
  }

  // Ouverture à une section (« /verifier ») : une fois la page en place, sans animation.
  $effect(() => {
    if (section === undefined) return;
    const id = section;
    const raf = requestAnimationFrame(() => go(id, false));
    return () => cancelAnimationFrame(raf);
  });

  // Lien vers une section de la même page : défilement, sans changer d'adresse ; un clic modifié
  // (nouvel onglet) suit l'adresse, qui ouvre la page à cette section.
  function toSection(e: MouseEvent, id: string) {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    go(id);
  }

  // Page Contact : « Copier l'adresse ». Sans presse-papiers : l'adresse est sélectionnée, pour une
  // copie à la main.
  let copied = $state(false);
  let addr: HTMLAnchorElement | undefined = $state();
  let timer: ReturnType<typeof setTimeout> | undefined;
  $effect(() => () => clearTimeout(timer));
  async function copyMail() {
    clearTimeout(timer);
    if ((await copyText(CONTACT_EMAIL)) === "copied") {
      copied = true;
      announce(t("info.mail.copied"));
      timer = setTimeout(() => (copied = false), 2000);
      return;
    }
    copied = false;
    const sel = getSelection();
    if (addr && sel) {
      sel.selectAllChildren(addr);
      announce(t("copy.manual"));
    }
  }

  // Section lue : la dernière dont le titre a passé le haut de l'écran (sous l'en-tête du site).
  function follow(node: HTMLElement) {
    if (typeof IntersectionObserver === "undefined") return;
    const seen = new Map<string, boolean>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) seen.set(e.target.id, e.isIntersecting);
        const first = [...node.querySelectorAll<HTMLElement>(".blk")].find((s) => seen.get(s.id));
        if (first) current = first.id;
      },
      { rootMargin: "-96px 0px -55% 0px" },
    );
    for (const s of node.querySelectorAll<HTMLElement>(".blk")) io.observe(s);
    return () => io.disconnect();
  }
</script>

{#snippet content(b: { p?: string[]; list?: string[]; code?: string[]; after?: string[] })}
  {#each b.p ?? [] as para, j (j)}<p>{para}</p>{/each}
  {#if b.list}
    <ul>{#each b.list as li, j (j)}<li>{li}</li>{/each}</ul>
  {/if}
  <!-- Commandes à recopier (section « Vérifier cette version », spec §28.4) : texte seul, jamais
       exécuté. Le bloc défile en largeur : il doit pouvoir prendre le focus au clavier
       (règle « scrollable-region-focusable » d'axe), d'où tabindex. -->
  {#if b.code}
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <pre class="cmd" tabindex="0" aria-label={t("info.commands")} data-cmd><code>{b.code.join("\n")}</code></pre>
  {/if}
  {#each b.after ?? [] as para, j (j)}<p>{para}</p>{/each}
{/snippet}

<article class="info" data-info={name} aria-labelledby="info-title">
  <PageHeader id="info-title" size="display" title={page.title} lede={page.lede}>
    {#if page.draft}<p class="draft" role="note" data-draft>{t("info.draft")}</p>{/if}
  </PageHeader>

  <div class={["body", { solo: page.blocks.length <= 2 }]}>
    {#if page.blocks.length > 2}
      <nav class="toc" aria-label={t("info.toc")}>
        <p class="toc-h">{t("info.toc")}</p>
        <ol>
          {#each page.blocks as b, i (i)}
            <li><button type="button" aria-current={current === idOf(b, i) ? "true" : undefined} onclick={() => go(idOf(b, i))}>{b.h}</button></li>
          {/each}
        </ol>
      </nav>
    {/if}
    <div class="text" {@attach follow}>
      {#each page.blocks as b, i (i)}
        <section class="blk" id={idOf(b, i)} aria-labelledby="info-h-{i}">
          <h2 id="info-h-{i}" tabindex="-1">{b.h}</h2>
          {#if b.mail}
            <!-- Page Contact : l'adresse, en lien mailto (rien n'est envoyé par le site), et sa copie. -->
            <div class="mail" data-mail>
              <span class="sr-only">{t("info.mail")}</span>
              <a class="addr" href="mailto:{CONTACT_EMAIL}" bind:this={addr} translate="no">{CONTACT_EMAIL}</a>
              <button type="button" class="copy" onclick={copyMail} data-copy-mail>
                {#if copied}<Check size={18} strokeWidth={1.75} aria-hidden="true" />{t("info.mail.copied")}{:else}<Copy size={18} strokeWidth={1.75} aria-hidden="true" />{t("info.mail.copy")}{/if}
              </button>
            </div>
          {/if}
          {@render content(b)}
          {#each b.sub ?? [] as s (s.id)}
            <div class="sub" data-sub={s.id}>
              <h3>{s.h}</h3>
              {@render content(s)}
            </div>
          {/each}
          {#if b.link}
            {@const l = b.link}
            {@const target = l.section}
            <p>
              {#if target !== undefined}
                <a class="more" href={href(l.path)} onclick={(e) => toSection(e, target)}>{l.label}</a>
              {:else}
                <a class="more" href={href(l.path)} onclick={(e) => followLink(e, l.path)}>{l.label}</a>
              {/if}
            </p>
          {/if}
        </section>
      {/each}
      {#if page.tech}
        <!-- Détails techniques : repliés, en bas ; le corps reste sans jargon. -->
        <details class="tech" id="details-techniques" data-tech>
          <summary><span class="tp" aria-hidden="true">$</span>{page.tech.h}</summary>
          <div class="tech-in">
            {#each page.tech.p ?? [] as para, j (j)}<p>{para}</p>{/each}
            {#if page.tech.list}<ul>{#each page.tech.list as li, j (j)}<li>{li}</li>{/each}</ul>{/if}
            <ul class="links">
              {#each page.tech.links as l (l.url)}<li><a href={l.url} target="_blank" rel="noopener noreferrer">{l.label}<span class="sr-only"> {t("foot.external")}</span></a></li>{/each}
            </ul>
          </div>
        </details>
      {/if}
    </div>
  </div>
</article>

<style>
  .info {
    display: grid;
    width: 100%;
    max-width: 1120px;
    margin-inline: auto;
    padding-block: 0 var(--sp-7);
  }
  /* En-tête : ui/PageHeader.svelte. */
  .draft {
    margin: 0;
    padding: var(--sp-2) var(--sp-3);
    border-radius: var(--r-pill);
    background: var(--warn-tint);
    color: var(--warn);
    font-size: var(--fs-small);
    font-weight: 600;
  }

  .body {
    display: grid;
    gap: var(--sp-6);
    padding-block-start: 72px;
  }
  /* Sommaire : boutons (le « # » est réservé aux clés). Téléphone : une rangée de pastilles qui
     défile seule, sans faire défiler la page. */
  .toc {
    display: grid;
    gap: var(--sp-3);
    min-width: 0;
  }
  .toc-h {
    margin: 0;
    /* Casse de phrase (audit du 25 novembre : plus de capitales espacées). */
    color: var(--text-3);
    font-size: var(--fs-small);
    font-weight: 600;
  }
  .toc ol {
    display: flex;
    gap: var(--sp-2);
    margin: 0;
    padding: 0 0 var(--sp-1);
    list-style: none;
    overflow-x: auto;
    scrollbar-width: none;
  }
  .toc li {
    flex: none;
  }
  /* 44 px. */
  .toc button {
    min-height: 44px;
    padding: var(--sp-2) var(--sp-4);
    border: 0;
    border-radius: var(--r-pill);
    background: rgb(255 255 255 / 0.04);
    box-shadow: inset 0 0 0 1px var(--hair-2);
    color: var(--text-2);
    font: inherit;
    font-size: var(--fs-small);
    white-space: nowrap;
    text-align: start;
    cursor: pointer;
    transition: color var(--dur-fast) var(--ease-out), background-color var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out);
  }
  .toc button:hover {
    color: var(--text);
  }
  .toc button[aria-current] {
    color: var(--accent);
    background: rgb(95 227 181 / 0.08);
    box-shadow: inset 0 0 0 1px rgb(95 227 181 / 0.35);
  }
  .toc button:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  /* Ordinateur : sommaire à gauche, qui reste à l'écran ; un trait signale la section lue. */
  @media (min-width: 960px) {
    .body {
      grid-template-columns: 240px minmax(0, 1fr);
      column-gap: clamp(48px, 6vw, 96px);
      align-items: start;
    }
    .body.solo {
      grid-template-columns: minmax(0, 1fr);
    }
    .toc {
      position: sticky;
      top: 96px;
    }
    .toc ol {
      display: grid;
      gap: 0;
      overflow: visible;
      border-inline-start: 1px solid var(--hair-2);
    }
    .toc button {
      position: relative;
      width: 100%;
      padding: 10px 0 10px var(--sp-4);
      border-radius: 0;
      background: none;
      box-shadow: none;
      white-space: normal;
      line-height: 1.35;
    }
    .toc button[aria-current] {
      background: none;
      box-shadow: none;
    }
    .toc button[aria-current]::before {
      content: "";
      position: absolute;
      inset-block: 8px;
      inset-inline-start: -1px;
      width: 2px;
      border-radius: 2px;
      background: var(--accent);
    }
  }

  .text {
    display: grid;
    gap: clamp(48px, 6vw, 72px);
    min-width: 0;
    max-width: 68ch;
  }
  /* Grand écran (1100 px et plus) : la page prend toute la largeur du contenu (en-tête pleine
     largeur, ui/base.css). La largeur gagnée va aux marges, pas aux lignes : le texte garde 70 à
     80 signes par ligne, le sommaire reste proche du texte (plus de grand vide entre eux) et aligné
     sur le bord gauche du titre. */
  @media (min-width: 1100px) {
    .info {
      max-width: none;
    }
    .body {
      grid-template-columns: minmax(240px, 280px) minmax(0, 40rem);
      column-gap: clamp(56px, 5vw, 96px);
      padding-block-start: 88px;
    }
    .text {
      max-width: none;
    }
    .toc button {
      font-size: 0.9375rem;
    }
  }
  .blk {
    display: grid;
    gap: var(--sp-4);
    scroll-margin-top: 96px;
  }
  h2 {
    margin: 0;
    font-size: clamp(1.375rem, 1.2rem + 0.8vw, 1.75rem);
    line-height: 1.2;
    font-weight: 700;
    letter-spacing: -0.02em;
    text-wrap: balance;
  }
  h2:focus {
    outline: none;
  }
  /* Parties d'une section (« Vérifier cette version ») : titre de niveau 3, plus d'air au-dessus
     qu'en dessous, pour que chaque partie se lise comme un groupe. */
  .sub {
    display: grid;
    gap: var(--sp-3);
    margin-block-start: var(--sp-4);
  }
  h3 {
    margin: 0;
    color: var(--text);
    font-size: 1.1875rem;
    line-height: 1.3;
    font-weight: 650;
    text-wrap: balance;
  }
  /* Page Contact : l'adresse, grande et dans la couleur d'accent, avec sa copie à côté. */
  .mail {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--sp-3) var(--sp-4);
    padding: var(--sp-4) var(--sp-5);
    border-radius: var(--r-lg, 14px);
    background: rgb(255 255 255 / 0.03);
    box-shadow: inset 0 0 0 1px var(--hair-2);
  }
  .addr {
    display: inline-flex;
    align-items: center;
    min-height: 44px;
    color: var(--accent);
    font-size: clamp(1.25rem, 1.1rem + 0.6vw, 1.5rem);
    font-weight: 600;
    text-decoration: none;
    overflow-wrap: anywhere;
    border-radius: 6px;
  }
  .addr:hover {
    text-decoration: underline;
    text-underline-offset: 4px;
    text-decoration-thickness: 1px;
  }
  .addr:focus-visible,
  .copy:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  .copy {
    display: inline-flex;
    align-items: center;
    gap: var(--sp-2);
    min-height: 44px;
    padding: var(--sp-2) var(--sp-4);
    border: 0;
    border-radius: var(--r-pill);
    background: rgb(255 255 255 / 0.04);
    box-shadow: inset 0 0 0 1px var(--hair-2);
    color: var(--text);
    font: inherit;
    font-size: var(--fs-small);
    font-weight: 560;
    cursor: pointer;
    transition: background-color var(--dur-fast) var(--ease-out);
  }
  .copy:hover {
    background: rgb(255 255 255 / 0.08);
  }
  p,
  li {
    margin: 0;
    color: #b6c0d9;
    font-size: 1.0625rem;
    line-height: 1.75;
    text-wrap: pretty;
  }
  ul {
    display: grid;
    gap: var(--sp-3);
    margin: 0;
    padding: 0;
    list-style: none;
  }
  /* Puces : petits points menthe, comme la trame du site. */
  .blk li,
  .tech-in > ul:not(.links) li {
    position: relative;
    padding-inline-start: 1.4em;
  }
  .blk li::before,
  .tech-in > ul:not(.links) li::before {
    content: "";
    position: absolute;
    inset-inline-start: 0.2em;
    inset-block-start: 0.72em;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--accent);
  }
  /* Commandes à recopier : défilent seules en largeur, la page ne défile jamais de côté. */
  .cmd {
    margin: 0;
    padding: var(--sp-4) var(--sp-5);
    overflow-x: auto;
    border-radius: var(--r-lg, 14px);
    background: rgb(3 9 8 / 0.55);
    box-shadow: inset 0 0 0 1px rgb(95 227 181 / 0.18);
    color: #d7fbe9;
    font-family: var(--font-mono);
    font-size: var(--fs-small);
    line-height: 1.6;
    white-space: pre;
  }
  .cmd:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  .more {
    color: var(--accent);
    font-weight: 600;
  }
  /* Détails techniques : un terminal replié. */
  .tech {
    border-radius: var(--r-xl);
    background:
      repeating-linear-gradient(180deg, rgb(255 255 255 / 0.018) 0 1px, transparent 1px 3px),
      rgb(3 9 8 / 0.55);
    box-shadow: inset 0 0 0 1px rgb(95 227 181 / 0.18);
  }
  .tech summary {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    min-block-size: 56px;
    padding: var(--sp-3) var(--sp-5);
    color: #9ff5d3;
    font-family: var(--font-mono);
    font-size: var(--fs-small);
    font-weight: 600;
    cursor: pointer;
    border-radius: var(--r-xl);
  }
  .tp {
    color: var(--blue, #5596f8);
  }
  .tech summary:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  .tech-in {
    display: grid;
    gap: var(--sp-3);
    padding: 0 var(--sp-5) var(--sp-5);
  }
  .tech p,
  .tech li {
    font-size: var(--fs-small);
  }
  .links {
    list-style: none;
    padding: 0;
  }
  .links a {
    display: inline-flex;
    align-items: center;
    min-block-size: 44px;
    color: var(--accent);
    font-size: var(--fs-small);
    font-weight: 560;
  }
  @media (prefers-reduced-motion: reduce) {
    .toc button {
      transition: none;
    }
  }
  @media (forced-colors: active) {
    .toc button {
      border: 1px solid ButtonText;
    }
    .toc button[aria-current] {
      border-width: 2px;
    }
    .tech,
    .cmd,
    .mail {
      border: 1px solid CanvasText;
    }
    .copy {
      border: 1px solid ButtonText;
    }
  }
</style>
