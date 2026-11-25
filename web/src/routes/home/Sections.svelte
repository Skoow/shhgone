<script module lang="ts">
  // Trame de points du logo, en petit : grille 6 × 6 d'une page (schémas « Chiffrez » et
  // « Ça s'efface »). Chaque point de « Ça s'efface » part à droite d'une distance qui dépend de sa
  // place (graine fixe : même dessin au build et dans la page).
  const GRID = (() => {
    const out: { x: number; y: number; dx: number; dy: number; d: number }[] = [];
    let s = 0x5eed;
    const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let r = 0; r < 8; r++)
      for (let c = 0; c < 5; c++) {
        const x = 37 + c * 7;
        out.push({ x, y: 30 + r * 7, dx: Math.round(18 + rnd() * 30), dy: Math.round(-14 + rnd() * 28), d: Math.round((4 - c) * 120 + rnd() * 260) });
      }
    return out;
  })();
</script>

<script lang="ts">
  // Accueil, sous le héros (lot 2 de l'audit de design) : sections qui alternent leur mise en page
  // (titre à gauche et frise ; texte et schéma ; schéma et texte ; grande typographie), fonds
  // raccordés au fond de la page (.fondu, ui/base.css) avec quelques coupures en biais, filet
  // lumineux aux jonctions. Chaque section montre quelque chose de concret : chiffres clés (lus
  // dans limits.ts), étapes animées, lien en deux et ce que voit le serveur, vie d'un lien
  // (durées, ouvertures, fin), vérification du site, offres. Animations en CSS seulement, lentes,
  // arrêtées hors écran et coupées en mouvement réduit.
  import { followLink, href } from "../../app/router.svelte";
  import { formatBytes, formatDuration } from "../../i18n/format";
  import { getLang, t, type Key } from "../../i18n/i18n.svelte";
  import { limitParams } from "../../i18n/limit-params";
  import { CONTENT_MAX, MAX_OPENS, PW_TRIES, TTL_HOURS, TTL_MAX_HOURS } from "../../limits";
  import { PASSWORD_LEN } from "../../engine/pure";
  import { SOURCE_URL } from "../pages/content";
  import { reveal } from "../../ui/attach";
  import { reducedMotion } from "../../ui/motion";
  import { ArrowRight, Broom, Eye, EyeOff, FileText, KeyRound, ShieldCheck, Trash2, UserX } from "../../ui/Icon";
  import OffersStrip from "../../ui/OffersStrip.svelte";
  import SecureDemo from "../../ui/SecureDemo.svelte";
  import TabIcon from "../../ui/TabIcon.svelte";

  const how = ["add", "seal", "go", "gone"] as const;
  const priv = ["account", "server", "clean", "room"] as const;
  const uid = $props.id();
  const lang = $derived(getLang());
  // Page : coin replié en haut à droite (schémas de « Comment ça marche »).
  const PAGE = "M26 14H58L70 26V82H26Z";

  // Chiffres clés, tous lus dans limits.ts et le moteur (PASSWORD_LEN : mot de passe toujours tiré,
  // spec §4). Pas de nom d'algorithme (AES-256-GCM) : UI §20.8, vérifié par i18n.test.ts.
  const stats = $derived([
    { v: formatBytes(CONTENT_MAX, lang), l: t("home.stat.size") },
    { v: formatDuration(TTL_MAX_HOURS * 3600, lang), l: t("home.stat.ttl") },
    { v: String(MAX_OPENS), l: t("home.stat.opens") },
    { v: "0", l: t("home.stat.account") },
    { v: String(PASSWORD_LEN), l: t("home.stat.pw") },
  ]);
  const hours = $derived(new Intl.ListFormat(lang, { type: "disjunction" }).format(TTL_HOURS.map((h) => formatDuration(h * 3600, lang))));
  const life = $derived([
    { k: "ttl", p: t("home.life.ttl.p", { hours }) },
    { k: "opens", p: t("home.life.opens.p", { n: MAX_OPENS }) },
    { k: "last", p: t("home.life.last.p") },
    { k: "early", p: t("home.life.early.p", { tries: PW_TRIES }) },
  ]);

  /** Boucles d'une section : jouées seulement quand elle est près de l'écran (aucune en mouvement réduit). */
  function joue(node: HTMLElement): (() => void) | void {
    if (reducedMotion() || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(([e]) => node.classList.toggle("joue", e!.isIntersecting), { rootMargin: "200px 0px" });
    io.observe(node);
    return () => io.disconnect();
  }
  /** Lueur qui suit le pointeur sur une carte (variables CSS seulement ; souris, pas au toucher). */
  function lueur(node: HTMLElement): () => void {
    const move = (e: PointerEvent) => {
      if (e.pointerType !== "mouse") return;
      const r = node.getBoundingClientRect();
      node.style.setProperty("--mx", `${e.clientX - r.left}px`);
      node.style.setProperty("--my", `${e.clientY - r.top}px`);
    };
    node.addEventListener("pointermove", move);
    return () => node.removeEventListener("pointermove", move);
  }
</script>

<!-- Chiffres clés, juste sous le premier écran. -->
<section class="facts" aria-label={t("home.stats.label")}>
  <ul class="stats">
    {#each stats as s, i (i)}
      <li class="rv" style:--i="{i * 60}ms" {@attach reveal}><b class="sv num">{s.v}</b><span class="sl">{s.l}</span></li>
    {/each}
  </ul>
</section>

<section class="sec how fondu fondu-biais filet" id="comment" aria-labelledby="how-title" data-boucle {@attach joue}>
  <div class="head split rv" {@attach reveal}>
    <h2 id="how-title" tabindex="-1">{t("home.how.title")}</h2>
    <p>{t("home.how.lede")}</p>
  </div>
  <ol class="steps3">
    {#each how as k, i (k)}
      <li class="st rv" data-how-card style:--i="{i * 90}ms" {@attach reveal}>
        <span class="tile">
          <svg class="ill {k}" viewBox="0 0 96 96" aria-hidden="true" focusable="false">
            {#if k === "add"}
              <path d={PAGE} fill="#ebe6dc" />
              <path d="M58 14V26H70Z" fill="#bdb6a8" />
              {#each [36, 46, 56, 66] as y, j (y)}<rect class="ln" x="34" {y} width={[26, 30, 20, 24][j]} height="3.5" rx="1.75" fill="#0b0d10" style:--d="{j * 0.35}s" />{/each}
              <g class="plus"><circle cx="70" cy="76" r="11" fill="#5fe3b5" /><path d="M70 70.5v11M64.5 76h11" stroke="#0b0d10" stroke-width="2.6" stroke-linecap="round" /></g>
            {:else if k === "seal"}
              <defs><clipPath id="{uid}-scan"><rect class="scanclip" x="20" y="14" width="56" height="68" /></clipPath></defs>
              <path d={PAGE} fill="#ebe6dc" />
              {#each [30, 40, 50, 60, 70] as y, j (y)}<rect x="34" {y} width={[26, 30, 20, 28, 22][j]} height="3.5" rx="1.75" fill="#0b0d10" />{/each}
              <g clip-path="url(#{uid}-scan)">
                <path d={PAGE} fill="#0b0d10" stroke="#5fe3b5" stroke-width="1.5" />
                {#each GRID as g, j (j)}<circle cx={g.x} cy={g.y} r="1.7" fill={j % 3 === 0 ? "#5fe3b5" : "#ebe6dc"} />{/each}
              </g>
              <rect class="scan" x="22" y="13" width="52" height="2.5" rx="1.25" fill="#5fe3b5" />
            {:else if k === "go"}
              <!-- Deux chemins : le lien (maillons) et le mot de passe (points), chacun par son moyen. -->
              <rect x="8" y="18" width="50" height="24" rx="12" fill="#ebe6dc" />
              <rect x="17" y="25" width="17" height="10" rx="5" fill="none" stroke="#0b0d10" stroke-width="3" />
              <rect x="31" y="25" width="17" height="10" rx="5" fill="none" stroke="#0b0d10" stroke-width="3" />
              <rect x="8.75" y="54.75" width="48.5" height="22.5" rx="11.25" fill="#0b0d10" stroke="#5fe3b5" stroke-width="1.5" />
              {#each [19, 27, 35, 43] as x (x)}<circle cx={x} cy="66" r="2.6" fill="#5fe3b5" />{/each}
              <path class="road" d="M62 30H88" stroke="#ebe6dc" stroke-width="2" stroke-linecap="round" stroke-dasharray="2 5" />
              <path class="road" d="M62 66H88" stroke="#5fe3b5" stroke-width="2" stroke-linecap="round" stroke-dasharray="2 5" />
            {:else}
              {#each GRID as g, j (j)}<circle class="dot" cx={g.x} cy={g.y} r="1.9" fill={j % 4 === 0 ? "#5fe3b5" : "#ebe6dc"} style:--dx="{g.dx}px" style:--dy="{g.dy}px" style:--d="{g.d}ms" />{/each}
            {/if}
          </svg>
        </span>
        <div class="tx">
          <span class="n num" aria-hidden="true">{i + 1}</span>
          <h3><span class="sr-only">{i + 1}. </span>{t(`home.how.${k}.t` as Key)}</h3>
          <p>{t(`home.how.${k}.p` as Key, limitParams(lang))}</p>
        </div>
      </li>
    {/each}
  </ol>
</section>

<!-- L'animation en grand : la scène et le journal à gauche, les étapes à droite. -->
<section class="sec demo-sec fondu filet" aria-labelledby="demo-title">
  <div class="head split rv" {@attach reveal}>
    <h2 id="demo-title">{t("demo.title")}</h2>
    <p>{t("home.demo.lede")}</p>
  </div>
  <SecureDemo labelledby="demo-title" />
</section>

<section class="sec priv fondu fondu-biais fondu-biais-inv filet" aria-labelledby="priv-title">
  <div class="pcol">
    <div class="head rv" {@attach reveal}>
      <h2 id="priv-title" tabindex="-1">{t("home.priv.title")}</h2>
      <p>{t("home.priv.lede")}</p>
      <a class="more" href={href("/securite")} onclick={(e) => followLink(e, "/securite")}>{t("home.why.more")}<ArrowRight size={18} strokeWidth={1.9} aria-hidden="true" /></a>
    </div>
    <ul class="plist">
      {#each priv as k, i (k)}
        <li class={["prow", "rv", { soon: k === "room" && !__SALONS__ }]} data-priv-card style:--i="{i * 70}ms" {@attach reveal}>
          <span class="tile-ic" aria-hidden="true">
            {#if k === "account"}<UserX size={22} strokeWidth={1.8} />{:else if k === "server"}<EyeOff size={22} strokeWidth={1.8} />{:else if k === "clean"}<Broom size={22} strokeWidth={1.8} />{:else}<TabIcon id="chat" size={22} />{/if}
          </span>
          <div>
            <h3>{t(`home.priv.${k}.t` as Key)}{#if k === "room" && !__SALONS__}{" "}<span class="pill">{t("foot.soon")}</span>{/if}</h3>
            <!-- Avec le compte (__COMPTES__) seulement, la ligne dit ce que garde le compte (conception compte §16). -->
            <p>{t((__COMPTES__ && k === "account" ? "home.priv.account.p.comptes" : `home.priv.${k}.p`) as Key)}</p>
          </div>
        </li>
      {/each}
    </ul>
  </div>
  <!-- Le lien en deux, agrandi : l'adresse va au serveur ; tout ce qui suit le « # » reste dans le
       navigateur. Exemple de la longueur réelle (43 caractères : la clé de 32 octets en base64url),
       jamais une vraie clé. Dessous, ce que voit le serveur et ce qu'il ne voit jamais, mot pour mot
       la réponse « Que voit le serveur ? ». -->
  <figure class="link card-relief rv" data-key-note {@attach reveal} {@attach lueur}>
    <div class="lk-bar" aria-hidden="true"><i></i><i></i><i></i></div>
    <div class="lk" aria-hidden="true">
      <span class="lk-a"><span class="lk-l">{t("home.key.server")}</span><span class="lk-v num">https://shhgone.com/s</span></span>
      <span class="lk-b"><span class="lk-l"><KeyRound size={13} strokeWidth={2} />{t("home.key.browser")}</span><span class="lk-v num">#Kq7mXw2Rt9pLz4VbN8cYe1HsJ6uFa3DgQo5WtM0rEiA</span></span>
    </div>
    <div class="sees">
      <div class="sv-col">
        <p class="sv-t"><Eye size={15} strokeWidth={2} aria-hidden="true" />{t("home.sees.t")}</p>
        <ul>{#each [1, 2, 3, 4] as n (n)}<li>{t(`home.sees.${n}` as Key)}</li>{/each}</ul>
      </div>
      <div class="sv-col never">
        <p class="sv-t"><EyeOff size={15} strokeWidth={2} aria-hidden="true" />{t("home.never.t")}</p>
        <ul>{#each [1, 2, 3, 4] as n (n)}<li>{t(`home.never.${n}` as Key)}</li>{/each}</ul>
      </div>
    </div>
    <figcaption>{t("home.key.note")}</figcaption>
  </figure>
</section>

<!-- La vie d'un lien : schéma à gauche, règles à droite (chiffres lus dans limits.ts). -->
<section class="sec life fondu filet" aria-labelledby="life-title" data-boucle {@attach joue}>
  <!-- Schéma (décoratif, les règles sont dites à côté) : le temps qui passe jusqu'à l'échéance, les
       ouvertures qui se prennent une à une, puis l'effacement ; dessous, ce qui l'efface plus tôt. -->
  <div class="track card-relief rv" aria-hidden="true" {@attach reveal} {@attach lueur}>
    <div class="row">
      <span class="rl">{t("home.life.time")}</span>
      <div class="rail"><span class="fill"></span><span class="end"></span></div>
      <div class="ends num"><span>{t("home.life.start")}</span><span>{t("home.life.end")} · {formatDuration(TTL_HOURS[0] * 3600, lang)} → {formatDuration(TTL_MAX_HOURS * 3600, lang)}</span></div>
    </div>
    <div class="row">
      <span class="rl">{t("home.life.opens")}</span>
      <div class="ops">
        {#each Array.from({ length: MAX_OPENS }, (_, j) => j) as j (j)}<span class="op num" style:--k={j}>{j + 1}</span>{/each}
        <span class="nomore">{t("home.life.after")}</span>
      </div>
    </div>
    <div class="row gonerow">
      <span class="dust"></span><span class="gone">{t("home.life.gone")}</span>
    </div>
    <div class="early">
      <span class="rl">{t("home.life.early.t")}</span>
      <span class="chip"><Trash2 size={14} strokeWidth={2} />{t("home.life.chip.manage")}</span>
      <span class="chip"><Trash2 size={14} strokeWidth={2} />{t("home.life.chip.recipient")}</span>
      <span class="chip num"><KeyRound size={14} strokeWidth={2} />{t("home.life.chip.tries", { n: PW_TRIES })}</span>
    </div>
  </div>
  <div class="ltx">
    <div class="head rv" {@attach reveal}>
      <h2 id="life-title">{t("home.life.title")}</h2>
      <p>{t("home.life.lede")}</p>
    </div>
    <dl class="rules">
      {#each life as r, i (r.k)}
        <div class="rv" style:--i="{i * 70}ms" {@attach reveal}><dt>{t(`home.life.${r.k}.t` as Key)}</dt><dd>{r.p}</dd></div>
      {/each}
    </dl>
    <p class="endp">{t("home.life.end.p")}</p>
  </div>
</section>

<!-- Grande typographie : on n'a pas à nous croire sur parole. -->
<section class="sec trust fondu fondu-biais filet" aria-labelledby="trust-title">
  <div class="big rv" {@attach reveal}>
    <h2 id="trust-title">{t("home.trust.title")}</h2>
    <p>{t("home.trust.lede")}</p>
  </div>
  <ul class="tcards">
    <li class="tc card-relief rv" style:--i="0ms" {@attach reveal} {@attach lueur}>
      <span class="tile-ic" aria-hidden="true"><FileText size={22} strokeWidth={1.8} /></span>
      <h3>{t("home.trust.code.t")}</h3>
      <p>{t("home.trust.code.p")}</p>
      <a class="more" href={SOURCE_URL} target="_blank" rel="noopener noreferrer">{t("home.trust.code.go")}<span class="sr-only"> {t("home.trust.newTab")}</span><ArrowRight size={16} strokeWidth={1.9} aria-hidden="true" /></a>
    </li>
    <li class="tc card-relief rv" style:--i="90ms" {@attach reveal} {@attach lueur}>
      <span class="tile-ic" aria-hidden="true"><ShieldCheck size={22} strokeWidth={1.8} /></span>
      <h3>{t("home.trust.verify.t")}</h3>
      <p>{t("home.trust.verify.p")}</p>
      <!-- Ce que répondent les deux outils de la page « Vérifier » (cosign, puis le vérificateur). -->
      <pre class="term num" aria-hidden="true"><span>$ cosign verify-blob …</span>
<b>Verified OK</b>
<span>$ node verifier.mjs …</span>
<b>conforme</b></pre>
      <a class="more" href={href("/verifier")} onclick={(e) => followLink(e, "/verifier")}>{t("home.trust.verify.go")}<ArrowRight size={16} strokeWidth={1.9} aria-hidden="true" /></a>
    </li>
    <li class="tc card-relief rv" style:--i="180ms" {@attach reveal} {@attach lueur}>
      <span class="tile-ic" aria-hidden="true"><EyeOff size={22} strokeWidth={1.8} /></span>
      <h3>{t("home.trust.test.t")}</h3>
      <p>{t("home.trust.test.p")}</p>
    </li>
  </ul>
</section>

<section class="sec offers fondu filet" aria-labelledby="offers-title">
  <div class="head split rv" {@attach reveal}>
    <h2 id="offers-title">{t("home.offers.title")}</h2>
    <p>{t("home.offers.lede")}</p>
  </div>
  <OffersStrip cards />
</section>

<style>
  .sec {
    display: grid;
    gap: var(--sp-7);
    padding-block: 104px 112px;
    scroll-margin-top: 72px;
  }
  @media (min-width: 1024px) {
    .sec {
      padding-block: 136px 144px;
    }
  }
  /* Les sections en biais gardent l'air au-dessus et au-dessous de la pente. */
  .fondu-biais {
    padding-block: calc(104px + var(--pente)) calc(112px + var(--pente));
  }
  @media (min-width: 1024px) {
    .fondu-biais {
      padding-block: calc(120px + var(--pente)) calc(128px + var(--pente));
    }
  }
  /* Lueurs propres à chaque section (lues par .fondu::before, ui/base.css). */
  .how {
    --lueur: rgb(95 227 181 / 0.07);
    --lueur-x: 18%;
  }
  .demo-sec {
    --lueur: rgb(141 178 255 / 0.06);
    --lueur-x: 80%;
  }
  .priv {
    --lueur: rgb(141 178 255 / 0.07);
    --lueur-x: 78%;
    --lueur-y: 55%;
  }
  .life {
    --lueur: rgb(95 227 181 / 0.06);
    --lueur-x: 25%;
    --lueur-y: 50%;
  }
  .trust {
    --lueur: rgb(95 227 181 / 0.08);
    --lueur-x: 50%;
    --lueur-y: 30%;
  }
  .offers {
    --lueur: rgb(62 193 245 / 0.06);
    --lueur-x: 70%;
  }

  /* ---------- Titres : à gauche, sous-titre à côté (grand écran) ---------- */
  .head {
    display: grid;
    justify-items: start;
    gap: var(--sp-3);
    min-width: 0;
  }
  .head > * {
    max-width: 100%;
  }
  @media (min-width: 1024px) {
    .head.split {
      grid-template-columns: minmax(0, 7fr) minmax(0, 5fr);
      align-items: end;
      column-gap: var(--sp-7);
    }
    .head.split p {
      padding-block-end: 0.6em;
    }
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
    max-width: 46ch;
    color: #aab6d3;
    font-size: 1.0625rem;
    line-height: 1.55;
    text-wrap: pretty;
  }
  h3 {
    margin: 0 0 4px;
    font-size: 1.125rem;
    line-height: 1.3;
    letter-spacing: -0.01em;
  }

  /* ---------- Chiffres clés ---------- */
  .facts {
    position: relative;
    padding-block: var(--sp-5) var(--sp-6);
  }
  .stats {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    margin: 0;
    padding: 0;
    list-style: none;
    border-block: 1px solid rgb(233 236 242 / 0.08);
  }
  .stats li {
    display: grid;
    align-content: start;
    gap: 4px;
    min-width: 0;
    padding: var(--sp-4) var(--sp-4) var(--sp-4) 0;
  }
  .stats li:last-child {
    grid-column: 1 / -1;
    border-block-start: 1px solid rgb(233 236 242 / 0.08);
  }
  @media (min-width: 760px) {
    .stats {
      grid-template-columns: repeat(5, minmax(0, 1fr));
    }
    .stats li {
      padding: var(--sp-5) var(--sp-4);
    }
    .stats li + li {
      border-inline-start: 1px solid rgb(233 236 242 / 0.08);
    }
    .stats li:last-child {
      grid-column: auto;
      border-block-start: 0;
    }
  }
  .sv {
    font-size: clamp(1.75rem, 1.3rem + 1.2vw, 2.5rem);
    font-weight: 700;
    font-stretch: 110%;
    font-variant-numeric: tabular-nums;
    letter-spacing: -0.03em;
    line-height: 1.05;
    overflow-wrap: anywhere;
  }
  .sl {
    color: #9aa7c6;
    font-size: var(--fs-small);
    line-height: 1.4;
  }

  /* ---------- Comment ça marche : frise ---------- */
  .steps3 {
    position: relative;
    display: grid;
    gap: var(--sp-6);
    margin: 0;
    padding: 0;
    list-style: none;
  }
  /* Téléphone : frise verticale, la ligne à gauche à travers les pastilles. */
  .steps3::before {
    content: "";
    position: absolute;
    inset-block: 36px;
    inset-inline-start: 35px;
    width: 1px;
    background: linear-gradient(180deg, rgb(95 227 181 / 0.05), rgb(95 227 181 / 0.4), rgb(95 227 181 / 0.05));
  }
  .st {
    position: relative;
    display: grid;
    grid-template-columns: 72px minmax(0, 1fr);
    gap: var(--sp-4);
    align-items: start;
    min-width: 0;
  }
  .tile {
    position: relative;
    display: grid;
    place-items: center;
    width: 72px;
    aspect-ratio: 1;
    border-radius: 20px;
    background: linear-gradient(180deg, #181d27, #10141b);
    box-shadow:
      inset 0 1px 0 rgb(255 255 255 / 0.08),
      inset 0 0 0 1px rgb(233 236 242 / 0.08),
      0 18px 40px -24px rgb(0 0 0 / 0.9);
  }
  .ill {
    display: block;
    width: 82%;
    height: auto;
    overflow: visible;
  }
  .tx {
    display: grid;
    justify-items: start;
    gap: var(--sp-1);
    min-width: 0;
  }
  .n {
    color: var(--accent);
    font-family: var(--font-mono);
    font-size: 0.75rem;
    font-weight: 650;
    letter-spacing: 0.08em;
  }
  .n::before {
    content: "0";
  }
  .st p {
    margin: 0;
    color: #aab6d3;
    font-size: 0.9375rem;
    line-height: 1.55;
    overflow-wrap: break-word;
    text-wrap: pretty;
  }
  @media (min-width: 900px) {
    .steps3 {
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: var(--sp-5);
    }
    .steps3::before {
      inset-block: 72px auto;
      inset-inline: 12.5%;
      width: auto;
      height: 1px;
      background: linear-gradient(90deg, rgb(95 227 181 / 0.05), rgb(95 227 181 / 0.45) 50%, rgb(95 227 181 / 0.05));
    }
    .st {
      grid-template-columns: minmax(0, 1fr);
      justify-items: center;
      text-align: center;
    }
    .tile {
      width: 144px;
      border-radius: 32px;
    }
    .tx {
      justify-items: center;
      max-width: 17rem;
    }
  }
  /* Mini-schémas : lents (5 à 7 s), seulement près de l'écran (.joue), jamais en mouvement réduit. */
  .ill * {
    transform-box: fill-box;
  }
  .add .ln {
    transform-origin: left center;
  }
  .add .plus {
    transform-origin: center;
  }
  .seal .scanclip {
    transform: translateY(-34px);
  }
  .seal .scan {
    transform: translateY(34px);
  }
  .seal .scan {
    filter: drop-shadow(0 0 3px rgb(95 227 181 / 0.9));
  }
  .gone .dot {
    transform-origin: center;
  }
  @media (prefers-reduced-motion: no-preference) {
    .how .ill .ln {
      animation: ecrit 6s var(--ease-out) var(--d) infinite;
    }
    .how .ill .plus {
      animation: depose 6s var(--ease-settle) infinite;
    }
    .how .seal .scanclip {
      animation: trame 5s var(--ease-in-out) infinite;
    }
    .how .seal .scan {
      animation: balaye 5s var(--ease-in-out) infinite;
    }
    .how .go .road {
      animation: route 2.4s linear infinite;
    }
    .how .gone .dot {
      animation: envol 7s var(--ease-in-out) var(--d) infinite;
    }
    .how:not(:global(.joue)) .ill * {
      animation-play-state: paused;
    }
  }
  @keyframes ecrit {
    0%,
    8% {
      transform: scaleX(0);
    }
    30%,
    88% {
      transform: scaleX(1);
    }
    100% {
      transform: scaleX(0);
    }
  }
  @keyframes depose {
    0%,
    50% {
      transform: translateY(-6px) scale(0.6);
      opacity: 0;
    }
    62%,
    90% {
      transform: none;
      opacity: 1;
    }
    100% {
      transform: scale(0.6);
      opacity: 0;
    }
  }
  @keyframes trame {
    0%,
    10% {
      transform: translateY(-70px);
    }
    60%,
    85% {
      transform: translateY(0);
    }
    100% {
      transform: translateY(-70px);
    }
  }
  @keyframes balaye {
    0%,
    10% {
      transform: translateY(0);
      opacity: 0;
    }
    14% {
      opacity: 1;
    }
    60% {
      transform: translateY(68px);
      opacity: 1;
    }
    66%,
    100% {
      transform: translateY(68px);
      opacity: 0;
    }
  }
  @keyframes route {
    to {
      stroke-dashoffset: -14;
    }
  }
  @keyframes envol {
    0%,
    30% {
      transform: none;
      opacity: 1;
    }
    60%,
    85% {
      transform: translate(var(--dx), var(--dy)) scale(0.4);
      opacity: 0;
    }
    100% {
      transform: none;
      opacity: 1;
    }
  }

  /* ---------- Hors de notre portée : texte à gauche, lien agrandi à droite ---------- */
  .priv {
    align-items: center;
  }
  @media (min-width: 1024px) {
    .priv {
      grid-template-columns: minmax(0, 5fr) minmax(0, 7fr);
      column-gap: clamp(40px, 5vw, 88px);
    }
  }
  .pcol {
    display: grid;
    gap: var(--sp-6);
    min-width: 0;
  }
  .plist {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 15rem), 1fr));
    gap: var(--sp-5) var(--sp-5);
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .prow {
    display: grid;
    grid-template-columns: 44px minmax(0, 1fr);
    gap: var(--sp-3);
    align-items: start;
    min-width: 0;
  }
  .prow h3 {
    font-size: 1rem;
  }
  .prow h3,
  .prow p {
    overflow-wrap: break-word;
    min-width: 0;
  }
  .prow p {
    margin: 0;
    color: #aab6d3;
    font-size: 0.9375rem;
    line-height: 1.5;
  }
  /* Pastille d'icône : verre bleu doux, bord intérieur lumineux. */
  .tile-ic {
    display: grid;
    place-items: center;
    width: 44px;
    height: 44px;
    border-radius: 14px;
    background: radial-gradient(circle at 50% 0%, rgb(141 178 255 / 0.22), rgb(141 178 255 / 0.04) 70%);
    box-shadow:
      inset 0 1px 0 rgb(255 255 255 / 0.1),
      inset 0 0 0 1px rgb(141 178 255 / 0.28);
    color: var(--info);
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
  /* Carte en relief : bord intérieur lumineux, ombre douce, lueur qui suit la souris (--mx, --my). */
  .card-relief {
    position: relative;
    border-radius: var(--r-2xl);
    background:
      radial-gradient(260px circle at var(--mx, 50%) var(--my, -40%), rgb(95 227 181 / 0.07), transparent 70%),
      linear-gradient(180deg, #161b25, #0f131a);
    box-shadow:
      inset 0 1px 0 rgb(255 255 255 / 0.08),
      inset 0 0 0 1px rgb(233 236 242 / 0.08),
      0 40px 80px -40px rgb(0 0 0 / 0.9);
  }
  .link {
    display: grid;
    gap: var(--sp-5);
    margin: 0;
    padding: var(--sp-5);
    min-width: 0;
  }
  .lk-bar {
    display: flex;
    gap: 6px;
  }
  .lk-bar i {
    width: 9px;
    height: 9px;
    border-radius: 50%;
    background: rgb(233 236 242 / 0.14);
  }
  .lk {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    border-radius: var(--r-xl);
    background: rgb(7 9 13 / 0.75);
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
    border-block-start: 2px dashed rgb(95 227 181 / 0.5);
    background: rgb(95 227 181 / 0.08);
  }
  .lk-l {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    color: #8f9cbd;
    font-family: var(--font-mono);
    font-size: var(--fs-micro);
  }
  .lk-b .lk-l {
    color: var(--accent);
  }
  .lk-v {
    font-family: var(--font-mono);
    font-size: clamp(1rem, 0.8rem + 0.8vw, 1.5rem);
    color: #c9d1e6;
    overflow-wrap: anywhere;
  }
  .lk-b .lk-v {
    color: var(--accent);
    font-weight: 600;
  }
  @media (min-width: 600px) {
    .lk {
      grid-template-columns: auto minmax(0, 1fr);
    }
    .lk-b {
      border-block-start: 0;
      border-inline-start: 2px dashed rgb(95 227 181 / 0.5);
    }
  }
  .sees {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 13rem), 1fr));
    gap: var(--sp-3);
  }
  .sv-col {
    padding: var(--sp-4);
    border-radius: var(--r-lg);
    background: rgb(255 255 255 / 0.025);
    box-shadow: inset 0 0 0 1px rgb(233 236 242 / 0.07);
  }
  .sv-col.never {
    background: rgb(95 227 181 / 0.04);
    box-shadow: inset 0 0 0 1px rgb(95 227 181 / 0.22);
  }
  .sv-t {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    margin: 0 0 var(--sp-2);
    color: #c9d1e6;
    font-family: var(--font-mono);
    font-size: var(--fs-micro);
    letter-spacing: 0.02em;
  }
  .never .sv-t {
    color: var(--accent);
  }
  .sv-col ul {
    display: grid;
    gap: 6px;
    margin: 0;
    padding: 0;
    list-style: none;
    color: #aab6d3;
    font-size: 0.9375rem;
  }
  .sv-col li::before {
    content: "– ";
    color: var(--text-3);
  }
  .link figcaption {
    color: #8f9cbd;
    font-size: var(--fs-micro);
    line-height: 1.5;
  }

  /* ---------- La vie d'un lien : schéma à gauche, règles à droite ---------- */
  .life {
    align-items: center;
  }
  @media (min-width: 1024px) {
    .life {
      grid-template-columns: minmax(0, 6fr) minmax(0, 6fr);
      column-gap: clamp(40px, 5vw, 88px);
    }
  }
  /* Téléphone : le titre avant le schéma. */
  @media (max-width: 1023px) {
    .ltx {
      order: -1;
    }
  }
  .ltx {
    display: grid;
    gap: var(--sp-5);
    min-width: 0;
  }
  .track {
    display: grid;
    gap: var(--sp-5);
    padding: var(--sp-6) var(--sp-5);
    min-width: 0;
    color: #aab6d3;
    font-size: var(--fs-small);
  }
  .row {
    display: grid;
    gap: var(--sp-2);
  }
  .rl {
    color: #c9d1e6;
    font-family: var(--font-mono);
    font-size: var(--fs-micro);
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  .ends {
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    gap: var(--sp-2);
    font-family: var(--font-mono);
    font-size: var(--fs-micro);
  }
  .rail {
    position: relative;
    height: 10px;
    border-radius: 10px;
    background: repeating-linear-gradient(90deg, rgb(233 236 242 / 0.12) 0 6px, transparent 6px 10px);
  }
  .fill {
    position: absolute;
    inset: 0;
    border-radius: 10px;
    background: linear-gradient(90deg, rgb(95 227 181 / 0.12), rgb(95 227 181 / 0.85));
    box-shadow: 0 0 18px -4px rgb(95 227 181 / 0.6);
    transform-origin: left;
    transform: scaleX(0.62);
  }
  .end {
    position: absolute;
    inset-inline-end: 0;
    top: 50%;
    width: 18px;
    height: 18px;
    translate: 0 -50%;
    border-radius: 50%;
    background: #0f131a;
    box-shadow: inset 0 0 0 2px var(--accent);
  }
  .ops {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--sp-2);
  }
  .op {
    display: grid;
    place-items: center;
    width: 36px;
    height: 36px;
    border-radius: 12px;
    background: var(--accent);
    color: var(--on-accent);
    font-family: var(--font-mono);
    font-size: 0.8125rem;
    font-weight: 700;
    box-shadow: 0 0 0 4px rgb(95 227 181 / 0.1);
  }
  .op:nth-child(n + 4) {
    background: #1a2029;
    color: #8f9cbd;
    box-shadow: inset 0 0 0 1px rgb(233 236 242 / 0.2);
  }
  .nomore {
    margin-inline-start: auto;
    padding: 4px 10px;
    border-radius: var(--r-pill);
    box-shadow: inset 0 0 0 1px rgb(233 236 242 / 0.14);
    font-size: var(--fs-micro);
  }
  .gonerow {
    display: flex;
    align-items: center;
    gap: var(--sp-3);
    padding: var(--sp-3) var(--sp-4);
    border-radius: var(--r-lg);
    background: rgb(95 227 181 / 0.05);
    box-shadow: inset 0 0 0 1px rgb(95 227 181 / 0.2);
  }
  .dust {
    flex: none;
    width: 64px;
    height: 22px;
    background: radial-gradient(circle, var(--accent) 0 1.6px, transparent 2px) 0 0 / 8px 8px;
    -webkit-mask-image: linear-gradient(90deg, #000, transparent);
    mask-image: linear-gradient(90deg, #000, transparent);
  }
  .gone {
    color: var(--accent);
    font-weight: 650;
  }
  .early {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--sp-2);
    padding-block-start: var(--sp-4);
    border-block-start: 1px dashed rgb(233 236 242 / 0.12);
  }
  .early .rl {
    flex-basis: 100%;
  }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 12px;
    border-radius: var(--r-pill);
    background: rgb(255 255 255 / 0.04);
    box-shadow: inset 0 0 0 1px rgb(233 236 242 / 0.1);
  }
  .chip :global(svg) {
    color: var(--info);
  }
  @media (prefers-reduced-motion: no-preference) {
    .life .fill {
      animation: vie 12s var(--ease-in-out) infinite;
    }
    .life .op {
      animation: ouvre 12s var(--ease-out) infinite;
      animation-delay: calc(var(--k) * 1.4s);
    }
    .life .nomore {
      animation: plus 12s var(--ease-out) infinite;
    }
    .life:not(:global(.joue)) :is(.fill, .op, .nomore) {
      animation-play-state: paused;
    }
  }
  @keyframes vie {
    0% {
      transform: scaleX(0);
    }
    80%,
    92% {
      transform: scaleX(1);
    }
    100% {
      transform: scaleX(1);
      opacity: 0;
    }
  }
  @keyframes ouvre {
    0%,
    4% {
      background: #1a2029;
      color: #8f9cbd;
      box-shadow: inset 0 0 0 1px rgb(233 236 242 / 0.2);
    }
    8%,
    72% {
      background: var(--accent);
      color: var(--on-accent);
      box-shadow: 0 0 0 4px rgb(95 227 181 / 0.1);
    }
    86%,
    100% {
      background: #1a2029;
      color: #8f9cbd;
      box-shadow: inset 0 0 0 1px rgb(233 236 242 / 0.2);
    }
  }
  @keyframes plus {
    0%,
    55% {
      opacity: 0.35;
    }
    62%,
    92% {
      opacity: 1;
      color: #c9d1e6;
    }
  }
  .rules {
    display: grid;
    gap: 0;
    margin: 0;
  }
  .rules > div {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 4px;
    padding-block: var(--sp-4);
    border-block-start: 1px solid rgb(233 236 242 / 0.08);
  }
  @media (min-width: 600px) {
    .rules > div {
      grid-template-columns: 12rem minmax(0, 1fr);
      column-gap: var(--sp-5);
    }
  }
  .rules dt {
    font-weight: 650;
  }
  .rules dd {
    margin: 0;
    color: #aab6d3;
    line-height: 1.55;
  }
  .endp {
    margin: 0;
    padding: var(--sp-3) var(--sp-4);
    border-radius: var(--r-md);
    background: rgb(95 227 181 / 0.06);
    box-shadow: inset 0 0 0 1px rgb(95 227 181 / 0.2);
    color: #c9d1e6;
    font-size: 0.9375rem;
  }

  /* ---------- Grande typographie : on n'a pas à nous croire sur parole ---------- */
  .big {
    display: grid;
    gap: var(--sp-4);
    max-width: 62rem;
  }
  .big h2 {
    font-size: clamp(2.5rem, 1.2rem + 4.6vw, 5.75rem);
    line-height: 0.98;
    letter-spacing: -0.045em;
  }
  .big p {
    margin: 0;
    max-width: 52ch;
    color: #aab6d3;
    font-size: clamp(1.0625rem, 1rem + 0.3vw, 1.25rem);
    line-height: 1.55;
  }
  .tcards {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 17rem), 1fr));
    gap: var(--sp-4);
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .tc {
    display: grid;
    align-content: start;
    gap: var(--sp-3);
    padding: var(--sp-5);
    min-width: 0;
    transition:
      transform 420ms var(--ease-settle),
      box-shadow 420ms var(--ease-settle);
  }
  @media (hover: hover) {
    .tc:hover,
    .link:hover {
      transform: translateY(-3px);
    }
  }
  .link {
    transition: transform 420ms var(--ease-settle);
  }
  .tc p {
    margin: 0;
    color: #aab6d3;
    line-height: 1.55;
  }
  .tc h3 {
    margin: var(--sp-2) 0 0;
  }
  .term {
    margin: 0;
    padding: var(--sp-3) var(--sp-4);
    border-radius: var(--r-md);
    background: rgb(7 9 13 / 0.8);
    box-shadow: inset 0 0 0 1px rgb(233 236 242 / 0.08);
    color: #8f9cbd;
    font-family: var(--font-mono);
    font-size: 0.75rem;
    line-height: 1.7;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .term b {
    color: var(--accent);
    font-weight: 600;
  }

  .demo-sec :global(.fig) {
    min-width: 0;
  }
  .offers :global([data-offer-cards]) {
    width: 100%;
  }
  @media (prefers-reduced-motion: reduce) {
    .more :global(svg),
    .tc,
    .link {
      transition: none;
    }
    .more:hover :global(svg),
    .tc:hover,
    .link:hover {
      transform: none;
    }
  }
  @media (forced-colors: active) {
    .more {
      color: LinkText;
    }
    .card-relief,
    .tile {
      border: 1px solid CanvasText;
    }
  }
</style>
