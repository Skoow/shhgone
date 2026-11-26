<script lang="ts">
  // Vitrine du salon pour une personne sans session (« /salon/nouveau ») : copie statique et
  // visiblement fictive de l'écran d'un salon (Conversation.svelte, Piece.svelte : mêmes mesures,
  // mêmes bulles, mêmes couleurs de participants, §39.4 point 5), dans une fenêtre. Aucun moteur,
  // aucune requête, aucun module du salon : textes, heures et tailles seulement, formatés comme
  // dans le vrai salon. Lecteurs d'écran : un résumé, le détail est masqué (aria-hidden, inert) et
  // rien n'y prend le focus. Animation en CSS seulement (arrivée des messages, « écrit », onde),
  // arrêtée sous mouvement réduit.
  import { t, getLang } from "../../i18n/i18n.svelte";
  import { formatBytes, formatClock, formatDuration } from "../../i18n/format";
  import { FileArchive, FileText, Folder, Hourglass, Mic, Paperclip, Pause, Phone, SlidersHorizontal, Smile, Users, Video, Volume } from "../../ui/Icon";
  // Photos de profil : portraits illustrés, fictifs, fichiers du dépôt (assets/ à empreinte,
  // même origine) ; aucun service externe, aucune personne réelle.
  import photoCamille from "../../assets/salon/avatar-camille.svg";
  import photoNoe from "../../assets/salon/avatar-noe.svg";
  import photoInes from "../../assets/salon/avatar-ines.svg";
  import photoVous from "../../assets/salon/avatar-vous.svg";

  const lang = $derived(getLang());
  // Heures d'exemple : un soir, à la minute ; seules les heures sont montrées.
  const h = (m: number) => formatClock(new Date(2026, 10, 25, 21, m).getTime(), lang);
  // Participants d'exemple (pseudos) ; leur couleur de siège est la classe c0 à c3 (vrai salon : c0 à c9).
  // Inès est hors ligne depuis 12 min (pastille rouge et « vu il y a 12 min », comme le vrai salon).
  const CAMILLE = { nom: "Camille", photo: photoCamille };
  const NOE = { nom: "Noé", photo: photoNoe };
  const INES = { nom: "Inès", photo: photoInes };
  const vous = $derived(t("salon.room.you"));
  const membres = $derived([
    { c: "c1", nom: CAMILLE.nom, photo: photoCamille, en: true },
    { c: "c2", nom: NOE.nom, photo: photoNoe, en: true },
    { c: "c3", nom: INES.nom, photo: photoInes, en: false },
    { c: "c0", nom: vous, photo: photoVous, en: true },
  ]);
  const duree = $derived(formatDuration(15 * 60, lang));
  // Hauteurs de l'onde du vocal (fixes : aucune donnée réelle).
  const ONDE = [30, 55, 80, 45, 95, 70, 40, 85, 60, 35, 75, 100, 65, 45, 80, 55, 30, 70, 90, 50, 35, 60, 80, 40, 25, 55, 70, 35];
</script>

{#snippet avatar(p: { nom: string; photo: string })}
  <span class="gout"><img class="av" src={p.photo} alt="" width="32" height="32" /></span>
{/snippet}

<section class="vitrine" aria-label={t("salon.vitrine.label")} data-vitrine>
  <p class="sr-only">{t("salon.vitrine.resume")}</p>
  <div class="ecran" aria-hidden="true" inert data-ui>
    <span class="apercu" data-apercu>{t("salon.vitrine.apercu")}</span>
    <!-- En-tête compact (Conversation.svelte, .tete) : photos empilées, « Salon », état ou « écrit ». -->
    <div class="tete">
      <div class="ident">
        <span class="pile">
          <span class="pp c1"><img src={CAMILLE.photo} alt="" width="34" height="34" /></span>
          <span class="pp c2"><img src={NOE.photo} alt="" width="34" height="34" /></span>
          <span class="pp c3"><img src={INES.photo} alt="" width="34" height="34" /></span>
        </span>
        <div class="titre">
          <p class="h">{t("title.salon")}</p>
          <p class="etat">
            <span class="statut">
              <span>{t("salon.room.online", { n: 3 })}</span><span class="sep">·</span><span class="libres">{t("salon.room.free", { n: 2 })}</span><span class="sep libres">·</span>
              <span class="echeance"><Hourglass size={12} strokeWidth={2} /><span class="long">{t("salon.room.expires", { duree })}</span><span class="court">{duree}</span></span>
            </span>
            <span class="ecrit" data-ecrit>{t("salon.room.typing.un", { nom: NOE.nom })}</span>
          </p>
        </div>
      </div>
      <div class="boutons">
        <!-- Appels : réservés à Plus et Pro, dans leur cadre étiqueté (Conversation.svelte, .appels). -->
        <span class="appels" data-appels>
          <span class="badge">{t("salon.appel.badge")}</span>
          <span class="ic"><Phone size={20} /></span>
          <span class="ic"><Video size={20} /></span>
        </span>
        <span class="ic secondaire"><Volume size={20} /></span>
        <span class="ic secondaire"><Folder size={20} /></span>
        <span class="ic large"><Users size={20} /></span>
        <span class="ic"><SlidersHorizontal size={20} /></span>
      </div>
    </div>

    <!-- Participants (Conversation.svelte, .cote) : colonne sur grand écran, ligne ailleurs. -->
    <ul class="membres">
      {#each membres as m (m.c)}
        <li class={[m.c, { absent: !m.en }]}>
          <span class="pastille"><img src={m.photo} alt="" width="32" height="32" /><span class={["point", m.en ? "en" : "hors"]}></span></span>
          <span class="qui"><span class="nm">{m.nom}</span><span class="vu">{m.en ? t("salon.room.seen.online") : t("salon.room.seen.min", { n: 12 })}</span></span>
        </li>
      {/each}
    </ul>

    <div class="zone-fil">
      <ol class="fil">
        <li class="jour"><span>{t("salon.room.jour.today")}</span></li>
        <!-- Série d'Inès : photo et nom sur le premier message, puis l'archive, serrée dessous. -->
        <li class="msg c3 premier">
          {@render avatar(INES)}
          <div class="bulle">
            <span class="auteur">{INES.nom}</span>
            <p class="texte">{t("salon.vitrine.m1")}</p>
            <p class="meta"><time>{h(1)}</time></p>
          </div>
        </li>
        <li class="msg c3 dernier">
          <span class="gout"></span>
          <div class="bulle">
            <div class="piece fichier">
              <span class="ficone zip"><FileArchive size={20} /></span>
              <p class="fic"><span class="nom">{t("salon.vitrine.zip")}</span><span class="taille">{formatBytes(12.6 * 1024 * 1024, lang)}</span></p>
            </div>
            <p class="meta"><time>{h(1)}</time></p>
          </div>
        </li>
        <li class="msg moi c0 premier dernier">
          <div class="bulle">
            <div class="piece fichier">
              <span class="ficone pdf"><FileText size={20} /></span>
              <p class="fic"><span class="nom">{t("salon.vitrine.pdf")}</span><span class="taille">{formatBytes(184 * 1024, lang)}</span></p>
            </div>
            <p class="meta"><time>{h(2)}</time><span class="coche vu"><svg class="tic" viewBox="0 0 18 12" width="18" height="12" focusable="false"><path d="M1 6.6l2.9 2.9L10.5 2.9" /><path d="M7.6 9.2l.3.3L14.5 2.9" /></svg></span></p>
          </div>
        </li>
        <li class="msg c2 premier dernier">
          {@render avatar(NOE)}
          <div class="bulle">
            <span class="auteur">{NOE.nom}</span>
            <div class="vocal">
              <span class="lire"><Pause size={18} /></span>
              <span class="onde">{#each ONDE as v, i (i)}<i class="b{v}"></i>{/each}</span>
              <span class="duree">{formatDuration(12, lang, { precise: true })}</span>
            </div>
            <p class="meta"><time>{h(3)}</time></p>
          </div>
        </li>
        <li class="msg photo c1 premier">
          {@render avatar(CAMILLE)}
          <div class="bulle media">
            <span class="auteur">{CAMILLE.nom}</span>
            <div class="piece">
              <!-- Photo dessinée (plage au couchant) : aucune image réelle. -->
              <svg class="img" viewBox="0 0 240 132" focusable="false">
                <defs>
                  <linearGradient id="vitrine-soir" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0" stop-color="#2a2f6b" />
                    <stop offset="0.55" stop-color="#ff8fc7" />
                    <stop offset="1" stop-color="#ff9a7a" />
                  </linearGradient>
                  <linearGradient id="vitrine-mer" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0" stop-color="#4fd8e0" />
                    <stop offset="1" stop-color="#1b4b72" />
                  </linearGradient>
                </defs>
                <rect width="240" height="132" fill="url(#vitrine-soir)" />
                <circle cx="160" cy="74" r="20" fill="#f2c46d" />
                <rect y="76" width="240" height="56" fill="url(#vitrine-mer)" />
                <path d="M0 86 Q30 82 60 86 T120 86 T180 86 T240 86" stroke="#d8f3f5" stroke-opacity="0.5" fill="none" />
                <path d="M0 99 Q30 95 60 99 T120 99 T180 99 T240 99" stroke="#d8f3f5" stroke-opacity="0.3" fill="none" />
                <path d="M0 116 Q60 103 130 110 T240 106 V132 H0 Z" fill="#d9c3a0" />
              </svg>
              <p class="legende"><span class="nom">{t("salon.vitrine.photo")}</span><span class="sep">·</span><span class="taille">{formatBytes(2.4 * 1024 * 1024, lang)}</span></p>
            </div>
            <p class="meta"><time>{h(4)}</time></p>
          </div>
        </li>
        <li class="msg c1 dernier">
          <span class="gout"></span>
          <div class="bulle">
            <p class="texte">{t("salon.vitrine.m2")}</p>
            <p class="meta"><time>{h(4)}</time></p>
          </div>
        </li>
      </ol>
    </div>

    <!-- Saisie (Conversation.svelte, .saisie) : trombone, champ arrondi, micro rond. -->
    <div class="saisie">
      <span class="rond outil"><Paperclip size={22} /></span>
      <span class="champ"><span class="ph">{t("salon.room.placeholder")}</span><span class="emo"><Smile size={22} /></span></span>
      <span class="rond outil"><Mic size={22} /></span>
    </div>
  </div>
</section>

<style>
  /* Fond de la vitrine : celui de la scène des pages du compte (Cadre.svelte, « panneaux »). */
  .vitrine {
    position: relative;
    isolation: isolate;
    overflow: hidden;
    display: grid;
    align-content: center;
    justify-items: center;
    min-width: 0;
    padding: var(--sp-8) clamp(24px, 4vw, 72px);
    background:
      radial-gradient(70% 60% at 20% 30%, rgb(95 227 181 / 0.1), transparent 70%),
      radial-gradient(60% 70% at 90% 90%, rgb(51 102 255 / 0.12), transparent 70%),
      var(--bg-deep);
    /* Couleurs des participants et des bulles : celles de Conversation.svelte. */
    --p0: #5fe3b5;
    --p1: #7cc4ff;
    --p2: #b79cff;
    --p3: #ff8fc7;
    --b-autre: #1a1e29;
    --b-moi: #153a30;
    --b-moi-meta: #a9d4c4;
    --gout: 38px;
    --marge: 14px;
  }
  .vitrine::before {
    content: "";
    position: absolute;
    inset: 0;
    z-index: -1;
    background: radial-gradient(circle, rgb(233 236 242 / 0.1) 1.1px, transparent 1.6px) 0 0 / 14px 14px;
    -webkit-mask-image: radial-gradient(80% 80% at 30% 50%, #000 20%, transparent 75%);
    mask-image: radial-gradient(80% 80% at 30% 50%, #000 20%, transparent 75%);
    pointer-events: none;
  }
  /* L'écran du salon, dans une fenêtre : en-tête, colonne des participants, fil, saisie. */
  .ecran {
    position: relative;
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: auto auto minmax(0, 1fr) auto;
    grid-template-areas: "tete" "membres" "fil" "saisie";
    width: min(100%, 760px);
    /* Tient dans la fenêtre (sous la barre du site de 64 px) : le fil garde ses derniers messages. */
    height: clamp(540px, calc(100dvh - 64px - 2 * var(--sp-8)), 720px);
    box-sizing: border-box;
    border-radius: 20px;
    background: var(--bg);
    box-shadow:
      inset 0 0 0 1px var(--hair-2),
      0 40px 80px -40px rgb(0 0 0 / 0.9);
    user-select: none;
  }
  @media (min-width: 1100px) {
    .ecran {
      grid-template-columns: minmax(0, 1fr) 168px;
      grid-template-rows: auto minmax(0, 1fr) auto;
      grid-template-areas: "tete membres" "fil membres" "saisie membres";
    }
  }
  .apercu {
    position: absolute;
    top: -11px;
    inset-inline-start: 20px;
    z-index: 3;
    padding: 2px 10px;
    border-radius: 999px;
    background: var(--surface-2);
    box-shadow: inset 0 0 0 1px var(--hair-2);
    color: var(--text-2);
    font-size: var(--fs-micro, 0.75rem);
    font-weight: 600;
    letter-spacing: 0.02em;
  }
  .c0 { --pc: var(--p0); }
  .c1 { --pc: var(--p1); }
  .c2 { --pc: var(--p2); }
  .c3 { --pc: var(--p3); }

  /* ---------- En-tête compact (Conversation.svelte, .tete) ---------- */
  .tete {
    grid-area: tete;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--sp-3);
    min-width: 0;
    padding: 14px var(--marge) 10px;
    border-radius: 20px 20px 0 0;
    background: var(--surface-1);
    box-shadow: 0 1px 0 var(--hair);
  }
  @media (min-width: 1100px) {
    .tete {
      border-radius: 20px 0 0 0;
    }
  }
  .ident {
    display: flex;
    align-items: center;
    gap: var(--sp-3);
    min-width: 0;
  }
  .pile {
    display: flex;
    flex: none;
  }
  .pp {
    display: inline-flex;
    border-radius: 50%;
    box-shadow:
      0 0 0 1.5px var(--pc),
      0 0 0 3.5px var(--surface-1);
  }
  .pp + .pp {
    margin-inline-start: -14px;
  }
  .pp img {
    display: block;
    width: 34px;
    height: 34px;
    border-radius: 50%;
  }
  .titre {
    min-width: 0;
  }
  .h {
    margin: 0;
    font-size: 1.0625rem;
    font-weight: 650;
    line-height: 1.25;
  }
  .etat {
    display: grid;
    margin: 1px 0 0;
    color: var(--text-2);
    font-size: 0.8125rem;
    line-height: 1.2rem;
    white-space: nowrap;
  }
  .statut,
  .ecrit {
    grid-area: 1 / 1;
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    overflow: hidden;
  }
  .sep {
    color: var(--text-3);
  }
  .echeance {
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }
  .echeance :global(svg) {
    flex: none;
    color: var(--text-3);
  }
  .court {
    display: none;
  }
  /* « Noé écrit… » prend la place de l'état, comme dans le vrai salon. */
  .ecrit {
    color: var(--accent);
    opacity: 0;
  }
  .boutons {
    display: flex;
    align-items: center;
    gap: 2px;
    flex: none;
  }
  .ic {
    display: inline-grid;
    place-items: center;
    width: 40px;
    height: 40px;
    border-radius: 12px;
    color: var(--text-2);
  }
  .large {
    display: none;
  }
  @media (min-width: 1100px) {
    .large {
      display: inline-grid;
      background: rgb(255 255 255 / 0.07);
      color: var(--text);
    }
  }
  /* Appels réservés à Plus et Pro (Conversation.svelte, .appels.reserve). */
  .appels {
    position: relative;
    display: flex;
    gap: 2px;
    margin-inline-end: 6px;
    padding: 3px;
    border-radius: 14px;
    background: linear-gradient(135deg, rgb(62 193 245 / 0.08), rgb(92 128 255 / 0.1));
    box-shadow: inset 0 0 0 1px rgb(92 160 255 / 0.42);
  }
  .appels .ic {
    color: #b8d9ff;
  }
  .badge {
    position: absolute;
    top: 0;
    left: 50%;
    translate: -50% -58%;
    padding: 0 7px;
    border-radius: 999px;
    background: linear-gradient(90deg, var(--plus-tint), var(--pro-tint));
    box-shadow:
      inset 0 0 0 1px rgb(92 160 255 / 0.55),
      0 0 0 2px var(--surface-1);
    color: #d6e9ff;
    font-size: 0.625rem;
    font-weight: 700;
    line-height: 0.9375rem;
    letter-spacing: 0.02em;
    white-space: nowrap;
  }

  /* ---------- Participants (Conversation.svelte, .cote) ---------- */
  .membres {
    grid-area: membres;
    display: flex;
    gap: var(--sp-4);
    margin: 0;
    padding: 6px var(--marge);
    list-style: none;
    background: var(--surface-1);
    box-shadow: 0 1px 0 var(--hair);
    overflow: hidden;
  }
  .membres li {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    flex: none;
    min-width: 0;
  }
  .qui {
    display: grid;
    min-width: 0;
    line-height: 1.2;
  }
  .nm {
    color: var(--text);
    text-transform: capitalize;
    font-size: 0.8125rem;
    font-weight: 600;
  }
  .vu {
    color: var(--text-2);
    font-size: 0.75rem;
  }
  .absent .nm {
    color: var(--text-2);
  }
  @media (min-width: 1100px) {
    .membres {
      flex-direction: column;
      gap: var(--sp-3);
      padding: 18px var(--sp-3);
      border-radius: 0 20px 20px 0;
      box-shadow: inset 1px 0 0 var(--hair);
    }
  }
  /* Photo de profil ronde, liseré de la couleur du participant ; pastille verte (en ligne) ou
     rouge (hors ligne), le texte à côté le dit aussi (jamais la couleur seule). */
  .pastille {
    position: relative;
    flex: none;
    width: 32px;
    height: 32px;
    border-radius: 50%;
    box-shadow: 0 0 0 1.5px var(--pc);
  }
  .pastille img {
    display: block;
    width: 100%;
    height: 100%;
    border-radius: 50%;
  }
  .point {
    position: absolute;
    right: -2px;
    bottom: -2px;
    width: 11px;
    height: 11px;
    border-radius: 50%;
    box-shadow: 0 0 0 2px var(--surface-1);
  }
  .point.en {
    background: var(--accent);
  }
  .point.hors {
    background: #ff5f5f;
  }
  .absent .pastille img {
    filter: saturate(0.55);
    opacity: 0.8;
  }

  /* ---------- Fil (Conversation.svelte, .zone-fil, .msg, .bulle) ---------- */
  .zone-fil {
    grid-area: fil;
    min-height: 0;
    overflow: hidden;
    background:
      radial-gradient(circle, rgb(233 236 242 / 0.035) 1px, transparent 1.5px) 0 0 / 18px 18px,
      #090b10;
  }
  /* Le fil se pose en bas ; s'il manque de place, il est coupé en haut, en fondu, comme une
     conversation déjà commencée. */
  .fil {
    display: flex;
    flex-direction: column;
    justify-content: flex-end;
    height: 100%;
    box-sizing: border-box;
    margin: 0;
    padding: var(--sp-2) var(--marge) var(--sp-3);
    list-style: none;
    -webkit-mask-image: linear-gradient(180deg, transparent 0, #000 28px);
    mask-image: linear-gradient(180deg, transparent 0, #000 28px);
  }
  .fil > li {
    flex: none;
  }
  .jour {
    align-self: center;
    margin: var(--sp-2) 0 2px;
  }
  .jour span {
    display: inline-block;
    padding: 3px 10px;
    border-radius: 999px;
    background: rgb(26 30 41 / 0.92);
    box-shadow: inset 0 0 0 1px var(--hair);
    color: var(--text-2);
    font-size: 0.75rem;
    font-weight: 560;
    line-height: 1.1rem;
  }
  .msg {
    display: flex;
    align-items: flex-start;
    max-width: 100%;
    margin-top: 10px;
  }
  .msg:not(.premier) {
    margin-top: 2px;
  }
  .msg.moi {
    flex-direction: row-reverse;
  }
  .gout {
    flex: none;
    width: var(--gout);
  }
  .av {
    display: block;
    width: 32px;
    height: 32px;
    border-radius: 50%;
    box-shadow: 0 0 0 1.5px var(--pc);
  }
  /* Bulles : coins de 18 px, resserrés du côté de l'auteur entre deux messages d'une série. */
  .bulle {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    column-gap: var(--sp-2);
    min-width: 0;
    max-width: min(78%, 26rem);
    padding: 7px 12px 6px;
    border-radius: 18px;
    border-start-start-radius: 6px;
    border-end-start-radius: 6px;
    background: var(--b-autre);
    box-shadow: inset 0 0 0 1px var(--hair);
    overflow-wrap: anywhere;
  }
  .premier .bulle {
    border-start-start-radius: 18px;
  }
  .moi .bulle {
    border-radius: 18px;
    border-start-end-radius: 6px;
    border-end-end-radius: 6px;
    background: var(--b-moi);
    box-shadow: inset 0 0 0 1px rgb(95 227 181 / 0.12);
  }
  .moi.premier .bulle {
    border-start-end-radius: 18px;
  }
  .bulle > * {
    flex-basis: 100%;
  }
  .bulle > .texte,
  .bulle > .meta {
    flex-basis: auto;
  }
  .bulle > .meta {
    margin-inline-start: auto;
  }
  .bulle.media {
    display: block;
    width: fit-content;
    padding: 4px 4px 6px;
  }
  .bulle.media > .auteur,
  .bulle.media > .meta {
    margin-inline: 8px;
  }
  .bulle.media .legende {
    padding-inline: 8px;
  }
  .auteur {
    display: block;
    margin-bottom: 1px;
    color: var(--pc);
    font-weight: 650;
    font-size: 0.8125rem;
    line-height: 1.1rem;
  }
  .texte {
    margin: 0;
    line-height: 1.4;
  }
  .meta {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 4px;
    margin: 2px 0 0;
    color: var(--text-3);
    font-size: 0.6875rem;
    line-height: 1rem;
    white-space: nowrap;
  }
  .moi .meta {
    color: var(--b-moi-meta);
  }
  .coche {
    display: inline-flex;
  }
  .coche.vu {
    color: #6cb6ff; /* lu : deux coches bleues, comme le vrai salon */
  }
  .tic {
    display: block;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.6;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  /* ---------- Pièces (Piece.svelte) ---------- */
  .piece {
    display: grid;
    gap: var(--sp-1);
    min-width: 0;
  }
  .img {
    display: block;
    width: 200px;
    max-width: 100%;
    height: auto;
    border-radius: 14px;
    background: var(--surface-3);
  }
  .fic {
    display: grid;
    margin: 0;
  }
  /* Photo (Piece.svelte, .legende) : une ligne discrète sous la vignette, nom coupé puis taille. */
  .legende {
    display: flex;
    align-items: baseline;
    gap: 6px;
    width: 0;
    min-width: 100%;
    box-sizing: border-box;
    margin: 0;
    color: var(--text-2);
    font-size: 0.75rem;
    line-height: 1rem;
    white-space: nowrap;
  }
  .legende .nom {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    font-weight: 500;
  }
  .legende .sep,
  .legende .taille {
    flex: none;
    color: var(--text-3);
    font-size: inherit;
  }
  .nom {
    font-weight: 560;
  }
  .taille {
    color: var(--text-2);
    font-size: 0.8125rem;
  }
  .fichier {
    grid-template-columns: auto minmax(0, 1fr);
    align-items: center;
    column-gap: var(--sp-3);
    padding-top: 2px;
  }
  .ficone {
    display: grid;
    place-items: center;
    width: 38px;
    height: 38px;
    border-radius: 10px;
    background: rgb(255 255 255 / 0.06);
  }
  .ficone.pdf {
    color: var(--p3);
  }
  .ficone.zip {
    color: #f2c46d;
  }
  .vocal {
    display: flex;
    align-items: center;
    gap: var(--sp-3);
    min-width: min(100%, 260px);
    padding-top: 2px;
  }
  .lire {
    display: grid;
    place-items: center;
    flex: none;
    width: 36px;
    height: 36px;
    border-radius: 50%;
    background: var(--pc);
    color: var(--on-fmt, #0b0d12);
  }
  .onde {
    display: flex;
    align-items: center;
    gap: 2px;
    flex: 1;
    height: 30px;
  }
  .onde i {
    flex: 1;
    min-width: 2px;
    max-width: 4px;
    border-radius: 2px;
    background: var(--pc);
    opacity: 0.85;
    transform-origin: center;
    animation: onde 1.1s ease-in-out infinite alternate;
  }
  /* Lecture en cours : la partie déjà lue bouge, le reste attend, plus pâle. */
  .onde i:nth-child(n + 11) {
    opacity: 0.4;
    animation: none;
  }
  .onde i:nth-child(3n) {
    animation-delay: -0.35s;
  }
  .onde i:nth-child(3n + 1) {
    animation-delay: -0.7s;
  }
  .onde i:nth-child(4n) {
    animation-duration: 0.9s;
  }
  .b25 { height: 25%; }
  .b30 { height: 30%; }
  .b35 { height: 35%; }
  .b40 { height: 40%; }
  .b45 { height: 45%; }
  .b50 { height: 50%; }
  .b55 { height: 55%; }
  .b60 { height: 60%; }
  .b65 { height: 65%; }
  .b70 { height: 70%; }
  .b75 { height: 75%; }
  .b80 { height: 80%; }
  .b85 { height: 85%; }
  .b90 { height: 90%; }
  .b95 { height: 95%; }
  .b100 { height: 100%; }
  .duree {
    color: var(--text-2);
    font-size: 0.8125rem;
    font-variant-numeric: tabular-nums;
  }
  @keyframes onde {
    from {
      transform: scaleY(0.45);
    }
    to {
      transform: scaleY(1);
    }
  }

  /* ---------- Saisie (Conversation.svelte, .saisie) ---------- */
  .saisie {
    grid-area: saisie;
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    padding: 10px var(--marge) 12px;
    border-radius: 0 0 20px 20px;
    background: var(--surface-1);
    box-shadow: 0 -1px 0 var(--hair);
  }
  @media (min-width: 1100px) {
    .saisie {
      border-radius: 0 0 0 20px;
    }
  }
  .rond {
    display: grid;
    place-items: center;
    flex: none;
    width: 44px;
    height: 44px;
    border-radius: 50%;
    color: var(--text-2);
  }
  .champ {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    min-height: 44px;
    padding-inline-start: 16px;
    border-radius: 22px;
    background: var(--surface-3);
    box-shadow: inset 0 0 0 1px var(--hair-2);
    color: var(--text-3);
  }
  .ph {
    flex: 1;
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .emo {
    display: grid;
    place-items: center;
    flex: none;
    width: 44px;
    height: 44px;
    color: var(--text-2);
  }

  /* ---------- Arrivée des derniers messages, un par un (une fois) ---------- */
  /* Le début de la conversation est là d'emblée (jamais d'écran vide) ; seuls les deux derniers
     messages arrivent, puis « Noé écrit… » prend la place de l'état dans l'en-tête. */
  .fil > li:nth-last-child(-n + 2) {
    animation: arrive 0.4s cubic-bezier(0.22, 1, 0.36, 1) both;
  }
  .fil > li:nth-last-child(2) { animation-delay: 0.5s; }
  .fil > li:nth-last-child(1) { animation-delay: 1.5s; }
  .statut {
    animation: sort 0.3s ease-out 2.4s both;
  }
  .ecrit {
    animation: entre 0.3s ease-out 2.4s both;
  }
  @keyframes arrive {
    from {
      opacity: 0;
      transform: translateY(8px);
      filter: blur(2px);
    }
    to {
      opacity: 1;
      transform: none;
      filter: none;
    }
  }
  @keyframes sort {
    to {
      opacity: 0;
    }
  }
  @keyframes entre {
    from {
      opacity: 0;
    }
    to {
      opacity: 1;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .fil > li:nth-last-child(-n + 2),
    .onde i {
      animation: none;
    }
    /* Sans mouvement : l'état reste affiché, « écrit » n'apparaît pas. */
    .statut,
    .ecrit {
      animation: none;
    }
  }

  /* ---------- Tablette et téléphone : au-dessus du bloc d'action, en plus court ---------- */
  @media (max-width: 899px) {
    .vitrine {
      padding: var(--sp-6) var(--sp-4) var(--sp-5);
    }
    .ecran {
      height: auto;
    }
    /* Plus court : le fil ne garde que ses derniers messages. */
    .zone-fil {
      max-height: 380px;
    }
  }
  @media (max-width: 599px) {
    .vitrine {
      --gout: 36px;
      --marge: 10px;
    }
    /* Téléphone : photos seules dans la ligne des participants ; boutons secondaires masqués,
       comme la place le demande ; une vignette plus petite. */
    .img {
      width: 150px;
    }
    .qui {
      display: none;
    }
    .membres {
      gap: var(--sp-2);
    }
    .zone-fil {
      max-height: 330px;
    }
    .pp:nth-child(3),
    .libres,
    .secondaire {
      display: none;
    }
    .long {
      display: none;
    }
    .court {
      display: inline;
    }
    .tete {
      gap: var(--sp-2);
    }
  }
  @media (forced-colors: active) {
    .bulle,
    .ecran,
    .appels,
    .badge {
      border: 1px solid CanvasText;
    }
  }
</style>
