<script lang="ts">
  // Vitrine du salon pour une personne sans session (« /salon/nouveau ») : copie statique et
  // visiblement fictive de l'écran d'un salon (Conversation.svelte, Piece.svelte, Membres.svelte :
  // mêmes mesures et mêmes couleurs de participants, §39.4 point 5). Aucun moteur, aucune requête,
  // aucun module du salon : textes, heures et tailles seulement, formatés comme dans le vrai salon.
  // Lecteurs d'écran : un résumé, le détail est masqué (aria-hidden, inert) et rien n'y prend le focus.
  // Animation en CSS seulement (arrivée des messages, saisie, onde), arrêtée sous mouvement réduit.
  import { t, getLang } from "../../i18n/i18n.svelte";
  import { formatBytes, formatClock, formatDuration } from "../../i18n/format";
  import { FileArchive, FileText, Folder, Mic, Paperclip, Pause, Phone, Video } from "../../ui/Icon";

  const lang = $derived(getLang());
  // Heures d'exemple : un soir, à la minute ; seules les heures sont montrées.
  const h = (m: number) => formatClock(new Date(2026, 10, 25, 21, m).getTime(), lang);
  // Participants d'exemple (pseudos) ; leur couleur de siège est la classe c0 à c3 (vrai salon : c0 à c9).
  const CAMILLE = { nom: "Camille" };
  const NOE = { nom: "Noé" };
  const INES = { nom: "Inès" };
  const vous = $derived(t("salon.room.you"));
  // Hauteurs de l'onde du vocal (fixes : aucune donnée réelle).
  const ONDE = [30, 55, 80, 45, 95, 70, 40, 85, 60, 35, 75, 100, 65, 45, 80, 55, 30, 70, 90, 50, 35, 60, 80, 40, 25, 55, 70, 35];
</script>

<section class="vitrine" aria-label={t("salon.vitrine.label")} data-vitrine>
  <p class="sr-only">{t("salon.vitrine.resume")}</p>
  <div class="ecran" aria-hidden="true" inert data-ui>
    <span class="apercu" data-apercu>{t("salon.vitrine.apercu")}</span>
    <div class="tete">
      <div class="titre">
        <p class="h">{t("title.salon")}</p>
        <p class="etat">
          <span>{t("salon.room.online", { n: 4 })}</span> · <span>{t("salon.room.free", { n: 2 })}</span> ·
          <span>{t("salon.room.expires", { duree: formatDuration(15 * 60, lang) })}</span>
        </p>
      </div>
      <div class="boutons">
        <span class="appels" data-appels>
          <span class="duo">
            <span class="ib"><Phone size={20} /></span>
            <span class="ib"><Video size={20} /></span>
          </span>
          <span class="reserve">{t("salon.vitrine.appels")}</span>
        </span>
        <span class="bt"><Folder size={20} /><span class="lib">{t("salon.files.title")}</span></span>
      </div>
    </div>

    <div class="corps">
      <div class="col">
        <ol class="fil">
          <li class="msg c3">
            <div class="bulle">
              <span class="auteur">{INES.nom}</span>
              <p class="texte">{t("salon.vitrine.m1")}</p>
              <p class="meta"><time>{h(1)}</time></p>
            </div>
          </li>
          <li class="msg c3">
            <div class="bulle">
              <span class="auteur">{INES.nom}</span>
              <div class="piece fichier">
                <span class="ficone zip"><FileArchive size={20} /></span>
                <p class="fic"><span class="nom">{t("salon.vitrine.zip")}</span><span class="taille">{formatBytes(12.6 * 1024 * 1024, lang)}</span></p>
                <span class="enr">{t("salon.piece.enregistrer")}</span>
              </div>
              <p class="meta"><time>{h(1)}</time></p>
            </div>
          </li>
          <li class="msg moi c0">
            <div class="bulle">
              <div class="piece fichier">
                <span class="ficone pdf"><FileText size={20} /></span>
                <p class="fic"><span class="nom">{t("salon.vitrine.pdf")}</span><span class="taille">{formatBytes(184 * 1024, lang)}</span></p>
                <span class="enr">{t("salon.piece.enregistrer")}</span>
              </div>
              <p class="meta"><time>{h(2)}</time><span class="coche vu">· {t("salon.room.tick.vu")}</span></p>
            </div>
          </li>
          <li class="msg c2">
            <div class="bulle">
              <span class="auteur">{NOE.nom}</span>
              <div class="vocal">
                <span class="lire"><Pause size={18} /></span>
                <span class="onde">{#each ONDE as v}<i class="b{v}"></i>{/each}</span>
                <span class="duree">{formatDuration(12, lang, { precise: true })}</span>
              </div>
              <p class="meta"><time>{h(3)}</time></p>
            </div>
          </li>
          <li class="msg photo c1">
            <div class="bulle">
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
                <p class="fic"><span class="nom">{t("salon.vitrine.photo")}</span><span class="taille">{formatBytes(2.4 * 1024 * 1024, lang)}</span></p>
              </div>
              <p class="meta"><time>{h(4)}</time></p>
            </div>
          </li>
          <li class="msg c1">
            <div class="bulle">
              <span class="auteur">{CAMILLE.nom}</span>
              <p class="texte">{t("salon.vitrine.m2")}</p>
              <p class="meta"><time>{h(4)}</time></p>
            </div>
          </li>
        </ol>
        <p class="ecrit" data-ecrit><span>{t("salon.room.typing.un", { nom: NOE.nom })}</span><span class="points"><i></i><i></i><i></i></span></p>

        <div class="saisie">
          <p class="fin-proche" data-fin>{t("salon.fin.alerte", { n: 15 })}</p>
          <div class="ligne">
            <span class="emo">☺</span>
            <span class="emo"><Paperclip size={20} /></span>
            <span class="emo"><Mic size={20} /></span>
            <span class="champ">{t("salon.room.placeholder")}</span>
            <span class="envoyer">{t("salon.room.send")}</span>
          </div>
        </div>
      </div>

      <!-- Membres (Membres.svelte) : pastille (photo dessinée ou initiale), point « en ligne ». -->
      <ul class="membres">
        <li class="c1">
          <span class="pastille">
            <svg viewBox="0 0 40 40" width="100%" height="100%" focusable="false">
              <defs>
                <linearGradient id="vitrine-ciel" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0" stop-color="#7cc4ff" />
                  <stop offset="1" stop-color="#b79cff" />
                </linearGradient>
              </defs>
              <rect width="40" height="40" fill="url(#vitrine-ciel)" />
              <circle cx="27" cy="14" r="6" fill="#f2c46d" />
              <path d="M0 30 L12 18 L20 25 L27 19 L40 31 V40 H0 Z" fill="#1d2b3a" />
              <path d="M0 34 L10 27 L18 32 L28 26 L40 34 V40 H0 Z" fill="#12202c" />
            </svg>
            <span class="point"></span>
          </span>
          <span class="qui"><span class="nm">{CAMILLE.nom}</span><span class="vu">{t("salon.room.seen.online")}</span></span>
        </li>
        <li class="c2"><span class="pastille">N<span class="point"></span></span><span class="qui"><span class="nm">{NOE.nom}</span><span class="vu">{t("salon.room.seen.online")}</span></span></li>
        <li class="c3"><span class="pastille">I<span class="point"></span></span><span class="qui"><span class="nm">{INES.nom}</span><span class="vu">{t("salon.room.seen.online")}</span></span></li>
        <li class="c0"><span class="pastille">{[...vous][0]?.toLocaleUpperCase()}<span class="point"></span></span><span class="qui"><span class="nm">{vous}</span><span class="vu">{t("salon.room.seen.online")}</span></span></li>
      </ul>
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
    padding: var(--sp-5) clamp(24px, 4vw, 72px) var(--sp-4);
    background:
      radial-gradient(70% 60% at 20% 30%, rgb(95 227 181 / 0.1), transparent 70%),
      radial-gradient(60% 70% at 90% 90%, rgb(51 102 255 / 0.12), transparent 70%),
      var(--bg-deep);
    /* Couleurs des participants : celles de Conversation.svelte (≥ 6,7:1 sur --surface-3). */
    --p0: #5fe3b5;
    --p1: #7cc4ff;
    --p2: #b79cff;
    --p3: #ff8fc7;
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
  /* L'écran du salon, dans une fenêtre : fond de la page, bord fin. */
  .ecran {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: var(--sp-2);
    width: min(100%, 780px);
    /* Tient dans la fenêtre (sous la barre du site de 64 px) : le fil garde ses derniers messages. */
    height: max(600px, calc(100dvh - 64px - var(--sp-5) - var(--sp-4)));
    box-sizing: border-box;
    padding: var(--sp-3) var(--sp-4) 0;
    border-radius: 20px;
    background: var(--bg);
    box-shadow:
      inset 0 0 0 1px var(--hair-2),
      0 40px 80px -40px rgb(0 0 0 / 0.9);
    user-select: none;
  }
  .apercu {
    position: absolute;
    top: -11px;
    inset-inline-start: 20px;
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

  /* ---------- En-tête (Conversation.svelte, .tete) ---------- */
  .tete {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--sp-3);
    padding-block: var(--sp-2) var(--sp-3);
    border-bottom: 1px solid var(--line);
  }
  .titre {
    min-width: 0;
  }
  .h {
    margin: 0;
    font-size: var(--fs-title, 1.25rem);
    font-weight: 700;
  }
  .etat {
    margin: 0;
    color: var(--text-2);
    font-size: 0.875rem;
  }
  .boutons {
    display: flex;
    align-items: flex-start;
    gap: var(--sp-2);
  }
  .appels {
    display: grid;
    justify-items: center;
    gap: 2px;
  }
  .duo {
    display: flex;
    gap: var(--sp-2);
  }
  .reserve {
    color: var(--text-2);
    font-size: 0.75rem;
    line-height: 1.2;
    white-space: nowrap;
  }
  .ib,
  .bt {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: var(--sp-2);
    min-width: 44px;
    height: 44px;
    border: 1px solid var(--hair-2);
    border-radius: 10px;
    background: rgb(255 255 255 / 0.045);
    color: var(--text);
    box-sizing: border-box;
  }
  .bt {
    padding: 0 14px;
    box-shadow: var(--edge-hi);
    font-size: var(--fs-small);
    font-weight: 560;
  }
  .ib :global(svg),
  .bt :global(svg) {
    flex: none;
  }

  /* ---------- Corps : conversation et membres (Conversation.svelte, .corps) ---------- */
  /* Étroit : les membres en une ligne au-dessus du fil. Large (comme le vrai salon à partir de
     1100 px) : en colonne à droite. */
  .corps {
    flex: 1 1 auto;
    min-height: 0;
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: auto minmax(0, 1fr);
    gap: var(--sp-2) var(--sp-4);
  }
  .col {
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: var(--sp-2);
  }
  @media (min-width: 1100px) {
    .corps {
      grid-template-columns: minmax(0, 1fr) 132px;
      grid-template-rows: minmax(0, 1fr);
    }
  }

  /* ---------- Membres (Membres.svelte, .pastille) ---------- */
  .membres {
    order: -1;
    display: flex;
    flex-wrap: wrap;
    gap: var(--sp-2) var(--sp-4);
    margin: 0;
    padding: var(--sp-2) 0 0;
    list-style: none;
  }
  .membres li {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    min-width: 0;
    font-size: 0.8125rem;
  }
  .qui {
    display: grid;
    min-width: 0;
  }
  .nm {
    color: var(--text);
    font-weight: 600;
    text-transform: capitalize;
  }
  .vu {
    display: none;
    color: var(--text-3);
    font-size: 0.75rem;
  }
  @media (min-width: 1100px) {
    .membres {
      order: 0;
      flex-direction: column;
      flex-wrap: nowrap;
      align-content: start;
      gap: var(--sp-3);
      padding: var(--sp-3) 0 0 var(--sp-4);
      border-inline-start: 1px solid var(--line);
    }
    .vu {
      display: block;
    }
  }
  .pastille {
    position: relative;
    display: inline-grid;
    place-items: center;
    width: 32px;
    height: 32px;
    border-radius: 50%;
    background: var(--pc);
    color: var(--on-fmt, #0b0d12);
    font-weight: 700;
    font-size: 0.875rem;
  }
  .pastille svg {
    border-radius: 50%;
  }
  .point {
    position: absolute;
    right: -1px;
    bottom: -1px;
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: var(--accent);
    box-shadow: 0 0 0 2px var(--bg);
  }

  /* ---------- Fil (Conversation.svelte, .fil, .msg, .bulle) ---------- */
  /* Le fil prend la hauteur qui reste ; s'il manque de place, il est coupé en haut, en fondu,
     comme une conversation déjà commencée. */
  .fil {
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
    flex-direction: column;
    justify-content: flex-end;
    gap: var(--sp-2);
    margin: 0;
    padding: var(--sp-2) 0;
    overflow: hidden;
    list-style: none;
    -webkit-mask-image: linear-gradient(180deg, transparent 0, #000 28px);
    mask-image: linear-gradient(180deg, transparent 0, #000 28px);
  }
  .fil > li {
    flex: none;
  }
  .msg {
    display: flex;
    max-width: min(86%, 560px);
  }
  .msg.moi {
    align-self: flex-end;
  }
  .bulle {
    min-width: 0;
    padding: var(--sp-2) var(--sp-3);
    border-radius: 14px;
    background: var(--surface-1);
    border-inline-start: 3px solid var(--pc, var(--line));
    overflow-wrap: anywhere;
  }
  .moi .bulle {
    background: var(--surface-2);
    border-inline-start: 0;
    border-inline-end: 3px solid var(--accent);
  }
  .auteur {
    display: block;
    color: var(--pc);
    font-weight: 600;
    font-size: 0.8125rem;
  }
  .texte {
    margin: 0;
  }
  .meta {
    display: flex;
    gap: var(--sp-1);
    margin: var(--sp-1) 0 0;
    color: var(--text-3);
    font-size: 0.75rem;
  }
  .coche.vu {
    color: var(--accent);
  }

  /* ---------- Pièces (Piece.svelte) ---------- */
  .piece {
    display: grid;
    gap: var(--sp-1);
    min-width: 0;
  }
  .img {
    display: block;
    width: 164px;
    max-width: 100%;
    height: auto;
    border-radius: 10px;
    background: var(--surface-3);
  }
  .fic {
    display: flex;
    flex-wrap: wrap;
    gap: 0 var(--sp-2);
    margin: 0;
  }
  .nom {
    font-weight: 560;
  }
  .taille {
    color: var(--text-2);
    font-size: 0.8125rem;
  }
  .fichier {
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: center;
    column-gap: var(--sp-3);
  }
  .fichier .fic {
    display: grid;
  }
  .ficone {
    display: grid;
    place-items: center;
    width: 36px;
    height: 36px;
    border-radius: 10px;
    background: var(--surface-3);
  }
  .ficone.pdf {
    color: var(--p3);
  }
  .ficone.zip {
    color: var(--p5, #f2c46d);
  }
  .enr {
    display: inline-flex;
    align-items: center;
    min-height: 36px;
    padding: 0 12px;
    border-radius: 10px;
    color: var(--text);
    font-size: var(--fs-small);
    font-weight: 560;
  }
  .vocal {
    display: flex;
    align-items: center;
    gap: var(--sp-3);
    min-width: min(100%, 280px);
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

  /* ---------- Saisie en cours et bas de l'écran ---------- */
  .ecrit {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    min-height: 1.25rem;
    margin: 0;
    color: var(--text-2);
    font-size: 0.8125rem;
  }
  .points {
    display: inline-flex;
    gap: 3px;
  }
  .points i {
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: var(--p2);
    animation: tape 1.2s ease-in-out infinite;
  }
  .points i:nth-child(2) {
    animation-delay: 0.2s;
  }
  .points i:nth-child(3) {
    animation-delay: 0.4s;
  }
  @keyframes tape {
    0%,
    60%,
    100% {
      opacity: 0.35;
      transform: translateY(0);
    }
    30% {
      opacity: 1;
      transform: translateY(-3px);
    }
  }
  .saisie {
    display: grid;
    gap: var(--sp-2);
    padding: var(--sp-2) 0 var(--sp-3);
    border-top: 1px solid var(--line);
  }
  .fin-proche {
    margin: 0;
    padding: var(--sp-2) var(--sp-3);
    border-radius: 10px;
    background: var(--warn-tint);
    color: var(--warn);
    font-weight: 600;
    font-size: 0.875rem;
  }
  .ligne {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
  }
  .emo {
    display: grid;
    place-items: center;
    flex: none;
    width: 44px;
    height: 44px;
    border-radius: 12px;
    background: var(--surface-2);
    color: var(--text);
    font-size: 1.25rem;
  }
  .champ {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    min-height: 44px;
    padding: 0 var(--sp-3);
    border: 1px solid var(--line-strong);
    border-radius: 12px;
    background: var(--surface-1);
    color: var(--text-3);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .envoyer {
    display: inline-flex;
    align-items: center;
    flex: none;
    min-height: 44px;
    padding: 0 14px;
    border-radius: 10px;
    background: var(--accent);
    color: var(--on-accent);
    font-size: var(--fs-small);
    font-weight: 560;
  }

  /* ---------- Arrivée des derniers messages, un par un (une fois) ---------- */
  /* Le début de la conversation est là d'emblée (jamais d'écran vide) ; seuls les deux derniers
     messages puis « … écrit » arrivent : une montée courte, sans rebond. */
  .fil > li:nth-last-child(-n + 2),
  .ecrit {
    animation: arrive 0.4s cubic-bezier(0.22, 1, 0.36, 1) both;
  }
  .fil > li:nth-last-child(2) { animation-delay: 0.5s; }
  .fil > li:nth-last-child(1) { animation-delay: 1.5s; }
  .ecrit { animation-delay: 2.4s; }
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
  @media (prefers-reduced-motion: reduce) {
    .fil > li:nth-last-child(-n + 2),
    .ecrit,
    .onde i,
    .points i {
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
    .fil {
      max-height: 240px;
    }
    .lib {
      display: none;
    }
    .bt {
      width: 44px;
      padding: 0;
    }
  }
  @media (max-width: 599px) {
    .ecran {
      padding-inline: var(--sp-3);
    }
    /* Membres : les pastilles seules, sur une ligne ; le fil, plus court encore (sans la photo,
       pour garder le vocal et un fichier en vue). */
    .fil > .photo {
      display: none;
    }
    .qui {
      display: none;
    }
    .membres {
      gap: var(--sp-2);
    }
    .fil {
      max-height: 200px;
    }
    .tete {
      align-items: flex-start;
    }
    .etat {
      font-size: var(--fs-micro, 0.75rem);
    }
    .boutons .bt {
      display: none;
    }
    .ligne .emo:nth-child(n + 2) {
      display: none;
    }
  }
  @media (forced-colors: active) {
    .bulle,
    .ecran {
      border: 1px solid CanvasText;
    }
  }
</style>
