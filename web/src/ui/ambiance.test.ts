// @vitest-environment happy-dom
// Lumière d'ambiance gardée au montage : les calques écrits au build restent (mêmes
// éléments), Aurora les reprend sans en dessiner d'autres et leur pose échelles et pause.
import { flushSync, mount, unmount } from "svelte";
import { describe, expect, it } from "vitest";
import { reprendreAmbiance, viderSaufAmbiance } from "./ambiance";
import Aurora from "./Aurora.svelte";

const ECRIT = '<div class="night"></div><div class="aurora" data-ambient=""><img><img><img><img></div><div class="grain"></div><main><h1>Accueil écrit</h1></main>';

describe("ambiance gardée", () => {
  it("garde les trois calques, retire le reste ; Aurora les reprend une fois, sans doublon", () => {
    const app = document.createElement("div");
    app.innerHTML = ECRIT;
    document.body.append(app);
    const aurora = app.querySelector(".aurora")!;
    viderSaufAmbiance(app);
    expect([...app.children].map((e) => e.className)).toEqual(["night", "aurora", "grain"]);
    expect(app.querySelector(".aurora")).toBe(aurora);
    const c = mount(Aurora as never, { target: app, props: {} });
    flushSync();
    expect(app.querySelectorAll(".aurora").length).toBe(1);
    expect(app.querySelectorAll(".aurora img").length).toBe(4);
    expect((aurora as HTMLElement).style.getPropertyValue("--kx")).not.toBe("");
    expect(reprendreAmbiance()).toBeNull(); // déjà reprise
    unmount(c);
    app.remove();
  });

  it("sans calques écrits : tout est vidé et Aurora dessine les siens", () => {
    const app = document.createElement("div");
    app.innerHTML = "<main><h1>x</h1></main>";
    document.body.append(app);
    viderSaufAmbiance(app);
    expect(app.children.length).toBe(0);
    const c = mount(Aurora as never, { target: app, props: {} });
    flushSync();
    expect(app.querySelectorAll(".aurora[data-ambient] img").length).toBe(4);
    unmount(c);
    app.remove();
  });
});
