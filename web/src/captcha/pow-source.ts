// Worker de la preuve de travail : tests et développement. Les builds remplacent ce module
// (greffon shh-pow, vite.config.ts) : pow-source.verified.ts en production (script lu avec son
// empreinte SHA-384, Worker depuis un Blob), pow-source.demo.ts dans la
// démo (aucune preuve à calculer). Ici : le fichier du serveur de développement, sans empreinte ;
// le build s'arrête si ce module y entre.
import { scriptUrl } from "../app/trusted";
import powWorkerUrl from "./pow.worker.ts?worker&url";

export async function startPowWorker(): Promise<Worker> {
  return new Worker(scriptUrl(powWorkerUrl), { type: "module" });
}
