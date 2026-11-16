// The hybrid reader. Every AI call goes through Firebase AI Logic.
//
//   1. If this browser has the on-device model, read the photo on the device.
//   2. Check the sums (src/invoice.ts). If they add up, keep the on-device read.
//   3. If they don't, or the device cannot read at all, send the photo to the cloud model.
//
// The shop owner sees which reader produced each invoice and why it moved to the cloud.
import { getGenerativeModel, InferenceMode, type GenerateContentResult } from "firebase/ai";
import { ai } from "./firebase";
import { checkSums, INVOICE_JSON_SCHEMA, normalize, READ_PROMPT, type Check, type Invoice } from "./invoice";
import type { Photo } from "./image";

export const CLOUD_MODEL = "gemini-3.5-flash-lite";
/** A stronger cloud model, used only when the first cloud read does not add up (a sideways or faint photo). */
export const STRONG_MODEL = "gemini-3.6-flash";
const DEVICE_TIMEOUT_MS = 90_000;
const STRONG_TIMEOUT_MS = 45_000;
const CLOUD_TIMEOUT_MS = 40_000;

const deviceModel = getGenerativeModel(ai, {
  mode: InferenceMode.ONLY_ON_DEVICE,
  onDeviceParams: {
    createOptions: { expectedInputs: [{ type: "image" }], expectedOutputs: [{ type: "text", languages: ["en"] }] },
    promptOptions: { responseConstraint: INVOICE_JSON_SCHEMA },
  },
});

const cloud = (model: string) =>
  getGenerativeModel(ai, {
    mode: InferenceMode.ONLY_IN_CLOUD,
    inCloudParams: { model, generationConfig: { responseMimeType: "application/json", responseJsonSchema: INVOICE_JSON_SCHEMA } },
  });
const cloudModel = cloud(CLOUD_MODEL);
const strongModel = cloud(STRONG_MODEL);

// ---- on-device model status (Chrome's built-in Prompt API) ---------------------------------------------
type LM = {
  availability(o?: object): Promise<"unavailable" | "downloadable" | "downloading" | "available">;
  create(o?: object): Promise<{ destroy(): void }>;
};
const lm = (): LM | undefined => (globalThis as unknown as { LanguageModel?: LM }).LanguageModel;
export type DeviceStatus = "unsupported" | "unavailable" | "downloadable" | "downloading" | "available";
const IMAGE_INPUT = { expectedInputs: [{ type: "image" }] };

export async function deviceStatus(): Promise<DeviceStatus> {
  const api = lm();
  if (!api) return "unsupported";
  try {
    return await api.availability(IMAGE_INPUT);
  } catch {
    return "unavailable";
  }
}

/** Downloads Chrome's on-device model (a one-off, a few minutes). No prompt is sent. */
export async function downloadDeviceModel(onProgress: (fraction: number) => void): Promise<void> {
  const api = lm();
  if (!api) throw new Error("This browser has no on-device model.");
  const s = await api.create({
    ...IMAGE_INPUT,
    monitor(m: EventTarget) {
      m.addEventListener("downloadprogress", (e) => onProgress((e as ProgressEvent).loaded));
    },
  });
  s.destroy();
}

// ---- reading ---------------------------------------------------------------------------------------------
export type Attempt = { ms: number; invoice?: Invoice; check?: Check; error?: string };
export type Reading = {
  invoice: Invoice;
  check: Check;
  source: "device" | "cloud";
  ms: number;
  device?: Attempt; // the on-device try, when there was one
  whyCloud?: string; // one plain sentence, when the cloud was used
  /** Every cloud call made for this read, so the cost counter can price each at its own model's rate. */
  calls: { model: string; prompt: number; output: number }[];
  model?: string; // the cloud model whose read is shown
  stepUp?: string; // why the stronger model was used, when it was
};

const withTimeout = <T,>(p: Promise<T>, ms: number) =>
  Promise.race([p, new Promise<never>((_, no) => setTimeout(() => no(new Error(`no answer after ${ms / 1000} s`)), ms))]);

const ask = (model: typeof cloudModel, photo: Photo) =>
  model.generateContent([READ_PROMPT, { type: "inlineData", inlineData: { data: photo.base64, mimeType: photo.mimeType } }]);

function parse(r: GenerateContentResult): Invoice {
  return normalize(r.response.text());
}

export async function readInvoice(photo: Photo, onStep: (step: "device" | "cloud") => void, opts: { forceCloud?: boolean } = {}): Promise<Reading> {
  let device: Attempt | undefined;
  let whyCloud: string;
  const status = opts.forceCloud ? null : await deviceStatus();

  if (opts.forceCloud) {
    whyCloud = "You asked for a cloud read.";
  } else if (status === "available") {
    onStep("device");
    const t = performance.now();
    try {
      const invoice = parse(await withTimeout(ask(deviceModel, photo), DEVICE_TIMEOUT_MS));
      const check = checkSums(invoice);
      device = { ms: Math.round(performance.now() - t), invoice, check };
      if (check.ok && check.crossChecked) return { invoice, check, source: "device", ms: device.ms, device, calls: [] };
      whyCloud = check.ok
        ? "The on-device read had nothing to check its prices against (no invoice total to match), so the cloud read it."
        : `The on-device read did not add up: ${check.problems[0]}`;
    } catch (e) {
      device = { ms: Math.round(performance.now() - t), error: String((e as Error).message ?? e) };
      whyCloud = "The on-device model could not read this photo.";
    }
  } else {
    whyCloud = status === "unsupported" ? "This browser has no on-device model." : "The on-device model is not ready on this computer.";
  }

  onStep("cloud");
  const t = performance.now();
  const calls: Reading["calls"] = [];
  const cloudRead = async (model: typeof cloudModel, name: string) => {
    const r = await withRetry(() => withTimeout(ask(model, photo), CLOUD_TIMEOUT_MS));
    const u = r.response.usageMetadata;
    if (u) calls.push({ model: name, prompt: u.promptTokenCount, output: u.candidatesTokenCount + (u.thoughtsTokenCount ?? 0) });
    const invoice = parse(r);
    return { invoice, check: checkSums(invoice) };
  };

  let best: { invoice: Invoice; check: Check };
  let model = CLOUD_MODEL;
  let stepUp: string | undefined;
  try {
    best = await cloudRead(cloudModel, CLOUD_MODEL);
  } catch (e) {
    // The quick model is overloaded or down: the stronger model reads it instead.
    stepUp = "The quick cloud model was busy, so a stronger model read it.";
    onStep("cloud");
    best = await withTimeout(cloudRead(strongModel, STRONG_MODEL), STRONG_TIMEOUT_MS).catch(() => {
      throw new Error(`Google's AI is busy right now (${String((e as Error).message ?? e).slice(0, 80)}). Please try again in a minute.`);
    });
    model = STRONG_MODEL;
    return { ...best, source: "cloud", ms: Math.round(performance.now() - t), device, whyCloud, calls, model, stepUp };
  }

  // Local development only: add ?strong to the address to force the step-up and test the stronger model.
  const forceStrong = import.meta.env.DEV && typeof location !== "undefined" && new URLSearchParams(location.search).has("strong");
  if (!best.check.ok || forceStrong) {
    // The quick model's read does not add up: ask the stronger model before showing anything.
    stepUp = best.check.ok
      ? "A stronger model read it again (test mode)."
      : `The first cloud read did not add up (${best.check.problems[0]}), so a stronger model read it again.`;
    onStep("cloud");
    try {
      const strong = await withTimeout(cloudRead(strongModel, STRONG_MODEL), STRONG_TIMEOUT_MS);
      if (strong.check.ok || strong.check.problems.length < best.check.problems.length) {
        best = strong;
        model = STRONG_MODEL;
      }
    } catch {
      stepUp += " The stronger model did not answer in time, so the first read is shown: please check it.";
    }
  }
  return { ...best, source: "cloud", ms: Math.round(performance.now() - t), device, whyCloud, calls, model, stepUp };
}

/** Retries a cloud call that failed because the service was busy (HTTP 429 or 5xx), twice, with a short wait. */
async function withRetry<T>(call: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await call();
    } catch (e) {
      const busy = /\[(429|500|502|503|504)\b|high demand|overloaded|unavailable/i.test(String((e as Error).message ?? e));
      if (!busy || attempt >= 2) throw e;
      await new Promise((r) => setTimeout(r, attempt === 0 ? 1500 : 4000));
    }
  }
}
