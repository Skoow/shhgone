// Worker de la preuve de travail (audit du 20 novembre, W3) : en production, son script est lu
// avec son empreinte SHA-384 et lancé depuis un Blob de l'origine (pow-source.verified.ts) ; la
// démo n'en lance aucun. Le chemin réel (navigateur, CSP) : ui-e2e/hygiene.spec.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("virtual:shh-pow", () => ({ src: "/assets/pow-worker-AbCd1234.js", integrity: "sha384-pow" }));

const ORIGIN = "https://shh.test";

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal("location", { origin: ORIGIN });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.doUnmock("./pow-source");
});

const errorOf = async (f: () => Promise<unknown>) => {
  try {
    await f();
    return null;
  } catch (e) {
    return (e as Error).message;
  }
};

describe("production (pow-source.verified.ts)", () => {
  it("script lu une fois avec son empreinte, sans cookie ni redirection ; un Worker neuf par preuve, depuis un Blob de l'origine (script classique)", async () => {
    const f = vi.fn(async () => new Response("self.onmessage=0"));
    vi.stubGlobal("fetch", f);
    const blobs: Blob[] = [];
    vi.spyOn(URL, "createObjectURL").mockImplementation((b) => (blobs.push(b as Blob), `blob:${ORIGIN}/b${blobs.length}`));
    const made: { url: string; opts?: WorkerOptions }[] = [];
    vi.stubGlobal(
      "Worker",
      class {
        constructor(url: string, opts?: WorkerOptions) {
          made.push({ url: String(url), opts });
        }
      },
    );
    const { startPowWorker } = await import("./pow-source.verified");
    await startPowWorker();
    await startPowWorker();
    expect(f.mock.calls).toEqual([["/assets/pow-worker-AbCd1234.js", { integrity: "sha384-pow", credentials: "omit", redirect: "error" }]]);
    expect(made).toEqual([
      { url: `blob:${ORIGIN}/b1`, opts: undefined },
      { url: `blob:${ORIGIN}/b1`, opts: undefined },
    ]);
    expect(blobs.length).toBe(1);
    expect(blobs[0]!.type).toBe("text/javascript");
    expect(await blobs[0]!.text()).toBe("self.onmessage=0");
  });

  it("octets refusés (empreinte), coupure, statut d'erreur : Error(\"reseau\"), aucun Worker ; l'essai suivant relit le fichier", async () => {
    let fail: (() => Promise<unknown>) | null = async () => Promise.reject(new TypeError("integrity"));
    const f = vi.fn(async () => (fail ? fail() : new Response("x")));
    vi.stubGlobal("fetch", f);
    vi.spyOn(URL, "createObjectURL").mockReturnValue(`blob:${ORIGIN}/b`);
    let made = 0;
    vi.stubGlobal(
      "Worker",
      class {
        constructor() {
          made++;
        }
      },
    );
    const { startPowWorker } = await import("./pow-source.verified");
    expect(await errorOf(startPowWorker)).toBe("reseau");
    fail = async () => new Response("", { status: 404 });
    expect(await errorOf(startPowWorker)).toBe("reseau");
    expect(made).toBe(0);
    fail = null;
    await startPowWorker();
    expect(f).toHaveBeenCalledTimes(3);
    expect(made).toBe(1);
  });
});

describe("démo (pow-source.demo.ts)", () => {
  it("aucun Worker, aucune requête (preuve factice du faux serveur)", async () => {
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    const { startPowWorker } = await import("./pow-source.demo");
    expect(await errorOf(startPowWorker)).toBe("pow_indisponible");
    expect(f).not.toHaveBeenCalled();
  });
});

const CHALLENGE = { algorithm: "SHA-256", challenge: "a".repeat(64), maxNumber: 10, salt: "s", signature: "x" };

/** Faux Worker : garde les messages reçus, rend ceux qu'on lui donne. */
class FakeWorker {
  static last: FakeWorker | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  posted: unknown[] = [];
  terminated = 0;
  constructor() {
    FakeWorker.last = this;
  }
  postMessage(m: unknown) {
    this.posted.push(m);
  }
  terminate() {
    this.terminated++;
  }
  reply(data: unknown) {
    this.onmessage?.({ data } as MessageEvent);
  }
}

describe("solvePow", () => {
  it("Worker de pow-source ; échec de création : Error(\"pow_indisponible\")", async () => {
    vi.doMock("./pow-source", () => ({ startPowWorker: async () => Promise.reject(new Error("reseau")) }));
    const { solvePow } = await import("./pow");
    expect(await errorOf(() => solvePow(CHALLENGE))).toBe("pow_indisponible");
  });

  it("solution rendue par le Worker : preuve ; Worker arrêté", async () => {
    vi.doMock("./pow-source", () => ({ startPowWorker: async () => new FakeWorker() as unknown as Worker }));
    const { solvePow } = await import("./pow");
    const tried: number[] = [];
    const p = solvePow(CHALLENGE, undefined, (n) => tried.push(n));
    await vi.waitFor(() => expect(FakeWorker.last?.posted.length).toBe(1));
    const w = FakeWorker.last!;
    w.reply({ tried: 5 });
    w.reply({ number: 3, took: 7 });
    const proof = await p;
    expect(proof.kind).toBe("pow");
    expect(tried).toEqual([5]);
    expect(w.terminated).toBe(1);
  });

  it("arrêt demandé pendant la lecture du script : AbortError, le Worker est arrêté sans rien recevoir", async () => {
    let release!: () => void;
    const ready = new Promise<void>((r) => (release = r));
    const w = new FakeWorker();
    vi.doMock("./pow-source", () => ({ startPowWorker: async () => (await ready, w as unknown as Worker) }));
    const { solvePow } = await import("./pow");
    const ac = new AbortController();
    const p = solvePow(CHALLENGE, ac.signal);
    ac.abort();
    release();
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
    expect(w.posted).toEqual([]);
    expect(w.terminated).toBe(1);
  });
});
