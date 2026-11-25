// Enregistreur vocal : faux MediaRecorder, faux flux, fausse horloge.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MINI_BARS, RATES, WAVE_BARS, WAVE_CAP, WaveAccumulator, nextRate, rateLabel, resample, seekRatio, startVoice, type AudioCtxCtor, type VoiceRecorderCtor } from "./recorder";

class FakeRec {
  static last: FakeRec;
  state = "inactive";
  calls: string[] = [];
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  constructor(
    readonly stream: MediaStream,
    readonly opts: { mimeType: string; audioBitsPerSecond?: number },
  ) {
    FakeRec.last = this;
  }
  start() {
    this.state = "recording";
    this.calls.push("start");
  }
  pause() {
    this.state = "paused";
    this.calls.push("pause");
  }
  resume() {
    this.state = "recording";
    this.calls.push("resume");
  }
  stop() {
    this.state = "inactive";
    this.calls.push("stop");
    this.ondataavailable?.({ data: new Blob(["voix"]) });
    this.onstop?.();
  }
}

function fakeStream() {
  const tracks = [{ stop: vi.fn(), kind: "audio" }];
  return { stream: { getTracks: () => tracks } as unknown as MediaStream, tracks };
}

function fakeAudio(samples: number[]) {
  const closed = vi.fn(async () => undefined);
  class Ctx {
    createMediaStreamSource() {
      return { connect: () => undefined, disconnect: () => undefined };
    }
    createAnalyser() {
      return {
        fftSize: 0,
        getFloatTimeDomainData(a: Float32Array) {
          for (let i = 0; i < a.length; i++) a[i] = samples[i % samples.length]!;
        },
      };
    }
    close = closed;
  }
  return { Audio: Ctx as unknown as AudioCtxCtor, closed };
}

const PICK = { mime: "audio/webm;codecs=opus", ext: "webm" };
let t = 0;
const now = () => t;
beforeEach(() => {
  t = 0;
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe("startVoice", () => {
  it("enregistrement → pause (minuteur figé) → reprise → arrêt : fichier typé, pistes et contexte arrêtés", async () => {
    const { stream, tracks } = fakeStream();
    const { Audio, closed } = fakeAudio([0.3, -0.3]);
    const r = startVoice(stream, PICK, { Recorder: FakeRec as unknown as VoiceRecorderCtor, Audio, now, maxMs: 60_000 });
    expect(r.state()).toBe("recording");
    expect(FakeRec.last.opts.audioBitsPerSecond).toBe(128_000);
    t = 2000;
    vi.advanceTimersByTime(50); // une mesure du niveau
    expect(r.elapsedMs()).toBe(2000);
    expect(r.level()).toBeGreaterThan(0.5);
    r.pause();
    expect(r.state()).toBe("paused");
    t = 9000;
    expect(r.elapsedMs()).toBe(2000); // figé pendant la pause
    expect(r.level()).toBe(0);
    r.resume();
    t = 10_500;
    expect(r.elapsedMs()).toBe(3500);
    const blob = await r.stop();
    expect(blob.type).toBe("audio/webm");
    expect(await blob.text()).toBe("voix");
    expect(FakeRec.last.calls).toEqual(["start", "pause", "resume", "stop"]);
    expect(r.state()).toBe("stopped");
    expect(r.elapsedMs()).toBe(3500);
    expect(tracks[0]!.stop).toHaveBeenCalled();
    expect(closed).toHaveBeenCalled();
  });

  it("annulation : rien n'est gardé, pistes arrêtées, contexte fermé", async () => {
    const { stream, tracks } = fakeStream();
    const { Audio, closed } = fakeAudio([0]);
    const r = startVoice(stream, PICK, { Recorder: FakeRec as unknown as VoiceRecorderCtor, Audio, now, maxMs: 60_000 });
    r.cancel();
    expect(tracks[0]!.stop).toHaveBeenCalled();
    expect(closed).toHaveBeenCalled();
    expect((await r.stop()).size).toBe(0);
  });

  it("durée maximale : onlimit au temps enregistré, pauses exclues", () => {
    const { stream } = fakeStream();
    const onlimit = vi.fn();
    const r = startVoice(stream, PICK, { Recorder: FakeRec as unknown as VoiceRecorderCtor, Audio: null, now, maxMs: 5000, onlimit });
    vi.advanceTimersByTime(3000);
    t = 3000;
    r.pause();
    vi.advanceTimersByTime(10_000);
    t = 13_000;
    expect(onlimit).not.toHaveBeenCalled();
    r.resume();
    vi.advanceTimersByTime(1999);
    expect(onlimit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onlimit).toHaveBeenCalledTimes(1);
    expect(r.level()).toBe(0); // sans Web Audio : onde au repos, enregistrement normal
  });

  it("pause et reprise ignorées hors de leur état", () => {
    const { stream } = fakeStream();
    const r = startVoice(stream, PICK, { Recorder: FakeRec as unknown as VoiceRecorderCtor, Audio: null, now, maxMs: 5000 });
    r.resume();
    r.pause();
    r.pause();
    expect(FakeRec.last.calls).toEqual(["start", "pause"]);
  });
});

describe("onde", () => {
  it("niveau en décibels : plein niveau 1, −40 dB entre 0,3 et 0,5, borné", () => {
    const at = (samples: number[]) => {
      const r = startVoice(fakeStream().stream, PICK, { Recorder: FakeRec as unknown as VoiceRecorderCtor, Audio: fakeAudio(samples).Audio, now, maxMs: 60_000 });
      vi.advanceTimersByTime(50);
      const v = r.level();
      r.cancel();
      return v;
    };
    expect(at([1, -1])).toBe(1);
    const mid = at([0.01, -0.01]);
    expect(mid).toBeGreaterThan(0.3);
    expect(mid).toBeLessThan(0.5);
    expect(at([0, 0])).toBe(0);
  });

  it("resample et seekRatio", () => {
    expect(resample([1, 0, 1, 0], 2)).toEqual([0.5, 0.5]);
    expect(resample(new Array(WAVE_BARS).fill(0.4), MINI_BARS)).toHaveLength(MINI_BARS);
    expect(seekRatio(50, 0, 200)).toBe(0.25);
    expect(seekRatio(-10, 0, 200)).toBe(0);
    expect(seekRatio(500, 0, 200)).toBe(1);
    expect(seekRatio(5, 0, 0)).toBe(0);
  });

  it("onde de la réécoute mesurée en continu (sans decodeAudioData), pauses exclues", async () => {
    const { stream } = fakeStream();
    const level = [0.5]; // niveau piloté par le test
    const { Audio } = fakeAudio(level);
    const Offline = vi.fn();
    vi.stubGlobal("OfflineAudioContext", Offline);
    const r = startVoice(stream, PICK, { Recorder: FakeRec as unknown as VoiceRecorderCtor, Audio, now, maxMs: 60_000 });
    for (let k = 0; k < 20; k++) (t += 50, vi.advanceTimersByTime(50));
    r.pause();
    level[0] = 0;
    for (let k = 0; k < 20; k++) (t += 50, vi.advanceTimersByTime(50));
    r.resume();
    level[0] = 0.1;
    for (let k = 0; k < 20; k++) (t += 50, vi.advanceTimersByTime(50));
    const p = r.stop();
    await p;
    const w = r.wave(4)!;
    expect(w).toHaveLength(4);
    expect(w[0]).toBe(1); // première moitié : fort
    expect(w[3]).toBeCloseTo(0.2, 1); // seconde moitié : faible ; la pause n'a laissé aucune case
    expect(Offline).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
  it("WaveAccumulator : mémoire bornée quelle que soit la durée (2 h)", () => {
    const acc = new WaveAccumulator();
    for (let ms = 0; ms < 2 * 3600_000; ms += 50) acc.add(ms, ms < 3600_000 ? 0.8 : 0.2);
    expect(acc.size).toBeLessThanOrEqual(WAVE_CAP);
    const w = acc.bars(60)!;
    expect(w).toHaveLength(60);
    expect(w[0]).toBe(1);
    expect(w[59]).toBeCloseTo(0.25, 2);
    expect(new WaveAccumulator().bars()).toBeNull();
  });
});

describe("vitesse de lecture", () => {
  it("alterne 1× → 1,5× → 2× → 1×, et revient à 1× sur une valeur inconnue", () => {
    expect(RATES).toEqual([1, 1.5, 2]);
    expect(nextRate(1)).toBe(1.5);
    expect(nextRate(1.5)).toBe(2);
    expect(nextRate(2)).toBe(1);
    expect(nextRate(3)).toBe(1);
  });
  it("libellé selon la langue", () => {
    expect(rateLabel(1.5, "fr")).toBe("1,5×");
    expect(rateLabel(1.5, "en")).toBe("1.5×");
    expect(rateLabel(2, "fr")).toBe("2×");
  });
});
