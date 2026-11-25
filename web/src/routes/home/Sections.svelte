<script module lang="ts">
  // Nuée de points de l'illustration « Effacé » : positions tirées une fois, à
  // graine fixe (même dessin au build et dans la page), plus clairsemées vers la droite.
  function cloud() {
    let s = 0x5eed;
    const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const out: { x: number; y: number; r: number; m: boolean }[] = [];
    for (let i = 0; i < 150; i++) {
      const u = rnd();
      const x = 44 + Math.pow(u, 1.7) * 150;
      out.push({ x: Math.round(x * 10) / 10, y: Math.round((8 + rnd() * 146) * 10) / 10, r: Math.round((1.1 + rnd() * 1.2) * 10) / 10, m: rnd() < 0.25 + (x - 44) / 220 });
    }
    return out;
  }
  const CLOUD = cloud();
  // Lignes de dots de la page en trame (illustrations 2 et 3).
  const DOTS = (() => {
    const out: { x: number; y: number }[] = [];
    for (let y = 4; y < 160; y += 6) for (let x = 4; x < 124; x += 6) out.push({ x, y });
    return out;
  })();
</script>

<script lang="ts">
  // Accueil, sous le héros (maquette « La trame ») : sections sombres
  // sur le fond de la page (.soft) et plaques en relief à texture (.slab, ui/base.css). « Comment ça marche » : trois
  // illustrations fixes (document, document en trame fermé à clé, document qui part en points),
  // aucune animation (l'infographie du héros suffit). « Pensé pour la confidentialité » : fond
  // crème, titre à gauche, liste à droite. « Offres » : les trois cartes.
  import { followLink, href } from "../../app/router.svelte";
  import { getLang, t, type Key } from "../../i18n/i18n.svelte";
  import { limitParams } from "../../i18n/limit-params";
  import { reveal } from "../../ui/attach";
  import { ArrowRight, Broom, EyeOff, KeyRound, UserX } from "../../ui/Icon";
  import OffersStrip from "../../ui/OffersStrip.svelte";
  import SecureDemo from "../../ui/SecureDemo.svelte";
  import TabIcon from "../../ui/TabIcon.svelte";

  const how = ["add", "seal", "go", "gone"] as const;
  const priv = ["account", "server", "clean", "room"] as const;
  const uid = $props.id();
  // Page : coin replié en haut à droite.
  const PAGE = "M0 0H92L124 32V160H0Z";
</script>

<section class="sec how slab dots" id="comment" aria-labelledby="how-title">
  <div class="head rv" {@attach reveal}>
    <h2 id="how-title" tabindex="-1">{t("home.how.title")}</h2>
    <p>{t("home.how.lede")}</p>
  </div>
  <ol class="steps3">
    {#each how as k, i (k)}
      <li class="st rv" data-how-card style:--i="{i * 80}ms" {@attach reveal}>
        <svg class="ill" viewBox={k === "gone" ? "0 0 200 164" : "0 0 128 164"} aria-hidden="true" focusable="false">
          {#if k === "add"}
            <path d={PAGE} fill="#ebe6dc" />
            <path d="M92 0V32H124Z" fill="#bdb6a8" />
            <rect x="16" y="18" width="30" height="16" fill="#0b0d10" />
            {#each [56, 78, 100, 122, 144] as y, j (y)}<rect x="16" {y} width={[84, 92, 70, 84, 92][j]} height="3.5" fill="#0b0d10" />{/each}
          {:else if k === "go"}
            <!-- Deux cartes, deux chemins : le lien (maillons) et le mot de passe (points menthe). -->
            <rect x="0" y="8" width="128" height="64" rx="10" fill="#ebe6dc" />
            <rect x="22" y="28" width="44" height="24" rx="12" fill="none" stroke="#0b0d10" stroke-width="6" />
            <rect x="62" y="28" width="44" height="24" rx="12" fill="none" stroke="#0b0d10" stroke-width="6" />
            <rect x="1.5" y="93.5" width="125" height="61" rx="10" fill="#0b0d10" stroke="#5fe3b5" stroke-width="3" />
            {#each [32, 48, 64, 80, 96] as x (x)}<circle cx={x} cy="124" r="5" fill="#5fe3b5" />{/each}
          {:else}
            <defs><clipPath id="{uid}-{k}"><path d={PAGE} /></clipPath></defs>
            <g clip-path="url(#{uid}-{k})">
              {#each DOTS as d, j (j)}{#if k === "seal" || d.x < 40 + ((d.y * 7) % 23)}<circle cx={d.x} cy={d.y} r="2.2" fill="#ebe6dc" />{/if}{/each}
            </g>
            {#if k === "seal"}
              <circle cx="62" cy="84" r="38" fill="#0b0d10" />
              <rect x="46" y="80" width="32" height="24" rx="5" fill="none" stroke="#5fe3b5" stroke-width="5" />
              <path d="M52 80V71a10 10 0 0 1 20 0v9" fill="none" stroke="#5fe3b5" stroke-width="5" stroke-linecap="round" />
              <path d="M62 89v6" stroke="#5fe3b5" stroke-width="5" stroke-linecap="round" />
            {:else}
              {#each CLOUD as c, j (j)}<circle cx={c.x} cy={c.y} r={c.r} fill={c.m ? "#5fe3b5" : "#ebe6dc"} opacity={c.x > 150 ? 0.6 : 1} />{/each}
            {/if}
          {/if}
        </svg>
        <div class="tx">
          <span class="n num" aria-hidden="true">{i + 1}</span>
          <h3><span class="sr-only">{i + 1}. </span>{t(`home.how.${k}.t` as Key)}</h3>
          <p>{t(`home.how.${k}.p` as Key, limitParams(getLang()))}</p>
        </div>
      </li>
    {/each}
  </ol>
</section>

<!-- L'animation en grand : la scène et le journal (deux lignes) à
     gauche, les étapes cochées au fil de l'animation à droite, « étape n sur 7 » et la pause en haut. -->
<section class="sec demo-sec soft" aria-labelledby="demo-title">
  <div class="head rv" {@attach reveal}>
    <h2 id="demo-title">{t("demo.title")}</h2>
    <p>{t("home.demo.lede")}</p>
  </div>
  <SecureDemo labelledby="demo-title" />
</section>

<section class="sec priv slab pictos" aria-labelledby="priv-title">
  <div class="head rv" {@attach reveal}>
    <h2 id="priv-title" tabindex="-1">{t("home.priv.title")}</h2>
    <p>{t("home.priv.lede")}</p>
    <a class="more" href={href("/securite")} onclick={(e) => followLink(e, "/securite")}>{t("home.why.more")}<ArrowRight size={18} strokeWidth={1.9} aria-hidden="true" /></a>
  </div>
  <ul class="plist">
    {#each priv as k, i (k)}
      <li class={["prow", "rv", { soon: k === "room" && !__SALONS__ }]} data-priv-card style:--i="{i * 70}ms" {@attach reveal}>
        <span class="tile-ic" aria-hidden="true">
          {#if k === "account"}<UserX size={30} strokeWidth={1.7} />{:else if k === "server"}<EyeOff size={30} strokeWidth={1.7} />{:else if k === "clean"}<Broom size={30} strokeWidth={1.7} />{:else}<TabIcon id="chat" size={30} />{/if}
        </span>
        <div>
          <h3>{t(`home.priv.${k}.t` as Key)}{#if k === "room" && !__SALONS__}{" "}<span class="pill">{t("foot.soon")}</span>{/if}</h3>
          <!-- Avec le compte (__COMPTES__) seulement, la ligne dit ce que garde le compte (conception compte §16). -->
          <p>{t((__COMPTES__ && k === "account" ? "home.priv.account.p.comptes" : `home.priv.${k}.p`) as Key)}</p>
        </div>
      </li>
    {/each}
  </ul>
  <!-- Le lien en deux (de nouveau montré ici) :
       l'adresse va au serveur ; tout ce qui suit le « # » reste dans le navigateur.
       Exemple de la longueur réelle (43 caractères : la clé de 32 octets en base64url), jamais une
       vraie clé. -->
  <figure class="link rv" data-key-note {@attach reveal}>
    <div class="lk" aria-hidden="true">
      <span class="lk-a"><span class="lk-l">{t("home.key.server")}</span><span class="lk-v num">https://shhgone.com/s</span></span>
      <span class="lk-b"><span class="lk-l"><KeyRound size={13} strokeWidth={2} />{t("home.key.browser")}</span><span class="lk-v num">#Kq7mXw2Rt9pLz4VbN8cYe1HsJ6uFa3DgQo5WtM0rEiA</span></span>
    </div>
    <figcaption>{t("home.key.note")}</figcaption>
  </figure>
</section>

<section class="sec offers soft" aria-labelledby="offers-title">
  <div class="head rv" {@attach reveal}>
    <h2 id="offers-title">{t("home.offers.title")}</h2>
    <p>{t("home.offers.lede")}</p>
  </div>
  <OffersStrip cards />
</section>

<style>
  .sec {
    display: grid;
    gap: var(--sp-7);
    padding-block: 112px 120px;
    scroll-margin-top: 72px;
  }
  @media (min-width: 1024px) {
    .sec {
      padding-block: 136px 144px;
    }
  }
  /* Titres et sous-titres centrés. */
  .head {
    display: grid;
    justify-items: center;
    gap: var(--sp-3);
    max-width: 44rem;
    min-width: 0;
    margin-inline: auto;
    text-align: center;
  }
  .head > * {
    max-width: 100%;
  }
  h2 {
    margin: 0;
    min-width: 0;
    overflow-wrap: break-word;
    font-size: clamp(2.25rem, 1.4rem + 2.8vw, 4rem);
    line-height: 1.02;
    font-weight: 700;
    font-stretch: 112%;
    letter-spacing: -0.035em;
    text-wrap: balance;
  }
  h2:focus {
    outline: none;
  }
  .head p {
    margin: 0;
    color: #aab6d3;
    font-size: 1.0625rem;
    line-height: 1.55;
    text-wrap: pretty;
  }
  h3 {
    margin: 0 0 4px;
    font-size: 1.1875rem;
    line-height: 1.3;
  }

  /* ---------- Comment ça marche : trois illustrations reliées par des pointillés ---------- */
  /* Téléphone : deux colonnes, la troisième étape sur toute la largeur ; une seule colonne quand le
     texte est agrandi (9 rem : 288 px à 200 %). */
  /* Téléphone et tablette : deux colonnes (une seule si le texte est agrandi : 9 rem = 288 px à
     200 %) ; ordinateur : quatre, reliées par un pointillé. Chaque illustration a la même hauteur. */
  .steps3 {
    display: grid;
    /* Deux étapes par ligne au plus, partout ; une seule colonne
       quand le texte est agrandi (9 rem = 288 px à 200 %). */
    grid-template-columns: repeat(auto-fit, minmax(max(min(100%, 9rem), 40%), 1fr));
    gap: var(--sp-7) var(--sp-5);
    margin: 0;
    padding: 0;
    list-style: none;
  }
  /* (« revoir la grandeur des images pour mieux les centrer ») :
     chaque étape est une colonne centrée ; toutes les illustrations ont la même hauteur (--ih),
     leur largeur suit leur dessin, le texte est centré dessous. */
  .st {
    position: relative;
    display: grid;
    justify-items: center;
    align-content: start;
    gap: var(--sp-4);
    min-width: 0;
    text-align: center;
  }
  .steps3 {
    --ih: clamp(112px, 26vw, 148px);
  }
  .ill {
    display: block;
    height: var(--ih);
    width: auto;
    max-width: 100%;
  }
  .tx {
    display: grid;
    justify-items: center;
    gap: var(--sp-2);
    max-width: 26rem;
  }
  .n {
    display: grid;
    place-items: center;
    width: 28px;
    height: 28px;
    border-radius: 50%;
    /* Même bleu doux (--info) que les ronds de « hors de notre portée ». */
    background: radial-gradient(circle at 50% 30%, rgb(141 178 255 / 0.2), rgb(141 178 255 / 0.05));
    box-shadow: inset 0 0 0 1px rgb(141 178 255 / 0.35);
    color: var(--info);
    font-family: var(--font-mono);
    font-size: 0.875rem;
    font-weight: 650;
  }
  .st p {
    margin: 0;
    color: #aab6d3;
    font-size: 0.9375rem;
    line-height: 1.55;
    overflow-wrap: break-word;
    text-wrap: pretty;
  }
  .st h3 {
    overflow-wrap: break-word;
  }
  @media (min-width: 1024px) {
    .steps3 {
      --ih: 168px;
      gap: 72px clamp(48px, 7vw, 128px);
      width: min(100%, 60rem);
      margin-inline: auto;
    }
  }

  /* ---------- Confidentialité : plaque en relief aux pictos ---------- */
  .priv .head p {
    color: #aab6d3;
  }
  .plist {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 17rem), 1fr));
    column-gap: var(--sp-6);
    margin: 0;
    padding: 0;
    list-style: none;
  }
  /* Texte centré, pictogramme plus gros, centré au-dessus. */
  .prow {
    display: grid;
    justify-items: center;
    align-content: start;
    gap: var(--sp-3);
    padding-block: var(--sp-6);
    border-block-start: 1px solid rgb(233 236 242 / 0.08);
    border-block-end: 1px solid rgb(233 236 242 / 0.08);
    text-align: center;
  }
  .tile-ic {
    display: grid;
    place-items: center;
    width: 64px;
    height: 64px;
    border-radius: 50%;
    /* Bleu doux (--info), plus le vert d'accent. */
    background: radial-gradient(circle at 50% 30%, rgb(141 178 255 / 0.2), rgb(141 178 255 / 0.05));
    box-shadow: inset 0 0 0 1px rgb(141 178 255 / 0.35);
    color: var(--info);
  }
  .prow > div {
    display: grid;
    justify-items: center;
    max-width: 30rem;
  }
  .prow h3,
  .prow p {
    overflow-wrap: break-word;
    min-width: 0;
  }
  .prow p {
    margin: 0;
    color: #aab6d3;
    line-height: 1.55;
  }
  .pill {
    display: inline-block;
    padding: 1px 8px;
    border-radius: var(--r-pill);
    background: rgb(95 227 181 / 0.1);
    color: var(--accent);
    font-family: var(--font-mono);
    font-size: 0.6875rem;
    font-weight: 600;
    vertical-align: middle;
  }
  .more {
    display: inline-flex;
    align-items: center;
    gap: var(--sp-2);
    min-height: 44px;
    margin-block-start: var(--sp-2);
    color: var(--accent);
    font-weight: 650;
    text-decoration: underline;
    text-decoration-thickness: 1px;
    text-underline-offset: 6px;
  }
  .more :global(svg) {
    transition: transform 420ms var(--ease-settle);
  }
  .more:hover :global(svg) {
    transform: translateX(4px);
  }
  .more:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 3px;
    border-radius: 6px;
  }
  /* Le lien en deux : l'adresse, puis la clé en menthe. */
  .link {
    display: grid;
    gap: var(--sp-3);
    margin: 0;
    min-width: 0;
  }
  .lk {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    border-radius: var(--r-xl);
    background: rgb(7 9 13 / 0.7);
    box-shadow: inset 0 0 0 1px rgb(233 236 242 / 0.08);
    overflow: hidden;
  }
  .lk-a,
  .lk-b {
    display: grid;
    gap: 6px;
    min-width: 0;
    padding: var(--sp-4) var(--sp-5);
  }
  .lk-b {
    border-inline-start: 2px dashed rgb(95 227 181 / 0.5);
    background: rgb(95 227 181 / 0.08);
    box-shadow: inset 0 0 0 1px rgb(95 227 181 / 0.35);
    border-radius: 0 var(--r-xl) var(--r-xl) 0;
  }
  .lk-l {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    color: #8f9cbd;
    font-size: var(--fs-micro);
  }
  .lk-b .lk-l {
    color: var(--accent);
  }
  .lk-v {
    font-family: var(--font-mono);
    font-size: clamp(0.9375rem, 0.75rem + 0.6vw, 1.25rem);
    color: #c9d1e6;
    overflow-wrap: anywhere;
  }
  .lk-b .lk-v {
    color: var(--accent);
    font-weight: 600;
  }
  /* Sous le lien, en petit, sur toute la largeur. */
  .link figcaption {
    color: #8f9cbd;
    font-size: var(--fs-micro);
    line-height: 1.5;
  }
  @media (max-width: 599px) {
    .lk {
      grid-template-columns: minmax(0, 1fr);
    }
    .lk-b {
      border-inline-start: 0;
      border-block-start: 2px dashed rgb(95 227 181 / 0.5);
      border-radius: 0 0 var(--r-xl) var(--r-xl);
    }
  }
  @media (min-width: 1024px) {
    .plist {
      grid-template-columns: repeat(2, minmax(0, 1fr));
      column-gap: clamp(48px, 6vw, 112px);
    }
  }
  .demo-sec :global(.fig) {
    min-width: 0;
  }

  .offers :global([data-offer-cards]) {
    width: 100%;
  }
  @media (prefers-reduced-motion: reduce) {
    .more :global(svg) {
      transition: none;
    }
    .more:hover :global(svg) {
      transform: none;
    }
  }
  @media (forced-colors: active) {
    .more {
      color: LinkText;
    }
  }
</style>
