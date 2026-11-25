// Vecteurs des liens pour les tests (pas pour le site) : v2.json est figé ; ses liens écrits à la
// racine et ses deux refus de « …/s#… » sont remplacés par v3-liens.json (liens sous /s), comme dans engine/core/tests/vectors.rs.
import { readFileSync } from "node:fs";

export type LinkCase = { fn: string; args: string[]; result?: any; error?: string };

const read = (name: string) => JSON.parse(readFileSync(new URL(`../../../engine/vectors/${name}`, import.meta.url), "utf8"));

function superseded(c: LinkCase): boolean {
  if (c.fn === "shareLink" || c.fn === "manageLink") return typeof c.result === "string";
  if (c.fn !== "parseLink" || c.error === undefined) return false;
  const path = c.args[0]!.split("#")[0]!;
  return path.endsWith("://x/s") || path.endsWith("/shhdrop/s");
}

/** Lien lu à la racine : remplacé par v4-liens-s.json (refus, et la même adresse sous /s). */
function readAtRoot(c: LinkCase): boolean {
  if (c.fn !== "parseLink" || c.result === undefined) return false;
  return !c.args[0]!.split(/[#?]/)[0]!.endsWith("/s");
}

/**
 * Cas de liens en vigueur : v2.json sans ses 32 cas remplacés, v3-liens.json sans ses 6
 * lectures à la racine, puis les 42 cas de v4-liens-s.json (comme engine/core/tests/vectors.rs).
 */
export function linkCases(): LinkCase[] {
  const v2 = read("v2.json").link as LinkCase[];
  const kept = v2.filter((c) => !superseded(c) && !readAtRoot(c));
  if (v2.length - kept.length !== 32) throw new Error("cas remplacés de v2.json : 32 attendus");
  const v3 = read("v3-liens.json").link as LinkCase[];
  if (v3.length !== 49) throw new Error("v3-liens.json : 49 cas attendus");
  const kept3 = v3.filter((c) => !readAtRoot(c));
  if (v3.length - kept3.length !== 6) throw new Error("v3-liens.json : 6 lectures à la racine attendues");
  const v4 = read("v4-liens-s.json").link as LinkCase[];
  if (v4.length !== 42) throw new Error("v4-liens-s.json : 42 cas attendus");
  return [...kept, ...kept3, ...v4];
}

/** Lien écrit d'un partage de v2.json (forme racine) dans la forme en vigueur : « s » avant « # ». */
export const toS = (link: string) => link.replace("#", "s#");
