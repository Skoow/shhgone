// Anti-robot ALTCHA de la création d'un partage (décision du 26 novembre ; spec §22 D4) : toujours
// exigé, au niveau 0 pour une première création, calculé en tâche de fond pendant la composition.
// Le temps de calcul rapporté par le Worker est relevé tel quel, puis avec le processeur ralenti
// 4 fois (téléphone moyen) : chiffres dans la sortie (« [mesure anti-robot] »).
import type { Request } from "@playwright/test";
import { expect, test } from "./fixtures";
import { sendShare } from "./open-helpers";

test.use({ locale: "fr-FR" });
test.skip(({ browserName }) => browserName !== "chromium", "ralentissement du processeur par CDP : Chromium seulement");

for (const ralenti of [1, 4]) {
  test(`création d'un partage : preuve exigée, niveau 0, calcul mesuré (processeur ×${ralenti})`, async ({ page, shh, isMobile }) => {
    test.setTimeout(120_000);
    const corps: string[] = [];
    page.on("request", (r: Request) => {
      if (r.method() === "POST" && new URL(r.url()).pathname === "/api/shares") corps.push(r.postData() ?? "");
    });
    if (ralenti > 1) await (await page.context().newCDPSession(page)).send("Emulation.setCPUThrottlingRate", { rate: ralenti });
    const sent = await sendShare(page, shh.origin + "/", { text: "Repère anti-robot 5c1e.", protect: false, isMobile });
    expect(sent.link).toMatch(/\/s#l/);
    expect(corps).toHaveLength(1);
    const j = JSON.parse(corps[0]!) as { altcha: string; hp: string; shown_at: string };
    expect(j.hp).toBe("");
    expect(j.shown_at.length).toBeGreaterThan(10);
    const p = JSON.parse(Buffer.from(j.altcha, "base64").toString()) as { took: number; number: number; salt: string };
    const niveau = Number(/\.(\d)\?expires=/.exec(p.salt)![1]);
    expect(niveau).toBe(0);
    console.log(`[mesure anti-robot] ${test.info().project.name} partage ×${ralenti} ${JSON.stringify({ took: p.took, number: p.number, niveau })}`);
  });
}
