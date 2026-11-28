// @vitest-environment happy-dom
// Maintenance programmée (D42-32) : lecture de /api/etat-service, bandeau à l'heure locale,
// passage en mode imminent par un refus 503 « maintenance », boutons de création désactivés.
import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import { creationsFermees, lireEtat, maintenance, rafraichir, signalerMaintenance, surveiller, texteBandeau, PERIODE_ANNONCE_MS, PERIODE_MS } from "./etat.svelte";
import { setLang } from "../i18n/i18n.svelte";
import MaintenanceBanner from "../ui/MaintenanceBanner.svelte";

// 2 décembre 2026, 6 h 00 heure locale (le test tourne dans le fuseau de la machine).
const debut = Math.floor(new Date(2026, 11, 2, 6, 0).getTime() / 1000);
const annonce = { debut, duree_min: 30, retour: debut + 1800, imminente: false };
const repondre = (v: unknown, status = 200) => vi.fn(async () => new Response(JSON.stringify(v), { status })) as unknown as typeof fetch;

afterEach(async () => {
  maintenance.annonce = null;
  await setLang("fr");
  document.body.innerHTML = "";
  vi.useRealTimers();
});

describe("état du service", () => {
  it("réponse vérifiée champ par champ", () => {
    expect(lireEtat({ maintenance: null })).toBeNull();
    expect(lireEtat({ maintenance: annonce })).toEqual({ debut, dureeMin: 30, retour: debut + 1800, imminente: false });
    for (const faux of [{}, null, "x", { maintenance: { ...annonce, retour: debut } }, { maintenance: { ...annonce, duree_min: 0 } }, { maintenance: { ...annonce, duree_min: 2000, retour: debut + 120000 } }, { maintenance: { ...annonce, imminente: "oui" } }, { maintenance: { ...annonce, debut: -1 } }])
      expect(lireEtat(faux)).toBeNull();
  });

  it("rafraichir : GET /api/etat-service sans rien envoyer ; une erreur garde l'état connu", async () => {
    const f = repondre({ maintenance: annonce });
    await rafraichir(f);
    expect(f).toHaveBeenCalledWith("/api/etat-service", expect.objectContaining({ method: "GET", credentials: "same-origin", cache: "no-store" }));
    expect((f as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]![1].body).toBeUndefined();
    expect(maintenance.annonce?.debut).toBe(debut);
    await rafraichir(vi.fn(async () => Promise.reject(new TypeError("x"))) as unknown as typeof fetch);
    expect(maintenance.annonce?.debut).toBe(debut);
    await rafraichir(repondre({ maintenance: null }));
    expect(maintenance.annonce).toBeNull();
  });

  it("surveiller : au chargement puis toutes les 5 min (2 min pendant une annonce) ; arrêtée, plus rien", async () => {
    vi.useFakeTimers();
    const f = repondre({ maintenance: null });
    const stop = surveiller(window, f);
    await vi.advanceTimersByTimeAsync(0);
    expect(f).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(PERIODE_MS);
    expect(f).toHaveBeenCalledTimes(2);
    stop();
    await vi.advanceTimersByTimeAsync(PERIODE_MS * 3);
    expect(f).toHaveBeenCalledTimes(2);
    const g = repondre({ maintenance: annonce });
    const stop2 = surveiller(window, g);
    await vi.advanceTimersByTimeAsync(PERIODE_ANNONCE_MS);
    expect(g).toHaveBeenCalledTimes(2);
    stop2();
  });

  it("bandeau : date et heure locales, durée ; imminente : réessayer après la maintenance", async () => {
    maintenance.annonce = lireEtat({ maintenance: annonce });
    expect(texteBandeau()).toBe("Maintenance prévue le mercredi 2 décembre à 6 h 00, environ 30 min.");
    await setLang("en");
    expect(texteBandeau()).toBe("Maintenance planned on Wednesday, December 2 at 6:00 AM, about 30 min.");
    await setLang("fr");
    expect(creationsFermees()).toBe(false);
    maintenance.annonce = lireEtat({ maintenance: { ...annonce, imminente: true } });
    expect(creationsFermees()).toBe(true);
    expect(texteBandeau()).toBe("Le serveur va redémarrer : réessayez après la maintenance (vers 6 h 30).");
  });

  it("un refus 503 « maintenance » d'une création ferme les créations tout de suite ; les autres refus, non", () => {
    signalerMaintenance(503, { error: "busy", retry_after_s: 5 });
    signalerMaintenance(429, { error: "maintenance", retour: debut });
    expect(creationsFermees()).toBe(false);
    signalerMaintenance(503, { error: "maintenance", retour: debut + 1800, retry_after_s: 60 });
    expect(creationsFermees()).toBe(true);
    expect(texteBandeau()).toContain("vers 6 h 30");
  });

  it("MaintenanceBanner : rien sans annonce ; annonce lue (role=status) ; mode imminent mis en avant", () => {
    const c = mount(MaintenanceBanner, { target: document.body });
    flushSync();
    expect(document.querySelector("[data-maintenance-banner]")).toBeNull();
    maintenance.annonce = lireEtat({ maintenance: annonce });
    flushSync();
    const p = document.querySelector("[data-maintenance-banner]")!;
    expect(p.getAttribute("role")).toBe("status");
    expect(p.textContent).toContain("Maintenance prévue le mercredi 2 décembre");
    expect(p.classList.contains("imminente")).toBe(false);
    maintenance.annonce = lireEtat({ maintenance: { ...annonce, imminente: true } });
    flushSync();
    expect(document.querySelector("[data-maintenance-banner]")!.classList.contains("imminente")).toBe(true);
    void unmount(c);
  });
});
