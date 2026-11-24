<script lang="ts">
  // Appel audio ou vidéo du salon (conception des appels, 20 novembre ; logique : salon/appel.ts).
  // Bandeau « Appel en cours » pour qui n'y est pas, puis, dans l'appel : une tuile par
  // participant (image, ou initiale quand la caméra est éteinte), micro, caméra, raccrocher. La
  // conversation reste utilisable dessous. Chaque <video> distant porte aussi le son.
  // Ajouts du 21 novembre : la tuile de qui parle s'allume (salon/parole.ts, mesure locale) ;
  // caméra de face ou de dos quand l'appareil en a deux ; écran gardé allumé pendant l'appel.
  import { t } from "../../i18n/i18n.svelte";
  import { href } from "../../app/router.svelte";
  import * as S from "../../salon/salon.svelte";
  import { APPEL_MAX } from "../../salon/appel";
  import { ecouterParole } from "../../salon/parole";
  import Button from "../../ui/Button.svelte";
  import IconButton from "../../ui/IconButton.svelte";
  import { Mic, MicOff, Video, VideoOff, PhoneOff, SwitchCamera, ScreenShare } from "../../ui/Icon";

  const vue = S.vue;
  const conv = S.conversation()!;
  const etat = $derived((void vue.rev, S.appel()?.etat ?? "aucun"));
  const participants = $derived((void vue.rev, S.appel()?.participants ?? []));
  const erreur = $derived((void vue.rev, S.appel()?.erreur ?? null));
  // « Réservé aux offres Plus et Pro » : bouton touché sans offre sur l'appareil (S.lancerAppel),
  // ou le serveur a dit les appels fermés sans jeton disponible (erreur « offre »).
  const reserve = $derived(erreur === "offre" || (vue.appelReserve && etat === "aucun"));
  const micro = $derived((void vue.rev, S.appel()?.micro ?? true));
  const camera = $derived((void vue.rev, S.appel()?.camera ?? false));
  const local = $derived((void vue.rev, S.appel()?.local ?? null));
  const face = $derived((void vue.rev, S.appel()?.face ?? "user"));
  const ecran = $derived((void vue.rev, S.appel()?.ecran ?? false));
  const fluxEcran = $derived((void vue.rev, S.appel()?.fluxEcran ?? null));
  const ecranPossible = $derived((void vue.rev, S.appel()?.ecranPossible ?? false));

  /** Plusieurs caméras (téléphone) : bouton pour passer de l'une à l'autre. Lu une fois la caméra autorisée. */
  let deuxCameras = $state(false);
  $effect(() => {
    if (!camera || deuxCameras) return;
    void navigator.mediaDevices
      ?.enumerateDevices?.()
      .then((l) => (deuxCameras = l.filter((d) => d.kind === "videoinput").length > 1))
      .catch(() => {});
  });

  // Écran gardé allumé pendant l'appel (repris au retour sur l'onglet, que le navigateur le relâche).
  $effect(() => {
    if (etat !== "dans" || !("wakeLock" in navigator)) return;
    let verrou: WakeLockSentinel | null = null;
    let fini = false;
    const prendre = () => {
      if (fini || document.visibilityState !== "visible") return;
      void navigator.wakeLock
        .request("screen")
        .then((v) => (fini ? void v.release() : (verrou = v)))
        .catch(() => {});
    };
    prendre();
    document.addEventListener("visibilitychange", prendre);
    return () => {
      fini = true;
      document.removeEventListener("visibilitychange", prendre);
      void verrou?.release().catch(() => {});
    };
  });

  /** Allume la tuile (attribut data-parle) tant que son flux porte une voix. */
  function parole(node: HTMLElement, f: MediaStream | null) {
    let arret = () => {};
    const suivre = (x: MediaStream | null) => {
      arret();
      node.removeAttribute("data-parle");
      arret = x ? ecouterParole(x, (oui) => node.toggleAttribute("data-parle", oui)) : () => {};
    };
    suivre(f);
    return {
      update: suivre,
      destroy: () => arret(),
    };
  }

  function nom(s: number): string {
    const n = conv.nom(s);
    return n.pseudo ?? t("salon.room.participant", { n: n.numero });
  }
  const initiale = (s: string) => [...s.trim()][0]?.toLocaleUpperCase() ?? "";

  /** Branche un flux sur un élément <video> (srcObject n'est pas un attribut). */
  function flux(node: HTMLVideoElement, f: MediaStream | null) {
    const poser = (x: MediaStream | null) => {
      if (node.srcObject !== x) node.srcObject = x;
      if (x) void node.play().catch(() => {});
    };
    poser(f);
    return {
      update: poser,
      destroy() {
        node.srcObject = null;
      },
    };
  }
</script>

{#if reserve}
  <!-- Appels réservés aux offres Plus et Pro (24 novembre) : les offres s'ouvrent dans un autre
       onglet, pour que le salon reste ouvert dans celui-ci. -->
  <p class="appel-err reserve" role="alert" data-appel-reserve>
    <span>{t("salon.appel.err.offre")}</span>
    <a href={href("/offres")} target="_blank" rel="noopener noreferrer">{t("salon.appel.offres")}</a>
  </p>
{:else if erreur}
  <p class="appel-err" role="alert">{t(`salon.appel.err.${erreur}`, { n: APPEL_MAX })}</p>
{/if}
{#if etat === "sonne"}
  <div class="appel-bandeau" role="status" data-appel="sonne">
    <span>{t("salon.appel.encours", { n: participants.length })}</span>
    <span class="actions">
      <Button variant="secondary" dense onpress={() => void S.appel()?.rejoindre(false)}>{t("salon.appel.rejoindre")}</Button>
      <Button variant="secondary" dense onpress={() => void S.appel()?.rejoindre(true)}>{t("salon.appel.rejoindre.video")}</Button>
    </span>
  </div>
{:else if etat === "entree"}
  <p class="appel-bandeau" role="status" data-appel="entree">{t("salon.appel.entree")}</p>
{:else if etat === "dans"}
  <section class="appel" aria-label={t("salon.appel.titre")} data-appel="dans">
    <ul class="tuiles" data-n={participants.length + 1}>
      <li class="tuile moi" use:parole={micro ? local : null}>
        {#if ecran && fluxEcran}
          <video use:flux={fluxEcran} muted playsinline autoplay aria-hidden="true"></video>
        {:else if camera && local}
          <video use:flux={local} muted playsinline autoplay class:miroir={face === "user"} aria-hidden="true"></video>
        {:else}
          <span class="pastille" aria-hidden="true">{initiale(vue.monPseudo ?? "")}</span>
        {/if}
        <span class="nom">{vue.monPseudo} ({t("salon.room.you")}){#if !micro}<span class="muet"><MicOff size={14} /></span>{/if}</span>
      </li>
      {#each participants as p (p.siege)}
        <li class={["tuile", `c${conv.couleur(p.siege)}`]} data-siege={p.siege} data-lien={p.lien} use:parole={p.flux}>
          <!-- Toujours présent : il joue le son même quand la caméra est éteinte. -->
          <video use:flux={p.flux} playsinline autoplay class:cache={!p.video} aria-hidden="true"></video>
          {#if !p.video}<span class="pastille" aria-hidden="true">{initiale(nom(p.siege))}</span>{/if}
          <span class="nom">{nom(p.siege)}{#if p.lien !== "lie"}<span class="lien"> · {t(p.lien === "coupe" ? "salon.appel.coupe" : "salon.appel.connexion")}</span>{/if}</span>
        </li>
      {/each}
    </ul>
    <!-- Seul dans l'appel : l'attente et le rappel de ce qui protège l'appel ; ensuite la place va aux tuiles. -->
    {#if participants.length === 0}
      <p class="seul" role="status">{t("salon.appel.seul")}</p>
      <p class="note">{t("salon.appel.note")}</p>
    {/if}
    <div class="commandes">
      <IconButton label={t(micro ? "salon.appel.micro.couper" : "salon.appel.micro.activer")} variant="secondary" aria-pressed={!micro} onpress={() => S.appel()?.basculerMicro()}>
        {#if micro}<Mic size={20} />{:else}<MicOff size={20} />{/if}
      </IconButton>
      <IconButton label={t(camera ? "salon.appel.camera.eteindre" : "salon.appel.camera.allumer")} variant="secondary" aria-pressed={camera} onpress={() => void S.appel()?.basculerCamera()}>
        {#if camera}<Video size={20} />{:else}<VideoOff size={20} />{/if}
      </IconButton>
      {#if camera && deuxCameras}
        <IconButton label={t("salon.appel.camera.retourner")} variant="secondary" onpress={() => void S.appel()?.retournerCamera()}>
          <SwitchCamera size={20} />
        </IconButton>
      {/if}
      {#if ecranPossible}
        <IconButton label={t(ecran ? "salon.appel.ecran.arreter" : "salon.appel.ecran.partager")} variant="secondary" aria-pressed={ecran} onpress={() => (ecran ? S.appel()?.arreterEcran() : void S.appel()?.partagerEcran())}>
          <ScreenShare size={20} />
        </IconButton>
      {/if}
      <IconButton label={t("salon.appel.raccrocher")} variant="danger" onpress={() => S.appel()?.quitter()}>
        <PhoneOff size={20} />
      </IconButton>
    </div>
  </section>
{/if}

<style>
  .appel-err,
  .appel-bandeau {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 8px 12px;
    margin: 0;
    padding: 8px 16px;
    border-bottom: 1px solid var(--line);
    background: var(--surface-2);
    color: var(--text);
    font-size: var(--fs-small);
  }
  .appel-err {
    color: var(--danger);
  }
  /* Pas une panne : une explication, au ton du texte. */
  .appel-err.reserve {
    justify-content: flex-start;
    color: var(--text);
  }
  .reserve a {
    color: inherit;
    font-weight: 600;
    text-decoration: underline;
  }
  .actions {
    display: inline-flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  /* Reste visible sous la barre du site pendant qu'on lit ou écrit dans la conversation. */
  .appel,
  .appel-bandeau {
    position: sticky;
    top: 64px; /* hauteur de la barre du site (AppShell .bar) */
    z-index: 2;
  }
  /* Téléphone couché : la barre du site ne colle plus (AppShell), le panneau monte tout en haut. */
  @media (max-height: 500px) and (orientation: landscape) {
    .appel,
    .appel-bandeau {
      top: 0;
    }
    .tuiles {
      max-height: 38vh;
    }
  }
  .appel {
    display: grid;
    gap: 10px;
    padding: 12px 16px;
    border-bottom: 1px solid var(--line);
    background: var(--surface-1);
  }
  .tuiles {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 150px), 1fr));
    gap: 8px;
    margin: 0;
    padding: 0;
    list-style: none;
    max-height: 46vh;
    overflow: auto;
  }
  .tuile {
    position: relative;
    display: grid;
    place-items: center;
    aspect-ratio: 16 / 9;
    min-height: 84px;
    overflow: hidden;
    border: 1px solid var(--line);
    border-radius: var(--r-md);
    background: var(--surface-3);
  }
  .tuile[data-lien="lie"] {
    border-color: var(--line-strong);
  }
  /* Qui parle : liseré et halo menthe (mesure locale, salon/parole.ts). */
  .tuile {
    transition: border-color 160ms ease, box-shadow 160ms ease;
  }
  /* Attribut posé par l'action `parole` (hors du gabarit) : :global pour que Svelte le garde. */
  .tuile:global([data-parle]) {
    border-color: var(--accent);
    box-shadow: 0 0 0 2px rgb(95 227 181 / 0.35);
  }
  @media (prefers-reduced-motion: reduce) {
    .tuile {
      transition: none;
    }
  }
  video {
    width: 100%;
    height: 100%;
    object-fit: cover;
    background: var(--bg-deep);
  }
  /* Caméra de face : vue en miroir, comme dans une glace ; de dos : à l'endroit. */
  .moi video.miroir {
    transform: scaleX(-1);
  }
  /* Caméra éteinte : l'élément reste (il joue le son) mais ne montre rien. */
  video.cache {
    position: absolute;
    width: 1px;
    height: 1px;
    opacity: 0;
    pointer-events: none;
  }
  .pastille {
    display: grid;
    place-items: center;
    width: 48px;
    height: 48px;
    border-radius: 50%;
    background: var(--surface-2);
    color: var(--text);
    font-size: 1.25rem;
    font-weight: 600;
  }
  .nom {
    position: absolute;
    inset: auto 6px 6px 6px;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    width: fit-content;
    max-width: calc(100% - 12px);
    padding: 2px 8px;
    overflow: hidden;
    border-radius: var(--r-sm);
    background: var(--scrim);
    color: var(--text);
    font-size: var(--fs-micro);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .muet {
    display: inline-flex;
  }
  .seul,
  .note {
    margin: 0;
    color: var(--text-2);
    font-size: var(--fs-micro);
  }
  .commandes {
    display: flex;
    justify-content: center;
    gap: 12px;
  }
</style>
