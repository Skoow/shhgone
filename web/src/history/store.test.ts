// Historique local des envois (spec §33, §33.1) : chiffré au repos, clé non extractible,
// jamais de K_lien, de mot de passe ni de nom d'élément, entrées terminées retirées après
// 7 jours, « Effacer l'historique », et tout échec de stockage → pas d'historique (null).
import { describe, expect, it } from "vitest";
import { fakeIndexedDB } from "./fake-idb.test-helper";
import {
  HISTORY_KEEP_GONE_MS,
  effectiveState,
  idbBackend,
  memoryBackend,
  openHistory,
  sortEntries,
  type HistoryEntry,
  type NewEntry,
} from "./store";

const MANAGE = "https://shhdrop.example/#m" + "A".repeat(43);
const MANAGE2 = "https://shhdrop.example/#m" + "B".repeat(43);
const T0 = Date.UTC(2026, 10, 5, 20, 14);

const fresh = (over: Partial<NewEntry> = {}): NewEntry => ({
  manage: MANAGE,
  createdAt: T0,
  sizeBytes: 148_897_792,
  itemsCount: 6,
  expiresAt: T0 + 12 * 3600_000,
  maxOpens: 3,
  ...over,
});

/** Tout ce qui est « sur disque », en texte, pour chercher un clair. */
function dump(v: unknown): string {
  const seen: string[] = [];
  const walk = (x: unknown) => {
    if (x instanceof Uint8Array) seen.push(new TextDecoder("latin1").decode(x), Buffer.from(x).toString("hex"));
    else if (x instanceof Map) for (const [k, y] of x) (seen.push(String(k)), walk(y));
    else if (Array.isArray(x)) x.forEach(walk);
    else if (x && typeof x === "object" && !(x instanceof CryptoKey)) for (const [k, y] of Object.entries(x)) (seen.push(k), walk(y));
    else seen.push(String(x));
  };
  walk(v);
  return seen.join("\n");
}

describe("historique chiffré (IndexedDB simulé)", () => {
  // Stockage persistant demandé à la première entrée gardée, une fois,
  // jamais à la simple ouverture ; un refus ou une erreur ne gêne rien.
  it("stockage persistant : demandé une fois, au premier ajout seulement ; une erreur ne casse rien", async () => {
    let asked = 0;
    const h = (await openHistory({ backend: memoryBackend(), now: () => T0, persist: async () => void asked++ }))!;
    await h.list();
    expect(asked).toBe(0);
    await h.add(fresh());
    await h.add(fresh({ manage: fresh().manage.replace(/.$/, "B") }));
    expect(asked).toBe(1);
    const k = (await openHistory({ backend: memoryBackend(), now: () => T0, persist: () => Promise.reject(new Error("refus")) }))!;
    expect((await k.add(fresh())).state).toBe("ready");
  });
  it("add puis lecture brute : aucun octet de S_gestion, de la taille, du nombre ni de la date en clair", async () => {
    const idb = fakeIndexedDB();
    const h = (await openHistory({ backend: idbBackend(idb), now: () => T0 }))!;
    expect(h).not.toBeNull();
    const e = await h.add(fresh());
    const raw = dump(idb.raw());
    expect(raw).not.toContain("A".repeat(43));
    expect(raw).not.toContain("shhdrop.example");
    // « #m » seul peut apparaître par hasard dans un chiffré : on cherche le lien de gestion lui-même.
    expect(raw).not.toContain("#mAAAA");
    expect(raw).not.toContain("148897792");
    expect(raw).not.toContain(String(T0));
    expect(raw).not.toMatch(/sizeBytes|itemsCount|createdAt|manage"/);
    // Relue par une nouvelle ouverture (même base) : identique.
    const h2 = (await openHistory({ backend: idbBackend(idb), now: () => T0 }))!;
    expect(await h2.list()).toEqual([e]);
  });

  it("la clé enregistrée est AES-GCM 256, non extractible, et la même au second chargement", async () => {
    const idb = fakeIndexedDB();
    await openHistory({ backend: idbBackend(idb) });
    const meta = idb.raw().get("shhdrop-history")!.get("meta")!;
    const key = meta.get("key") as CryptoKey;
    expect(key).toBeInstanceOf(CryptoKey);
    expect(key.extractable).toBe(false);
    expect(key.algorithm).toMatchObject({ name: "AES-GCM", length: 256 });
    await openHistory({ backend: idbBackend(idb) });
    expect(idb.raw().get("shhdrop-history")!.get("meta")!.get("key")).toBe(key);
  });

  it("nonce aléatoire à chaque écriture (même contenu → deux chiffrés différents)", async () => {
    const b = memoryBackend();
    // Horloge fixée (comme les autres tests) : à l'heure réelle, l'entrée de T0 serait terminée
    // depuis 7 jours à 08 h 14 UTC, donc retirée (test daté).
    const h = (await openHistory({ backend: b, now: () => T0 }))!;
    const e = await h.add(fresh());
    const first = [...b.raw().values()][0]!;
    await h.update(e.id, { opensUsed: 0 });
    const second = [...b.raw().values()][0]!;
    expect(Buffer.from(first.iv).equals(Buffer.from(second.iv))).toBe(false);
    expect(Buffer.from(first.ct).equals(Buffer.from(second.ct))).toBe(false);
  });

  it("une entrée déplacée sous un autre identifiant ne se déchiffre pas (identifiant authentifié) et est écartée", async () => {
    const b = memoryBackend();
    const h = (await openHistory({ backend: b, now: () => T0 }))!;
    const e = await h.add(fresh());
    const rec = b.raw().get(e.id)!;
    await b.put("Z".repeat(22), rec);
    const list = await h.list();
    expect(list.map((x) => x.id)).toEqual([e.id]);
    expect(b.raw().has("Z".repeat(22))).toBe(false);
  });

  it("jamais de K_lien, de mot de passe ni de nom d'élément : les champs inconnus sont ignorés", async () => {
    const h = (await openHistory({ backend: memoryBackend(), now: () => T0 }))!;
    const e = await h.add({ ...fresh(), password: "secret", names: ["photo.jpg"] } as unknown as NewEntry);
    const keys = Object.keys(e).sort();
    expect(keys).toEqual(
      ["createdAt", "destroyedHere", "endedAt", "expiresAt", "format", "id", "itemsCount", "label", "lastSeenAt", "link", "manage", "maxOpens", "opens", "opensUsed", "origine", "sizeBytes", "sorte", "state"].sort(),
    );
    expect(e).toMatchObject({ sorte: "envoi", origine: "local", link: "", label: "", format: "" });
    expect(JSON.stringify(await h.list())).not.toMatch(/photo\.jpg|secret|k{43}/);
  });

  it("refuse un lien qui n'est pas un lien de gestion (un lien de partage ne passe pas)", async () => {
    const h = (await openHistory({ backend: memoryBackend() }))!;
    await expect(h.add(fresh({ manage: "https://shhdrop.example/#" + "k".repeat(43) }))).rejects.toThrow();
    await expect(h.add(fresh({ sizeBytes: -1 }))).rejects.toThrow();
  });

  it("le même lien de gestion n'est gardé qu'une fois", async () => {
    const h = (await openHistory({ backend: memoryBackend(), now: () => T0 }))!;
    const a = await h.add(fresh());
    const b = await h.add(fresh());
    expect(b.id).toBe(a.id);
    expect(await h.list()).toHaveLength(1);
  });

  it("entrée neuve : état prêt, 0 ouverture, connue à la création", async () => {
    const h = (await openHistory({ backend: memoryBackend(), now: () => T0 }))!;
    const e = await h.add(fresh());
    expect(e).toMatchObject({ state: "ready", opensUsed: 0, opens: [], lastSeenAt: T0, endedAt: 0, destroyedHere: false });
    expect(e.id).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });

  it("remove, update, get, clear", async () => {
    const h = (await openHistory({ backend: memoryBackend(), now: () => T0 }))!;
    const a = await h.add(fresh());
    const b = await h.add(fresh({ manage: MANAGE2 }));
    expect((await h.update(a.id, { opensUsed: 1 }))?.opensUsed).toBe(1);
    expect((await h.get(a.id))?.opensUsed).toBe(1);
    expect(await h.update("x".repeat(22), { opensUsed: 1 })).toBeNull();
    await h.remove(b.id);
    expect((await h.list()).map((x) => x.id)).toEqual([a.id]);
    await h.clear();
    expect(await h.list()).toEqual([]);
  });

  it("entrée détruite ou expirée retirée 7 jours après sa fin ; une entrée active dont l'échéance est passée depuis 7 jours aussi", async () => {
    let now = T0;
    const b = memoryBackend();
    const h = (await openHistory({ backend: b, now: () => now }))!;
    const a = await h.add(fresh());
    const c = await h.add(fresh({ manage: MANAGE2 }));
    await h.update(a.id, { state: "gone", endedAt: T0 + 1000 });
    now = T0 + 1000 + HISTORY_KEEP_GONE_MS - 1;
    expect((await h.list()).map((x) => x.id).sort()).toEqual([a.id, c.id].sort());
    now = T0 + 1000 + HISTORY_KEEP_GONE_MS;
    expect((await h.list()).map((x) => x.id)).toEqual([c.id]);
    expect(b.raw().has(a.id)).toBe(false);
    now = c.expiresAt + HISTORY_KEEP_GONE_MS;
    expect(await h.list()).toEqual([]);
  });

  it("préférence « Garder dans mon historique » : désactivée par défaut, activée par un geste, gardée", async () => {
    const idb = fakeIndexedDB();
    const h = (await openHistory({ backend: idbBackend(idb) }))!;
    expect(await h.enabled()).toBe(false);
    await h.setEnabled(true);
    expect(await (await openHistory({ backend: idbBackend(idb) }))!.enabled()).toBe(true);
    await h.setEnabled(false);
    expect(await (await openHistory({ backend: idbBackend(idb) }))!.enabled()).toBe(false);
  });

  it("ancien drapeau « off » absent (activé par défaut) : ne vaut plus activation ; entrées gardées", async () => {
    const b = memoryBackend();
    const h = (await openHistory({ backend: b, now: () => T0 }))!;
    const a = await h.add(fresh());
    expect(await h.enabled()).toBe(false); // aucune trace d'un geste : désactivé
    await b.setFlag("off", true); // ancien choix « désactivé »
    expect(await h.enabled()).toBe(false);
    await h.setEnabled(true);
    expect(await b.flag("off")).toBeUndefined(); // l'ancien drapeau part au premier choix
    expect(await h.enabled()).toBe(true);
    expect((await h.list()).map((x) => x.id)).toEqual([a.id]); // le lien de gestion reste
  });

  it("« Effacer l'historique » (clear) ne change pas le choix de la personne", async () => {
    const idb = fakeIndexedDB();
    const h = (await openHistory({ backend: idbBackend(idb), now: () => T0 }))!;
    await h.setEnabled(true);
    await h.add(fresh());
    await h.clear();
    expect(await h.list()).toEqual([]);
    expect(await h.enabled()).toBe(true);
  });

  it("exists : faux tant que rien n'est gardé, et la vérification ne crée aucune base", async () => {
    const idb = fakeIndexedDB();
    expect(await idbBackend(idb).exists()).toBe(false);
    expect(idb.raw().has("shhdrop-history")).toBe(false);
    await openHistory({ backend: idbBackend(idb) });
    expect(await idbBackend(idb).exists()).toBe(true);
  });

  it("stockage indisponible (navigation privée stricte, IndexedDB absent ou refusé) → null, sans exception", async () => {
    expect(await openHistory({ backend: null })).toBeNull();
    const idb = fakeIndexedDB();
    idb.failOpen = true;
    expect(await openHistory({ backend: idbBackend(idb) })).toBeNull();
    const ro = fakeIndexedDB();
    ro.failWrites = true;
    expect(await openHistory({ backend: idbBackend(ro) })).toBeNull();
  });

  it("une écriture refusée plus tard (quota) rejette l'ajout, sans rien casser", async () => {
    const idb = fakeIndexedDB();
    const h = (await openHistory({ backend: idbBackend(idb) }))!;
    idb.failWrites = true;
    await expect(h.add(fresh())).rejects.toBeTruthy();
    idb.failWrites = false;
    expect(await h.list()).toEqual([]);
  });
});

describe("état affiché et tri (UI §9.6.2)", () => {
  const base: HistoryEntry = {
    id: "a".repeat(22),
    sorte: "envoi",
    origine: "local",
    manage: MANAGE,
    link: "",
    label: "",
    format: "",
    createdAt: T0,
    sizeBytes: 1,
    itemsCount: 1,
    expiresAt: T0 + 3600_000,
    maxOpens: 1,
    opensUsed: 0,
    opens: [],
    state: "ready",
    lastSeenAt: T0,
    endedAt: 0,
    destroyedHere: false,
  };
  it("échéance passée → expiré, sans requête", () => {
    expect(effectiveState(base, T0)).toBe("ready");
    expect(effectiveState(base, base.expiresAt)).toBe("expired");
    expect(effectiveState({ ...base, state: "draining" }, base.expiresAt + 1)).toBe("expired");
    expect(effectiveState({ ...base, state: "gone" }, base.expiresAt + 1)).toBe("gone");
  });
  it("en cours d'effacement, puis actifs par échéance croissante, puis terminés par fin la plus récente", () => {
    const e = (id: string, o: Partial<HistoryEntry>) => ({ ...base, id: id.repeat(22), ...o });
    const list = [
      e("1", { expiresAt: T0 + 9e6 }),
      e("2", { state: "gone", endedAt: T0 + 10 }),
      e("3", { state: "draining", expiresAt: T0 + 9e7 }),
      e("4", { expiresAt: T0 + 5e6 }),
      e("5", { state: "gone", endedAt: T0 + 20 }),
    ];
    expect(sortEntries(list, T0).map((x) => x.id[0])).toEqual(["3", "4", "1", "5", "2"]);
  });
});

// Conception compte §21.7, §21.8 : quatre sortes d'entrées (envoi, reçu, salon
// créé, salon rejoint) et leur origine (cet appareil ou le compte). Exception écrite à §33 : un
// partage reçu ou un salon garde son lien (K_lien), chiffré comme le reste ; jamais un mot de
// passe, un nom d'élément ni un contenu ; un envoi ne garde jamais de lien de partage.
describe("historique de l'appareil : quatre sortes", () => {
  const LINK = "https://shhdrop.example/#" + "k".repeat(43);
  const LINK2 = "https://shhdrop.example/#" + "q".repeat(43);
  const ROOM = "https://shhdrop.example/#c" + "r".repeat(43);
  const recu = (over: Partial<NewEntry> = {}): NewEntry => ({
    sorte: "recu",
    manage: "",
    link: LINK,
    format: "image",
    createdAt: T0,
    sizeBytes: 148_897_792,
    itemsCount: 6,
    expiresAt: T0 + 12 * 3600_000,
    maxOpens: 0,
    ...over,
  });

  it("migration : une entrée d'avant (sans sorte ni origine) se relit en envoi local, intacte", async () => {
    const b = memoryBackend();
    const h = (await openHistory({ backend: b, now: () => T0 }))!;
    // Entrée écrite par la version précédente : même chiffrement, champs d'alors seulement.
    const key = await b.key(undefined as unknown as CryptoKey);
    const id = "O".repeat(22);
    const old = { manage: MANAGE, createdAt: T0, sizeBytes: 5, itemsCount: 1, expiresAt: T0 + 3600_000, maxOpens: 2, opensUsed: 1, opens: [], state: "ready", lastSeenAt: T0, endedAt: 0, destroyedHere: false };
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode("shhdrop/history/v1/" + id) }, key, new TextEncoder().encode(JSON.stringify(old))));
    await b.put(id, { iv, ct });
    expect(await h.list()).toEqual([{ id, sorte: "envoi", origine: "local", link: "", label: "", format: "", ...old }]);
  });

  it("partage reçu : lien gardé (chiffré au repos), aucun mot de passe, nom ni contenu ; origine locale", async () => {
    const b = memoryBackend();
    const h = (await openHistory({ backend: b, now: () => T0 }))!;
    const e = await h.add({ ...recu(), password: "secret-mdp", names: ["photo.jpg"], items: [{ name: "photo.jpg" }], text: "contenu" } as unknown as NewEntry);
    expect(e).toMatchObject({ sorte: "recu", origine: "local", manage: "", link: LINK, format: "image", itemsCount: 6 });
    expect(JSON.stringify(await h.list())).not.toMatch(/secret-mdp|photo\.jpg|contenu|password|names|items"/);
    const raw = dump(b.raw());
    expect(raw).not.toContain("k".repeat(43));
    expect(raw).not.toContain("secret-mdp");
  });

  it("K_lien accepté seulement pour un reçu ou un salon ; jamais pour un envoi", async () => {
    const h = (await openHistory({ backend: memoryBackend(), now: () => T0 }))!;
    // Envoi : lien de gestion seulement ; un lien de partage à côté est refusé.
    await expect(h.add(fresh({ link: LINK }))).rejects.toThrow();
    // Reçu : lien de partage exigé, ni lien de gestion ni lien de salon.
    await expect(h.add(recu({ link: "" }))).rejects.toThrow();
    await expect(h.add(recu({ manage: MANAGE }))).rejects.toThrow();
    await expect(h.add(recu({ link: ROOM }))).rejects.toThrow();
    await expect(h.add(recu({ link: MANAGE }))).rejects.toThrow();
    await expect(h.add(recu({ format: "<script>" }))).rejects.toThrow();
    // Salons : lien d'invitation « #c », libellé local court.
    const s = await h.add({ sorte: "salon_rejoint", manage: "", link: ROOM, label: "Équipe", createdAt: T0, sizeBytes: 0, itemsCount: 0, expiresAt: T0 + 3600_000, maxOpens: 0 });
    expect(s).toMatchObject({ sorte: "salon_rejoint", link: ROOM, label: "Équipe" });
    await expect(h.add({ sorte: "salon_cree", manage: "", link: LINK2, createdAt: T0, sizeBytes: 0, itemsCount: 0, expiresAt: T0 + 1, maxOpens: 0 })).rejects.toThrow();
    await expect(h.add({ sorte: "salon_cree", manage: "", link: ROOM.replace("r", "s"), label: "x".repeat(65), createdAt: T0, sizeBytes: 0, itemsCount: 0, expiresAt: T0 + 1, maxOpens: 0 })).rejects.toThrow();
    await expect(h.add({ ...fresh(), sorte: "autre" } as unknown as NewEntry)).rejects.toThrow();
    // Salon créé : lien de gestion « #s » seulement ; jamais pour un salon rejoint.
    const GESTION = "https://shhgone.com/salon#s" + "G".repeat(43);
    const c = await h.add({ sorte: "salon_cree", manage: GESTION, link: ROOM.replace(/.{8}$/, "Zzzzzzzz"), label: "", createdAt: T0, sizeBytes: 0, itemsCount: 0, expiresAt: T0 + 1, maxOpens: 0 });
    expect(c.manage).toBe(GESTION);
    await expect(h.add({ sorte: "salon_rejoint", manage: GESTION, link: ROOM.replace(/.{8}$/, "Yyyyyyyy"), createdAt: T0, sizeBytes: 0, itemsCount: 0, expiresAt: T0 + 1, maxOpens: 0 })).rejects.toThrow();
    await expect(h.add({ sorte: "salon_cree", manage: MANAGE, link: ROOM.replace(/.{8}$/, "Xxxxxxxx"), createdAt: T0, sizeBytes: 0, itemsCount: 0, expiresAt: T0 + 1, maxOpens: 0 })).rejects.toThrow();
  });

  it("le même lien reçu n'est gardé qu'une fois ; un autre lien fait une autre entrée", async () => {
    const h = (await openHistory({ backend: memoryBackend(), now: () => T0 }))!;
    const a = await h.add(recu());
    expect((await h.add(recu())).id).toBe(a.id);
    await h.add(recu({ link: LINK2 }));
    expect(await h.list()).toHaveLength(2);
  });

  it("put : entrée venue du compte, avec son identifiant ; refusée si mal formée ; un même lien déjà là reste", async () => {
    const h = (await openHistory({ backend: memoryBackend(), now: () => T0 }))!;
    const local = await h.add(recu());
    const vue = { ...local, id: "C".repeat(22), origine: "compte" as const };
    expect(await h.put(vue)).toBe(false); // même lien : l'entrée de l'appareil reste
    const autre = { ...vue, link: LINK2 };
    expect(await h.put(autre)).toBe(true);
    expect((await h.get("C".repeat(22)))?.origine).toBe("compte");
    await expect(h.put({ ...autre, id: "D".repeat(22), link: "x" })).rejects.toThrow();
  });

  it("update ne change ni la sorte, ni l'origine, ni les liens", async () => {
    const h = (await openHistory({ backend: memoryBackend(), now: () => T0 }))!;
    const e = await h.add(recu());
    const u = await h.update(e.id, { sorte: "envoi", origine: "compte", link: LINK2, manage: MANAGE, state: "gone" } as never);
    expect(u).toMatchObject({ sorte: "recu", origine: "local", link: LINK, manage: "", state: "gone" });
  });
});

// Nom du partage : `label` d'un envoi, chiffré au repos
// comme le reste de l'entrée, renommable sur l'appareil.
describe("historique : titre d'un envoi", () => {
  it("gardé chiffré (aucun octet en clair sur disque), relu, renommé ; 80 points de code au plus, aucune commande", async () => {
    const idb = fakeIndexedDB();
    const h = (await openHistory({ backend: idbBackend(idb), now: () => T0 }))!;
    const NAME = "Résultats d'analyse Dupont 😀";
    const e = await h.add(fresh({ label: NAME }));
    expect(e.label).toBe(NAME);
    const raw = dump(idb.raw());
    expect(raw).not.toContain("Dupont");
    expect(raw).not.toContain(Buffer.from("Dupont").toString("hex"));
    expect(raw).not.toContain("label");
    const h2 = (await openHistory({ backend: idbBackend(idb), now: () => T0 }))!;
    expect((await h2.get(e.id))!.label).toBe(NAME);
    const r = await h2.update(e.id, { label: "Autre nom" });
    expect(r!.label).toBe("Autre nom");
    expect(dump(idb.raw())).not.toContain("Autre nom");
    // 80 points de code (ici 160 unités UTF-16) : accepté ; 81 : refusé ; commandes refusées.
    expect((await h2.update(e.id, { label: "😀".repeat(80) }))!.label).toBe("😀".repeat(80));
    await expect(h2.update(e.id, { label: "a".repeat(81) })).rejects.toThrow();
    for (const bad of ["a\u0000b", "a\nb", "a\u007fb", "a\u0085b", "a\u009fb"]) await expect(h2.update(e.id, { label: bad })).rejects.toThrow();
    await expect(h2.add(fresh({ manage: MANAGE2, label: "x".repeat(81) }))).rejects.toThrow();
    // Une entrée sans titre se relit sans titre.
    expect((await h2.add(fresh({ manage: MANAGE2 }))).label).toBe("");
  });
});
