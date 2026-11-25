// « Ouvrir le salon » depuis l'historique : seul le fragment du lien gardé
// est repris, sur la page du salon de CE site. Une entrée écrite par un appareil compromis ou un
// client modifié (coffre du compte) ne peut donc pas mener vers un autre site.
import { href } from "../app/router.svelte";

export function lienDuSalon(lien: string, page: string = href("/salon")): string {
  const i = lien.lastIndexOf("#");
  const frag = i < 0 ? "" : lien.slice(i);
  return /^#[cs][A-Za-z0-9_-]{43}$/.test(frag) ? page + frag : page;
}
