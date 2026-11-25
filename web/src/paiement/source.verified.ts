// Production : le module des jetons est le fichier assets/jetons-EMPREINTE.wasm, lu par fetch avec
// `integrity` (empreinte SHA-384 inscrite par le greffon shh-jetons) : des octets différents sont
// refusés par le navigateur. Lu au premier besoin d'un jeton seulement. Pas d'import() dynamique.
import { integrity, src } from "virtual:shh-jetons";

export async function jetonsWasmBytes(): Promise<ArrayBuffer> {
  try {
    const res = await fetch(src, { integrity, credentials: "same-origin", redirect: "error" });
    if (!res.ok) throw new Error("reseau");
    return await res.arrayBuffer();
  } catch {
    throw new Error("reseau");
  }
}
