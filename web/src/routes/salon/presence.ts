// État d'un participant affiché à côté de sa photo (v3 §14.1) : « en ligne », ou sa dernière
// connexion (« vu il y a 12 min », puis « vu hier à 22:05 », « vu le 11 nov. à 09:10 »). Seule
// source : `0x07` et l'accueil `0x0D` (conversation.ts, `presence`), que le serveur envoie déjà ;
// rien n'est déduit ni envoyé en plus.
import { t } from "../../i18n/i18n.svelte";
import { formatClock, type Lang } from "../../i18n/format";
import { vuIlYa } from "../../salon/affichage";
import type { Presence } from "../../salon/conversation";

export function texteVu(p: Presence | undefined, maintenantMs: number, lang: Lang): string {
  if (p?.enLigne) return t("salon.room.seen.online");
  if (!p || p.derniereMin === 0) return t("salon.room.seen.offline");
  const r = vuIlYa(p.derniereMin, maintenantMs);
  if (r?.k === "instant") return t("salon.room.seen.instant");
  if (r?.k === "min") return t("salon.room.seen.min", { n: r.n });
  if (r?.k === "h") return t("salon.room.seen.h", { n: r.n });
  const ms = p.derniereMin * 60_000;
  const d = new Date(ms);
  const auj = new Date(maintenantMs);
  const hier = new Date(auj.getFullYear(), auj.getMonth(), auj.getDate() - 1);
  const heure = formatClock(ms, lang);
  if (d.toDateString() === auj.toDateString()) return t("salon.room.seen.today", { heure });
  if (d.toDateString() === hier.toDateString()) return t("salon.room.seen.yesterday", { heure });
  const date = new Intl.DateTimeFormat(lang, { day: "numeric", month: "short" }).format(d);
  return t("salon.room.seen.date", { date, heure });
}
