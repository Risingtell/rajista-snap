// The hybrid reader. Every AI call goes through Firebase AI Logic.
//
//   1. If this browser has the on-device model, read the photo on the device.
//   2. Check the sums (src/invoice.ts). Keep the on-device read only if another number on the page confirms it.
//   3. Otherwise send the photo to the quick cloud model. If that read does not add up either, the stronger cloud
//      model reads it again, and the two reads are reconciled (src/invoice.ts): the same numbers twice means the
//      paper itself is wrong; different numbers are shown to the owner to check.
//
// The shop owner sees which reader produced each invoice and why it moved to the cloud.
import { getGenerativeModel, InferenceMode, type GenerateContentResult } from "firebase/ai";
import { ai } from "./firebase";
import { checkSums, INVOICE_JSON_SCHEMA, normalize, READ_PROMPT, reconcile, type Check, type Dispute, type Invoice } from "./invoice";
import type { Photo } from "./image";

export const CLOUD_MODEL = "gemini-3.5-flash-lite";
/** A stronger cloud model, used only when the first cloud read does not add up (a sideways or faint photo). */
export const STRONG_MODEL = "gemini-3.6-flash";
/** Time limits, each covering a reader's retries too. A call still running at its limit is cancelled. */
const DEVICE_TIMEOUT_MS = 90_000;
const QUICK_TIMEOUT_MS = 50_000;
const STRONG_TIMEOUT_MS = 50_000;

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
  /** Only when two separate reads found exactly the same numbers and they do not add up: the paper itself is wrong. */
  paperError?: string;
  /** Numbers the two cloud reads disagree on, for the owner to check against the paper. */
  disputes?: Dispute[];
};

/** Runs `fn` with a signal that is aborted after `ms`; rejects with a plain message then. The timer is always cleared. */
function timed<T>(fn: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  const ctl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, no) => {
    timer = setTimeout(() => {
      ctl.abort();
      no(new Error(`no answer after ${ms / 1000} s`));
    }, ms);
  });
  return Promise.race([fn(ctl.signal), limit]).finally(() => clearTimeout(timer));
}

const ask = (model: typeof cloudModel, photo: Photo, signal: AbortSignal) =>
  model.generateContent([READ_PROMPT, { type: "inlineData", inlineData: { data: photo.base64, mimeType: photo.mimeType } }], { signal });

function parse(r: GenerateContentResult): Invoice {
  return normalize(r.response.text());
}

const message = (e: unknown) => String((e as Error)?.message ?? e);
const refusedByAppCheck = (e: unknown) => /app ?check|\[40[13]\b/i.test(message(e));

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
      const invoice = parse(await timed((signal) => ask(deviceModel, photo, signal), DEVICE_TIMEOUT_MS));
      const check = checkSums(invoice);
      device = { ms: Math.round(performance.now() - t), invoice, check };
      if (check.ok && check.crossChecked) return { invoice, check, source: "device", ms: device.ms, device, calls: [] };
      whyCloud = check.ok
        ? "The on-device read had nothing to check its prices against (no invoice total to match), so the cloud read it."
        : `The on-device read did not add up: ${check.problems[0]}`;
    } catch (e) {
      device = { ms: Math.round(performance.now() - t), error: message(e) };
      whyCloud = "The on-device model could not read this photo.";
    }
  } else {
    whyCloud = status === "unsupported" ? "This browser has no on-device model." : "The on-device model is not ready on this computer.";
  }

  onStep("cloud");
  const t = performance.now();
  const calls: Reading["calls"] = [];
  let finished = false; // a cancelled call that answers late must not change a reading already shown
  let model = CLOUD_MODEL;
  let stepUp: string | undefined;

  const cloudRead = (m: typeof cloudModel, name: string, ms: number) =>
    timed(async (signal) => {
      const r = await withRetry(() => ask(m, photo, signal), signal);
      const u = r.response.usageMetadata;
      if (u && !finished) calls.push({ model: name, prompt: u.promptTokenCount, output: u.candidatesTokenCount + (u.thoughtsTokenCount ?? 0) });
      return parse(r);
    }, ms);

  const finish = (invoice: Invoice, extra: Partial<Reading> = {}): Reading => {
    finished = true;
    return { invoice, check: checkSums(invoice), source: "cloud", ms: Math.round(performance.now() - t), device, whyCloud, calls: [...calls], model, stepUp, ...extra };
  };

  let first: Invoice;
  try {
    first = await cloudRead(cloudModel, CLOUD_MODEL, QUICK_TIMEOUT_MS);
  } catch (e) {
    if (refusedByAppCheck(e)) {
      throw new Error(
        "Google's security check did not accept this browser, so the AI would not read the photo. Reload the page and try again. If it keeps happening, try another browser or come back later.",
      );
    }
    // The quick model is busy or down: the stronger model reads it instead.
    stepUp = "The quick cloud model was busy, so a stronger model read it.";
    model = STRONG_MODEL;
    onStep("cloud");
    let strong: Invoice;
    try {
      strong = await cloudRead(strongModel, STRONG_MODEL, STRONG_TIMEOUT_MS);
    } catch {
      finished = true;
      throw new Error("Google's AI is busy right now. Please try again in a minute.");
    }
    return finish(strong);
  }

  // Local development only: add ?strong to the address to force the step-up and test the stronger model.
  const forceStrong = import.meta.env.DEV && typeof location !== "undefined" && new URLSearchParams(location.search).has("strong");
  const firstCheck = checkSums(first);
  if (firstCheck.ok && !forceStrong) return finish(first);

  // The quick model's read does not add up: ask the stronger model before showing anything.
  stepUp = firstCheck.ok ? "A stronger model read it again (test mode)." : `The first cloud read did not add up (${firstCheck.problems[0]}), so a stronger model read it again.`;
  onStep("cloud");
  let second: Invoice;
  try {
    second = await cloudRead(strongModel, STRONG_MODEL, STRONG_TIMEOUT_MS);
  } catch {
    stepUp += " The stronger model did not answer in time, so the first read is shown: please check it against the paper.";
    return finish(first);
  }
  const r = reconcile(first, second);
  model = r.from === "second" ? STRONG_MODEL : CLOUD_MODEL;
  return finish(r.invoice, { paperError: r.paperError, disputes: r.disputes.length ? r.disputes : undefined });
}

/** Retries a cloud call that failed because the service was busy (HTTP 429 or 5xx), twice, unless it was cancelled. */
async function withRetry<T>(call: () => Promise<T>, signal: AbortSignal): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await call();
    } catch (e) {
      const busy = /\[(429|500|502|503|504)\b|high demand|overloaded|unavailable/i.test(message(e));
      if (!busy || attempt >= 2 || signal.aborted) throw e;
      await new Promise<void>((ok) => {
        const id = setTimeout(ok, attempt === 0 ? 1500 : 4000);
        signal.addEventListener("abort", () => (clearTimeout(id), ok()), { once: true });
      });
      if (signal.aborted) throw e;
    }
  }
}
