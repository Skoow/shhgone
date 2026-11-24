// Preuve de travail anti-robot (UI §9.4.2), version minimale : un Worker dédié neuf cherche la
// solution ; arrêt par `signal`. Son script est lu avec son empreinte et lancé depuis un Blob en
// production (pow-source.verified.ts, spec §28.3, audit du 20 novembre W3).
// Aucun repli (le repli reCAPTCHA, jamais construit, est retiré le 24 novembre) : le calcul va
// jusqu'au bout, comme le prévoit la spécification.
import type { CaptchaProof } from "../index";
import { parseChallenge, payload } from "./search";
import { startPowWorker } from "./pow-source";

export async function solvePow(challenge: unknown, signal?: AbortSignal, onTried?: (tried: number) => void): Promise<CaptchaProof> {
  const aborted = () => new DOMException("Aborted", "AbortError");
  let c: ReturnType<typeof parseChallenge>;
  let w: Worker;
  try {
    c = parseChallenge(challenge);
  } catch {
    throw new Error("pow_indisponible");
  }
  if (signal?.aborted) throw aborted();
  try {
    w = await startPowWorker();
  } catch {
    throw new Error("pow_indisponible");
  }
  // Arrêt demandé pendant la lecture du script : le Worker ne calcule rien.
  if (signal?.aborted) {
    w.terminate();
    throw aborted();
  }
  return new Promise((resolve, reject) => {
    const stop = () => {
      w.terminate();
      reject(aborted());
    };
    signal?.addEventListener("abort", stop, { once: true });
    const done = () => {
      signal?.removeEventListener("abort", stop);
      w.terminate();
    };
    w.onmessage = (e: MessageEvent<{ tried?: number; number?: number | null; took?: number }>) => {
      const d = e.data;
      if (typeof d.tried === "number") return onTried?.(d.tried);
      done();
      if (typeof d.number === "number") resolve({ kind: "pow", payload: payload(c, d.number, d.took ?? 0) });
      else reject(new Error("pow_echec"));
    };
    w.onerror = () => {
      done();
      reject(new Error("pow_indisponible"));
    };
    try {
      w.postMessage(c);
    } catch {
      done();
      reject(new Error("pow_indisponible"));
    }
  });
}
