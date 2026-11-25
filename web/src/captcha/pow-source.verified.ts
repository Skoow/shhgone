// Production (spec §28.3) : new Worker(url) n'a pas de contrôle
// d'intégrité. Le script du Worker de la preuve de travail (assets/pow-worker-EMPREINTE.js, construit
// à part en script classique par le greffon shh-pow) est donc lu par fetch avec son empreinte
// SHA-384, inscrite dans ce script (lui-même couvert par l'empreinte de la page), puis lancé
// depuis un Blob de notre origine (CSP : worker-src blob:) par la politique Trusted Types
// « shhdrop » (app/trusted.ts), comme le Worker d'Argon2id (engine/source.verified.ts).
// Tout échec devient Error("reseau") ; l'essai suivant relit le fichier.
import { integrity, src } from "virtual:shh-pow";
import { scriptUrl } from "../app/trusted";

// Adresse blob: du script vérifié, gardée pour la page (script public, sans secret).
let script: Promise<string> | undefined;

function workerScript(): Promise<string> {
  if (!script) {
    script = (async () => {
      try {
        const res = await fetch(src, { integrity, credentials: "same-origin", redirect: "error" });
        if (!res.ok) throw new Error("reseau");
        const b = await res.arrayBuffer();
        return URL.createObjectURL(new Blob([b], { type: "text/javascript" }));
      } catch {
        throw new Error("reseau");
      }
    })();
    script.catch(() => (script = undefined));
  }
  return script;
}

/** Un Worker neuf par preuve (arrêté par pow.ts), depuis le script vérifié. */
export async function startPowWorker(): Promise<Worker> {
  return new Worker(scriptUrl(await workerScript()));
}
