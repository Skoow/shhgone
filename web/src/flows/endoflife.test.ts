import { afterEach, describe, expect, it, vi } from "vitest";
import { LimitError, NotFoundError, type Opened } from "../index";
import { liveUrls, trackUrl } from "../viewers/blobs";
import { destroyFromContent, finish, release } from "./endoflife";

function fake(destroy: () => Promise<void> = async () => undefined, done: () => Promise<void> = async () => undefined, gone = true) {
  const log: string[] = [];
  const o = {
    destroy: vi.fn(async () => {
      log.push("destroy()");
      await destroy();
      log.push("destroy résolu");
    }),
    report: vi.fn(async (r: number) => {
      log.push(`report(${r})`);
      await destroy();
      log.push("report résolu");
      return gone;
    }),
    done: vi.fn(async () => {
      log.push("done");
      await done();
    }),
    wipe: vi.fn(() => void log.push("wipe")),
  } as unknown as Opened;
  return { o, log };
}

afterEach(() => vi.restoreAllMocks());

describe("finish", () => {
  it("done() → wipe() → révocation des URL ; un done() en échec efface quand même", async () => {
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:x/a");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    trackUrl(new Blob(["a"]));
    const a = fake();
    await finish(a.o);
    expect(a.log).toEqual(["done", "wipe"]);
    expect(liveUrls()).toBe(0);
    const b = fake(undefined, async () => Promise.reject(new Error("reseau")));
    await expect(finish(b.o)).resolves.toBeUndefined();
    expect(b.log).toEqual(["done", "wipe"]);
  });
});

describe("release (pagehide, démontage ; spec §41.4)", () => {
  it("wipe() et révocation, jamais done() : l'ouverture reste rouvrable par son octroi", () => {
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:x/b");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    trackUrl(new Blob(["b"]));
    const a = fake();
    release(a.o);
    expect(a.log).toEqual(["wipe"]);
    expect(liveUrls()).toBe(0);
  });
});

describe("destroyFromContent", () => {
  it("Détruire : destroy() ; Signaler : report(catégorie) ; wipe et onDestroyed après la réponse", async () => {
    for (const report of [null, 4] as const) {
      let release!: () => void;
      const { o, log } = fake(() => new Promise<void>((r) => (release = r)));
      const onDestroyed = vi.fn(() => void log.push("dissolution"));
      const p = destroyFromContent(o, report, { onDestroyed });
      await new Promise((r) => setTimeout(r, 0));
      expect(onDestroyed).not.toHaveBeenCalled();
      expect(o.wipe).not.toHaveBeenCalled();
      release();
      expect(await p).toBe("destroyed");
      if (report !== null) expect(o.report).toHaveBeenCalledWith(4);
      else expect(o.destroy).toHaveBeenCalledWith();
      const v = report !== null ? "report" : "destroy";
      expect(log).toEqual([report !== null ? "report(4)" : "destroy()", `${v} résolu`, "wipe", "dissolution"]);
    }
  });
  it("Signaler sans atteindre la moitié des ouvertures : « reported », rien n'est effacé", async () => {
    const { o } = fake(undefined, undefined, false);
    const onDestroyed = vi.fn();
    expect(await destroyFromContent(o, 3, { onDestroyed })).toBe("reported");
    expect(o.wipe).not.toHaveBeenCalled();
    expect(onDestroyed).not.toHaveBeenCalled();
  });
  it("NotFoundError → wipe(), gone", async () => {
    const { o } = fake(async () => Promise.reject(new NotFoundError()));
    const onDestroyed = vi.fn();
    expect(await destroyFromContent(o, null, { onDestroyed })).toBe("gone");
    expect(o.wipe).toHaveBeenCalledTimes(1);
    expect(onDestroyed).toHaveBeenCalledTimes(1);
  });
  it("reseau → network ; 429 → limit (ruling 7) ; wipe et onDestroyed jamais appelés", async () => {
    for (const [e, want] of [[new Error("reseau"), "network"], [new LimitError(5), "limit"]] as const) {
      const { o } = fake(async () => Promise.reject(e));
      const onDestroyed = vi.fn();
      expect(await destroyFromContent(o, 10, { onDestroyed })).toBe(want);
      expect(o.wipe).not.toHaveBeenCalled();
      expect(onDestroyed).not.toHaveBeenCalled();
    }
  });
});
