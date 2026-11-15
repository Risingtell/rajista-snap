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
const DEVICE_TIMEOUT_MS = 90_000;

const deviceModel = getGenerativeModel(ai, {
  mode: InferenceMode.ONLY_ON_DEVICE,
  onDeviceParams: {
    createOptions: { expectedInputs: [{ type: "image" }] },
    promptOptions: { responseConstraint: INVOICE_JSON_SCHEMA },
  },
});

const cloudModel = getGenerativeModel(ai, {
  mode: InferenceMode.ONLY_IN_CLOUD,
  inCloudParams: {
    model: CLOUD_MODEL,
    generationConfig: { responseMimeType: "application/json", responseJsonSchema: INVOICE_JSON_SCHEMA },
  },
});

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
  tokens?: { prompt: number; output: number };
};

const withTimeout = <T,>(p: Promise<T>, ms: number) =>
  Promise.race([p, new Promise<never>((_, no) => setTimeout(() => no(new Error(`no answer after ${ms / 1000} s`)), ms))]);

const ask = (model: typeof cloudModel, photo: Photo) =>
  model.generateContent([READ_PROMPT, { type: "inlineData", inlineData: { data: photo.base64, mimeType: photo.mimeType } }]);

function parse(r: GenerateContentResult): Invoice {
  return normalize(r.response.text());
}

export async function readInvoice(photo: Photo, onStep: (step: "device" | "cloud") => void): Promise<Reading> {
  let device: Attempt | undefined;
  let whyCloud: string;
  const status = await deviceStatus();

  if (status === "available") {
    onStep("device");
    const t = performance.now();
    try {
      const invoice = parse(await withTimeout(ask(deviceModel, photo), DEVICE_TIMEOUT_MS));
      const check = checkSums(invoice);
      device = { ms: Math.round(performance.now() - t), invoice, check };
      if (check.ok) return { invoice, check, source: "device", ms: device.ms, device };
      whyCloud = `The on-device read did not add up: ${check.problems[0]}`;
    } catch (e) {
      device = { ms: Math.round(performance.now() - t), error: String((e as Error).message ?? e) };
      whyCloud = "The on-device model could not read this photo.";
    }
  } else {
    whyCloud = status === "unsupported" ? "This browser has no on-device model." : "The on-device model is not ready on this computer.";
  }

  onStep("cloud");
  const t = performance.now();
  const r = await ask(cloudModel, photo);
  const invoice = parse(r);
  const u = r.response.usageMetadata;
  return {
    invoice,
    check: checkSums(invoice),
    source: "cloud",
    ms: Math.round(performance.now() - t),
    device,
    whyCloud,
    tokens: u ? { prompt: u.promptTokenCount, output: u.candidatesTokenCount + (u.thoughtsTokenCount ?? 0) } : undefined,
  };
}
