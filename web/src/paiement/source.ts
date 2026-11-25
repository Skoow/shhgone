// Source du module WebAssembly des jetons (conception du paiement §7) : tests et développement.
// Les builds remplacent ce module (greffon shh-jetons, vite.config.ts) : source.verified.ts en
// production (fichier lu avec son empreinte SHA-384), source.demo.ts dans la démo (aucun paiement).
const WASM = new URL("./pkg/shhdrop_jetons_wasm_bg.wasm", import.meta.url);

export async function jetonsWasmBytes(): Promise<ArrayBuffer> {
  try {
    if (WASM.protocol === "file:") {
      // Node seulement (jamais dans un build : ce module y est remplacé, check-dist refuse import()).
      const fs = "node:fs/promises";
      const { readFile } = (await import(/* @vite-ignore */ fs)) as typeof import("node:fs/promises");
      const b = await readFile(WASM);
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
    }
    const res = await fetch(WASM, { credentials: "same-origin", redirect: "error" });
    if (!res.ok) throw new Error("reseau");
    return await res.arrayBuffer();
  } catch {
    throw new Error("reseau");
  }
}
