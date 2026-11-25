// Empreinte SHA-256 de chaque fichier du composeur :
// affichée en petit sur sa ligne, et écrite dans le manifeste chiffré pour que le destinataire
// voie la même au même endroit. Calculée sur cet appareil seulement (moteur, par tranches), un
// fichier à la fois, jamais envoyée en clair au serveur. Un fichier nettoyé est un autre Blob :
// son empreinte est recalculée (elle diffère de l'original).
// Caches faibles (WeakMap) : un fichier retiré de la liste n'est jamais retenu en mémoire.
import { fileSha256 } from "../index";

const cache = new WeakMap<Blob, string>();
const failed = new WeakSet<Blob>();
const jobs = new WeakMap<Blob, Promise<string>>();
/** File d'attente : un seul calcul à la fois (le suivant part quand le précédent finit). */
let chain: Promise<unknown> = Promise.resolve();
let version = $state(0);

function job(b: Blob): Promise<string> {
  let p = jobs.get(b);
  if (p) return p;
  p = chain.then(() => fileSha256(b));
  chain = p.catch(() => undefined);
  jobs.set(b, p);
  p.then(
    (hex) => {
      cache.set(b, hex);
      version++;
    },
    () => {
      failed.add(b);
      version++;
    },
  );
  return p;
}

/** Empreinte en hexadécimal, « erreur », ou null (en cours) ; lance le calcul au besoin. */
export function digestOf(data: Blob | Uint8Array): string | "erreur" | null {
  void version;
  if (!(data instanceof Blob)) return null;
  const hex = cache.get(data);
  if (hex !== undefined) return hex;
  if (failed.has(data)) return "erreur";
  void job(data).catch(() => undefined);
  return null;
}

/** Empreinte de `data` (celle déjà calculée pour l'affichage si elle existe) ; rejet si échec. */
export function digestAsync(data: Blob): Promise<string> {
  const hex = cache.get(data);
  return hex !== undefined ? Promise.resolve(hex) : job(data);
}
