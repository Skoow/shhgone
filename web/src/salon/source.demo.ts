// Démo GitHub Pages : sa CSP (connect-src 'none') interdit de lire un .wasm ; le module du salon
// est donc en base64 dans un morceau à part (greffon shh-salon), chargé au premier besoin :
// seulement les règles du pseudo, pour le compte essayable. Pas de salon (il lui
// faut le vrai serveur). La démo admet cet import() dynamique, comme celui de son faux serveur.
export async function salonWasmBytes(): Promise<ArrayBuffer> {
  const { wasm } = await import("virtual:shh-salon");
  const s = atob(wasm);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out.buffer;
}
