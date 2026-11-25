// Résumé d'un partage ouvert pour l'historique de l'appareil (conception compte §21.7) :
// nombre d'éléments, taille, sorte dominante (icône). Jamais un nom ni un contenu.
import { describe, expect, it } from "vitest";
import type { Opened } from "../index";
import { summarizeOpened } from "./received";

function opened(items: { kind: "file" | "text"; name: string; size: number; text?: string; preview?: string }[]): Opened {
  return {
    manifest: { v: 2, rights: "enregistrer", items: items.map((x) => ({ kind: x.kind, name: x.name, mime: "", size: x.size, offset: 0, text: x.text })) },
    safeName: (i: number) => items[i]!.name,
    previewKind: (i: number) => items[i]!.preview ?? "none",
  } as unknown as Opened;
}

describe("summarizeOpened", () => {
  it("compte, taille (notes en octets UTF-8) et sorte dominante ; aucun nom", () => {
    const s = summarizeOpened(
      opened([
        { kind: "file", name: "a.jpg", size: 100, preview: "image" },
        { kind: "file", name: "b.png", size: 200, preview: "image" },
        { kind: "file", name: "rapport secret.pdf", size: 50, preview: "pdf" },
        { kind: "text", name: "note", size: 0, text: "été" },
      ]),
    );
    expect(s).toEqual({ itemsCount: 4, sizeBytes: 355, format: "image" });
    expect(JSON.stringify(s)).not.toMatch(/rapport|secret|\.jpg|été/);
  });
  it("égalité : la première sorte rencontrée ; une seule note : « note » ; vide : « file »", () => {
    expect(summarizeOpened(opened([{ kind: "file", name: "x.pdf", size: 1, preview: "pdf" }, { kind: "file", name: "y.mp3", size: 1, preview: "audio" }])).format).toBe("pdf");
    expect(summarizeOpened(opened([{ kind: "text", name: "", size: 0, text: "x" }])).format).toBe("note");
    expect(summarizeOpened(opened([])).format).toBe("file");
  });
});
