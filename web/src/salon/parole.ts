// « Qui parle » pendant un appel (conception des appels §1) : la tuile de
// celui qui parle s'allume. Tout se passe dans ce navigateur, sur le son déjà reçu ou capté :
// rien n'est envoyé, rien n'est gardé, aucun message de plus dans le salon.
//
// `niveau` et `Parole` sont purs (tests : parole.test.ts) ; `ecouterParole` les branche sur un
// flux par l'API Web Audio, à 10 mesures par seconde.

/** Niveau efficace (0 à 1) d'un échantillon temporel d'AnalyserNode (octets centrés sur 128). */
export function niveau(b: Uint8Array): number {
  if (b.length === 0) return 0;
  let s = 0;
  for (const v of b) {
    const x = (v - 128) / 128;
    s += x * x;
  }
  return Math.sqrt(s / b.length);
}

/**
 * Hystérésis : « parle » dès que le niveau dépasse `seuil`, « se tait » seulement après `tenue` ms
 * sous 70 % du seuil (pas de clignotement entre deux syllabes).
 */
export class Parole {
  #parle = false;
  #calme = 0;
  constructor(
    readonly seuil = 0.04,
    readonly tenue = 450,
  ) {}
  get parle(): boolean {
    return this.#parle;
  }
  /** Nouvelle mesure à l'instant `t` (ms) ; vrai si l'état a changé. */
  mesure(n: number, t: number): boolean {
    if (n >= this.seuil) {
      this.#calme = 0;
      if (this.#parle) return false;
      this.#parle = true;
      return true;
    }
    if (!this.#parle) return false;
    if (n >= this.seuil * 0.7) {
      this.#calme = 0;
      return false;
    }
    if (this.#calme === 0) this.#calme = t;
    if (t - this.#calme < this.tenue) return false;
    this.#parle = false;
    this.#calme = 0;
    return true;
  }
}

let ctx: AudioContext | null = null;
let abonnes = 0;

/**
 * Écoute le son de `flux` et appelle `f` à chaque changement (parle / se tait). Renvoie l'arrêt.
 * Sans piste audio ou sans Web Audio : rien ne s'allume, l'appel n'en dépend pas.
 */
export function ecouterParole(flux: MediaStream, f: (parle: boolean) => void): () => void {
  if (typeof AudioContext !== "function" || flux.getAudioTracks().length === 0) return () => {};
  let source: MediaStreamAudioSourceNode;
  let analyse: AnalyserNode;
  try {
    ctx ??= new AudioContext();
    void ctx.resume().catch(() => {});
    source = ctx.createMediaStreamSource(flux);
    analyse = ctx.createAnalyser();
    analyse.fftSize = 512;
    source.connect(analyse); // jamais vers la sortie : le son est déjà joué par l'élément <video>
  } catch {
    return () => {};
  }
  abonnes++;
  const p = new Parole();
  const b = new Uint8Array(analyse.fftSize);
  const tic = setInterval(() => {
    analyse.getByteTimeDomainData(b);
    if (p.mesure(niveau(b), performance.now())) f(p.parle);
  }, 100);
  return () => {
    clearInterval(tic);
    source.disconnect();
    if (p.parle) f(false);
    if (--abonnes === 0 && ctx) {
      void ctx.close().catch(() => {});
      ctx = null;
    }
  };
}
