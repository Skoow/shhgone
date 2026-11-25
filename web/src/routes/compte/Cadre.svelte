<script lang="ts">
  // Cadre des pages du compte (conception compte §12, §21.15) : titre de l'écran (focus à
  // l'arrivée), sous-titre, contenu. Trois formes :
  // - « panneaux » (connexion, inscription, récupération ; audit design, direction A) : deux
  //   panneaux sur toute la largeur de la fenêtre. À droite le formulaire (colonne de 30 rem) ; à
  //   gauche la promesse, un schéma sobre (appareil, chiffré, serveur) et trois points forts, sans
  //   terme technique et sans rien promettre de faux (le serveur garde l'empreinte du pseudo, des
  //   données chiffrées et quelques dates : jamais « rien n'est gardé »). Téléphone : la scène
  //   devient une bande courte (promesse et points forts, sans le schéma) au-dessus du formulaire.
  //   Dans le DOM, la scène vient APRÈS le formulaire (le titre, qui prend
  //   le focus, se lit en premier) ; seule la grille la place à gauche ou en haut.
  //   `etape` (1 à 4) : barre d'étapes de l'inscription (direction C) en tête du formulaire.
  // - « large » (paramètres) : pleine largeur de la colonne de contenu, titre à gauche.
  // - « carte » (défaut ; profil, suppression, salon) : carte centrée de 30 rem.
  // Démo : la phrase de la démo sous le titre pour la carte et les paramètres ; dans les panneaux,
  // chaque écran la pose sous son bouton principal (NoteDemo.svelte).
  import { untrack, type Snippet } from "svelte";
  import { getDemo } from "../../app/demo-hooks";
  import { t } from "../../i18n/i18n.svelte";
  import { KeyRound, Lock, Server, UserX } from "../../ui/Icon";

  type Props = { titre: string; sous?: string; children: Snippet; forme?: "carte" | "panneaux" | "large"; etape?: 1 | 2 | 3 | 4 };
  let { titre, sous, children, forme = "carte", etape }: Props = $props();
  let h1: HTMLHeadingElement | undefined = $state();
  $effect(() => {
    if (h1) untrack(() => h1?.focus({ preventScroll: true }));
  });
  const ETAPES = ["account.steps.1", "account.steps.2", "account.steps.3", "account.steps.4"] as const;
</script>

{#snippet tete(bandeau: boolean)}
  <div class={["tete", { "titre-bandeau": bandeau }]}>
    <h1 id="compte-titre" class="titre" tabindex="-1" data-large-title bind:this={h1}>{titre}</h1>
    {#if sous}<p class="sous">{sous}</p>{/if}
  </div>
{/snippet}

{#if forme === "panneaux"}
  <div class="deux" data-panneaux>
    <section class="cadre panneau" aria-labelledby="compte-titre">
      <div class="col">
        {@render tete(false)}
        {#if etape}
          <ol class="rail" aria-label={t("account.steps")} data-etapes>
            {#each ETAPES as cle, i (cle)}
              <li class={{ on: i + 1 === etape, fait: i + 1 < etape }} aria-current={i + 1 === etape ? "step" : undefined}>
                <span class="lib"><span class="n">{i + 1}</span>{t(cle)}</span>
              </li>
            {/each}
          </ol>
        {/if}
        {@render children()}
      </div>
    </section>
    <aside class="scene" aria-labelledby="scene-promesse" data-scene>
      <p class="sur"><span class="pt" aria-hidden="true"></span>{t("account.scene.eyebrow")}</p>
      <p class="promesse" id="scene-promesse">{t("account.scene.promise")}</p>
      <!-- Schéma : appareil (passkey), chiffré, serveur ; décor, dit par les points forts dessous. -->
      <div class="flux" aria-hidden="true">
        <span class="noeud moi"><span class="ic"><KeyRound size={26} strokeWidth={1.6} /></span>{t("account.scene.device")}</span>
        <span class="fil"><b></b></span>
        <span class="noeud"><span class="ic"><Lock size={26} strokeWidth={1.6} /></span>{t("account.scene.envelope")}</span>
        <span class="fil"><b></b></span>
        <span class="noeud"><span class="ic"><Server size={26} strokeWidth={1.6} /></span>{t("account.scene.server")}</span>
      </div>
      <ul class="points" data-points>
        <li><span class="pic" aria-hidden="true"><UserX size={20} strokeWidth={1.8} /></span><span class="ptx"><strong>{t("account.scene.p1")}</strong><span class="pd">{t("account.scene.p1.d")}</span></span></li>
        <li><span class="pic" aria-hidden="true"><Lock size={20} strokeWidth={1.8} /></span><span class="ptx"><strong>{t("account.scene.p2")}</strong><span class="pd">{t("account.scene.p2.d")}</span></span></li>
        <li><span class="pic" aria-hidden="true"><KeyRound size={20} strokeWidth={1.8} /></span><span class="ptx"><strong>{t("account.scene.p3")}</strong><span class="pd">{t("account.scene.p3.d")}</span></span></li>
      </ul>
    </aside>
  </div>
{:else}
  <section class={["cadre", forme]} aria-labelledby="compte-titre">
    {@render tete(true)}
    {#if getDemo()}<p class="note" data-demo-note>{getDemo()!.compteNote}</p>{/if}
    {@render children()}
  </section>
{/if}

<style>
  /* ---------- Forme « carte » (défaut) ---------- */
  .carte {
    position: relative;
    isolation: isolate;
    width: min(100%, 30rem);
    margin: var(--sp-6) auto var(--sp-8);
    padding: clamp(28px, 5vw, 44px) clamp(20px, 5vw, 40px) clamp(28px, 5vw, 40px);
    border-radius: clamp(20px, 3vw, 28px);
    background:
      radial-gradient(90% 60% at 50% -10%, rgb(95 227 181 / 0.14), transparent 70%),
      linear-gradient(180deg, rgb(255 255 255 / 0.045), rgb(255 255 255 / 0.012)),
      rgb(14 17 23);
    box-shadow:
      inset 0 0 0 1px rgb(233 236 242 / 0.1),
      inset 0 1px 0 rgb(255 255 255 / 0.06),
      0 40px 80px -48px rgb(0 0 0 / 0.9);
  }
  .cadre {
    display: grid;
    gap: var(--sp-5);
    min-width: 0;
  }
  .titre {
    margin: 0;
    font-size: clamp(1.875rem, 1.4rem + 1.6vw, 2.5rem);
    font-weight: 700;
    font-stretch: var(--wd-display, 112%);
    letter-spacing: -0.03em;
    line-height: 1.08;
    text-align: center;
    text-wrap: balance;
  }
  .titre:focus {
    outline: none;
  }
  /* Titre et sous-titre : dans le bandeau des titres (ui/base.css) pour la carte et les paramètres. */
  .tete {
    display: grid;
    gap: var(--sp-2);
  }
  .sous {
    margin: 0;
    color: var(--text-2);
    text-align: center;
    text-wrap: pretty;
  }

  /* ---------- Forme « large » (paramètres) ---------- */
  .large {
    width: min(100%, 72rem);
    margin: var(--sp-4) auto var(--sp-8);
  }
  .large .titre,
  .large .sous {
    text-align: start;
  }

  /* ---------- Forme « panneaux » (direction A) ---------- */
  /* D'un bord à l'autre de la fenêtre (100cqw du conteneur #app, pas 100vw : pas de défilement
     horizontal), collée sous l'en-tête et au-dessus du pied. */
  .deux {
    display: grid;
    grid-template-columns: minmax(0, 1.1fr) minmax(min(100%, 34rem), 0.9fr);
    grid-template-areas: "scene panneau";
    min-height: calc(100dvh - 64px);
    margin-inline: calc(50% - 50cqw);
    margin-block: calc(-1 * var(--sp-5)) calc(-1 * var(--sp-5));
  }
  .panneau {
    grid-area: panneau;
    align-content: center;
    justify-items: center;
    padding: var(--sp-8) clamp(24px, 4vw, 56px);
    background: linear-gradient(180deg, rgb(255 255 255 / 0.03), rgb(255 255 255 / 0.008)), var(--surface-1);
    box-shadow: inset 1px 0 0 var(--hair);
  }
  .col {
    display: grid;
    gap: var(--sp-5);
    width: min(100%, 30rem);
    min-width: 0;
  }
  .panneau .titre {
    font-size: clamp(1.875rem, 1.5rem + 1vw, 2.25rem);
    font-weight: 680;
    font-stretch: 108%;
    letter-spacing: -0.025em;
    line-height: 1.1;
    text-align: start;
  }
  .panneau .sous {
    text-align: start;
  }

  /* Barre d'étapes (direction C) : quatre traits, l'étape en cours en menthe, les faites pleines.
     Placée sous le titre dans le DOM (le titre prend le focus), au-dessus à l'écran. */
  .rail {
    order: -1;
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: var(--sp-2);
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .rail li {
    display: grid;
    gap: var(--sp-2);
    min-width: 0;
    color: var(--text-3);
    font-size: 0.8125rem;
    line-height: 1.3;
  }
  .rail li::before {
    content: "";
    height: 3px;
    border-radius: 2px;
    background: var(--hair-2);
  }
  .rail li.fait::before {
    background: var(--accent);
  }
  .rail li.on {
    color: var(--text);
    font-weight: 600;
  }
  .rail li.on::before {
    background: linear-gradient(90deg, var(--accent) 50%, var(--hair-2) 50%);
  }
  .rail .n {
    margin-inline-end: 0.35em;
    font-family: var(--font-mono);
    font-weight: 500;
  }
  .rail li.on .n,
  .rail li.fait .n {
    color: var(--accent);
  }

  /* Scène : promesse, schéma, points forts. */
  .scene {
    grid-area: scene;
    position: relative;
    isolation: isolate;
    overflow: hidden;
    display: grid;
    align-content: center;
    gap: var(--sp-5);
    padding: var(--sp-8) clamp(40px, 6vw, 112px);
    background:
      radial-gradient(70% 60% at 20% 30%, rgb(95 227 181 / 0.1), transparent 70%),
      radial-gradient(60% 70% at 90% 90%, rgb(51 102 255 / 0.12), transparent 70%),
      var(--bg-deep);
  }
  /* Trame de points (celle du logo), qui s'efface vers la droite. */
  .scene::before {
    content: "";
    position: absolute;
    inset: 0;
    z-index: -1;
    background: radial-gradient(circle, rgb(233 236 242 / 0.1) 1.1px, transparent 1.6px) 0 0 / 14px 14px;
    -webkit-mask-image: radial-gradient(80% 80% at 30% 50%, #000 20%, transparent 75%);
    mask-image: radial-gradient(80% 80% at 30% 50%, #000 20%, transparent 75%);
    pointer-events: none;
  }
  .sur {
    display: inline-flex;
    align-items: center;
    gap: var(--sp-2);
    margin: 0;
    color: var(--accent);
    font-size: var(--fs-small);
    font-weight: 600;
  }
  .pt {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--accent);
    box-shadow: 0 0 0 4px rgb(95 227 181 / 0.15);
  }
  .promesse {
    margin: 0;
    max-width: 13ch;
    font-size: clamp(2.5rem, 1.2rem + 3.2vw, 4.25rem);
    font-weight: 700;
    font-stretch: var(--wd-display, 112%);
    letter-spacing: -0.035em;
    line-height: 1;
    text-wrap: balance;
  }
  .flux {
    display: grid;
    grid-template-columns: auto 1fr auto 1fr auto;
    align-items: start;
    gap: var(--sp-3);
    max-width: 560px;
    margin-top: var(--sp-5);
  }
  .noeud {
    display: grid;
    justify-items: center;
    gap: var(--sp-2);
    color: var(--text-2);
    font-size: 0.8125rem;
    text-align: center;
  }
  .ic {
    display: grid;
    place-items: center;
    width: 64px;
    height: 64px;
    border-radius: 18px;
    background: linear-gradient(180deg, #1a1f2a, #12151c);
    box-shadow:
      inset 0 0 0 1px var(--hair-2),
      var(--edge-hi),
      0 16px 32px -16px #000;
    color: var(--text);
  }
  .moi .ic {
    color: var(--accent);
    box-shadow:
      inset 0 0 0 1px rgb(95 227 181 / 0.35),
      0 0 0 6px rgb(95 227 181 / 0.06),
      0 16px 32px -16px #000;
  }
  /* Fil en pointillé, une enveloppe qui passe (arrêtée sous mouvement réduit). */
  .fil {
    position: relative;
    align-self: center;
    margin-top: -24px;
    height: 2px;
    background: repeating-linear-gradient(90deg, var(--line-strong) 0 4px, transparent 4px 9px);
    opacity: 0.7;
  }
  .fil b {
    position: absolute;
    top: 50%;
    left: 0;
    width: 26px;
    height: 18px;
    translate: 0 -50%;
    border-radius: 5px;
    background: var(--surface-3);
    box-shadow: inset 0 0 0 1px rgb(95 227 181 / 0.5);
    animation: passe 3.6s var(--ease-out) infinite;
  }
  .fil b::after {
    content: "";
    position: absolute;
    inset: 5px 8px;
    border-radius: 2px;
    background: repeating-linear-gradient(90deg, var(--accent) 0 2px, transparent 2px 4px);
    opacity: 0.8;
  }
  .fil + .noeud + .fil b {
    animation-delay: 1.8s;
  }
  @keyframes passe {
    0% {
      left: 0;
      opacity: 0;
    }
    15%,
    85% {
      opacity: 1;
    }
    100% {
      left: calc(100% - 26px);
      opacity: 0;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .fil b {
      animation: none;
      left: calc(50% - 13px);
    }
  }
  /* Trois points forts : pastille ronde (icône menthe), titre, une phrase. */
  .points {
    display: grid;
    gap: var(--sp-4);
    max-width: 34rem;
    margin: var(--sp-3) 0 0;
    padding: 0;
    list-style: none;
  }
  .points li {
    display: grid;
    grid-template-columns: auto 1fr;
    align-items: start;
    gap: var(--sp-4);
  }
  .pic {
    display: grid;
    place-items: center;
    width: 40px;
    height: 40px;
    border-radius: 50%;
    background: rgb(95 227 181 / 0.1);
    box-shadow: inset 0 0 0 1px rgb(95 227 181 / 0.3);
    color: var(--accent);
  }
  .ptx {
    display: grid;
    gap: 2px;
    padding-top: 2px;
  }
  .ptx strong {
    color: var(--text);
    font-weight: 600;
  }
  .pd {
    color: var(--text-2);
    font-size: var(--fs-small);
    line-height: 1.5;
    text-wrap: pretty;
  }

  /* Tablette et téléphone : la scène devient une bande courte au-dessus du formulaire : la
     promesse et les trois points forts en une ligne chacun (sans phrase ni schéma). */
  @media (max-width: 899px) {
    .deux {
      grid-template-columns: minmax(0, 1fr);
      grid-template-areas: "scene" "panneau";
      min-height: 0;
      margin-block-end: 0;
    }
    .scene {
      align-content: start;
      gap: var(--sp-3);
      padding: var(--sp-5) var(--sp-4) var(--sp-5);
    }
    .promesse {
      max-width: 22ch;
      font-size: 1.375rem;
      letter-spacing: -0.02em;
      line-height: 1.15;
    }
    .flux {
      gap: var(--sp-2);
      margin-top: var(--sp-1);
    }
    .ic {
      width: 48px;
      height: 48px;
      border-radius: 14px;
    }
    .ic :global(svg) {
      width: 22px;
      height: 22px;
    }
    .fil {
      margin-top: -22px;
    }
    .flux,
    .pd {
      display: none;
    }
    .points {
      gap: var(--sp-2);
      margin: 0;
    }
    .points li {
      align-items: center;
      gap: var(--sp-3);
    }
    .pic {
      width: 32px;
      height: 32px;
    }
    .pic :global(svg) {
      width: 16px;
      height: 16px;
    }
    .ptx {
      padding: 0;
      font-size: var(--fs-small);
    }
    .panneau {
      align-content: start;
      padding: var(--sp-5) var(--sp-4) var(--sp-7);
      box-shadow: inset 0 1px 0 var(--hair);
    }
    .panneau .titre {
      font-size: 1.75rem;
    }
  }
  @media (max-width: 599px) {
    .rail li .lib {
      font-size: 0.75rem;
    }
    /* Seule l'étape en cours garde son nom à l'écran ; les autres restent lues (texte masqué). */
    .rail li:not(.on) .lib {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip-path: inset(50%);
      white-space: nowrap;
    }
    .rail {
      grid-template-columns: 2fr 1fr 1fr 1fr;
    }
    .carte {
      margin-block: var(--sp-3) var(--sp-6);
      gap: var(--sp-4);
    }
  }

  /* ---------- Commun aux trois formes ---------- */
  .cadre :global(form) {
    display: grid;
    gap: var(--sp-5);
    min-width: 0;
  }
  .cadre :global(.liens) {
    display: flex;
    flex-wrap: wrap;
    gap: var(--sp-2) var(--sp-5);
    margin: 0;
    padding: 0;
    list-style: none;
  }
  /* Deux liens aux deux bords (connexion : « Mot de passe oublié » à gauche, « Créer un compte » à droite). */
  .cadre :global(.liens.split) {
    justify-content: space-between;
  }
  /* Liens en blanc, sans soulignement ; menthe au survol et au focus. */
  .cadre :global(.liens a),
  .cadre :global(a.lien),
  .cadre :global(a.lien-t) {
    display: inline-flex;
    align-items: center;
    min-height: 44px;
    color: var(--text);
    font-weight: 600;
    text-decoration: none;
    transition: color var(--dur-fast) var(--ease-out);
  }
  .cadre :global(.liens a:hover),
  .cadre :global(a.lien:hover),
  .cadre :global(a.lien-t:hover) {
    color: var(--accent);
  }
  .cadre :global(.liens a:focus-visible),
  .cadre :global(a.lien:focus-visible),
  .cadre :global(a.lien-t:focus-visible) {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
    border-radius: 4px;
  }
  /* Lien dans une phrase (« conditions d'utilisation ») : blanc et souligné, pas en gras ;
     hauteur de la ligne, pas de cible de 44 px qui décale le texte. */
  .cadre :global(a.lien-t) {
    position: relative;
    display: inline;
    min-height: 0;
    font-weight: inherit;
    text-decoration: underline;
    text-decoration-thickness: 1px;
    text-underline-offset: 3px;
  }
  /* Zone tactile de 44 px de haut sans décaler le texte : un
     pseudo-élément transparent déborde de la ligne, au-dessus et au-dessous. */
  .cadre :global(a.lien-t::after) {
    content: "";
    position: absolute;
    inset: 50% 0 auto;
    height: 44px;
    transform: translateY(-50%);
  }
  /* Autres chemins (connexion : clé de récupération, création ; inscription : « J'ai déjà un
     compte ») : séparateur « ou » (deux filets et le mot au milieu), puis des liens en forme de
     bouton secondaire, pleine largeur, icône menthe à gauche, texte centré. */
  .cadre :global(.ou) {
    display: flex;
    align-items: center;
    gap: var(--sp-3);
    margin: 0;
    color: var(--text-3);
    font-size: var(--fs-small);
  }
  .cadre :global(.ou::before),
  .cadre :global(.ou::after) {
    content: "";
    flex: 1;
    height: 1px;
    background: var(--hair-2);
  }
  .cadre :global(.autres) {
    display: grid;
    gap: var(--sp-3);
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .cadre :global(.autre) {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: var(--sp-2);
    min-height: 48px;
    padding: 0 20px;
    border: 1px solid var(--hair-2);
    border-radius: 12px;
    background: rgb(255 255 255 / 0.045);
    box-shadow: var(--edge-hi);
    color: var(--text);
    font-size: 0.9375rem;
    font-weight: 560;
    text-decoration: none;
    transition:
      background-color var(--dur-fast) var(--ease-out),
      border-color var(--dur-fast) var(--ease-out),
      color var(--dur-fast) var(--ease-out);
  }
  .cadre :global(.autre svg) {
    color: var(--accent);
  }
  @media (hover: hover) {
    .cadre :global(.autre:hover) {
      background: rgb(255 255 255 / 0.08);
      border-color: rgb(233 236 242 / 0.2);
    }
  }
  .cadre :global(.autre:focus-visible) {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  .cadre :global(.note) {
    margin: 0;
    color: var(--text-2);
  }
  .cadre :global(.actions) {
    display: flex;
    flex-wrap: wrap;
    gap: var(--sp-3);
  }
  .cadre :global(.actions > .btn) {
    flex: 1 1 auto;
  }
  @media (forced-colors: active) {
    .carte,
    .panneau {
      border: 1px solid CanvasText;
    }
    .cadre :global(.autre) {
      border-color: ButtonText;
    }
    .rail li::before,
    .rail li.on::before {
      background: CanvasText;
    }
  }
  @media (prefers-contrast: more) {
    .scene::before {
      display: none;
    }
  }
</style>
