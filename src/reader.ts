// The hybrid reader. Every AI call goes through Firebase AI Logic.
//
//   1. If this browser has the on-device model, read the photo on the device.
//   2. Check the sums (src/invoice.ts). Keep the on-device read only if another number on the page confirms it.
//   3. Otherwise send the photo to the quick cloud model. If that read does not add up either, the quick model
//      reads it a second time and the two reads are reconciled (src/invoice.ts): the same numbers twice means the
//      paper itself is wrong; a dispute over the total alone is settled by one more, narrow read of the written
//      total; only a disagreement over the lines brings in the stronger (slower) model, and anything still unclear
//      is shown to the owner to check.
//
// The shop owner sees which reader produced each invoice and why it moved to the cloud.
import { getGenerativeModel, InferenceMode, InferenceSource, ThinkingLevel, type GenerateContentResult } from "firebase/ai";
import { ai } from "./firebase";
import {
  checkSums,
  sameLines,
  INVOICE_JSON_SCHEMA,
  normalize,
  READ_PROMPT,
  reconcile,
  settleTotal,
  TOTAL_JSON_SCHEMA,
  TOTAL_PROMPT,
  totalOnlyDispute,
  trustDeviceRead,
  type Check,
  type Dispute,
  type Invoice,
} from "./invoice";
import type { Photo } from "./image";
import { CLOUD_MODEL, STRONG_MODEL } from "./models";

export { CLOUD_MODEL, STRONG_MODEL };
/**
 * Time limits, each covering a reader's retries too. A cloud call still running at its limit is cancelled. The
 * on-device model cannot be cancelled through the Firebase SDK, so Snap stops waiting for it and stops using it
 * for the rest of the visit (see deviceSlow), rather than piling more work onto a busy computer.
 */
const DEVICE_TIMEOUT_MS = 90_000;
const QUICK_TIMEOUT_MS = 50_000;
// The stronger model answered in 12 s in the morning of 16 Nov and in 53 to 61 s that afternoon, so it gets more time.
const STRONG_TIMEOUT_MS = 75_000;
const TOTAL_TIMEOUT_MS = 30_000;

// Reading an invoice is copying, not reasoning: the stronger model runs with low thinking, which leaves it less room
// to "fix" the paper's arithmetic.
const cloud = (model: string, schema: { [key: string]: unknown } = INVOICE_JSON_SCHEMA, thinking?: string) =>
  getGenerativeModel(ai, {
    mode: InferenceMode.ONLY_IN_CLOUD,
    inCloudParams: {
      model,
      generationConfig: { responseMimeType: "application/json", responseJsonSchema: schema, ...(thinking ? { thinkingConfig: { thinkingLevel: thinking } } : {}) },
    },
  });
const cloudModel = cloud(CLOUD_MODEL);
const strongModel = cloud(STRONG_MODEL, INVOICE_JSON_SCHEMA, ThinkingLevel.LOW);
const totalModel = cloud(CLOUD_MODEL, TOTAL_JSON_SCHEMA);
type Model = typeof cloudModel;

// ---- on-device model (Chrome's built-in Prompt API) ------------------------------------------------------
type LM = {
  availability(o?: object): Promise<"unavailable" | "downloadable" | "downloading" | "available">;
  create(o?: object): Promise<{ destroy(): void }>;
};
const lm = (): LM | undefined => (globalThis as unknown as { LanguageModel?: LM }).LanguageModel;
export type DeviceStatus = "unsupported" | "unavailable" | "downloadable" | "downloading" | "available";
const IMAGE_INPUT = { expectedInputs: [{ type: "image" }] };

/** Set when the on-device model ran past its time limit: the rest of this visit reads in the cloud. */
let slow = false;
export const deviceSlow = () => slow;

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

/**
 * Builds an ONLY_ON_DEVICE model after checking that Chrome's model is really present. The Firebase SDK decides
 * at creation time whether a device adapter exists, and without one it answers an ONLY_ON_DEVICE call from the
 * cloud. Creating the model here, after the check, means a private request can never be sent to the cloud.
 */
export async function onDeviceModel(params: Parameters<typeof getGenerativeModel>[1] & { mode: typeof InferenceMode.ONLY_ON_DEVICE }) {
  if ((await deviceStatus()) !== "available") throw new Error("The on-device model is not available.");
  return getGenerativeModel(ai, params);
}

/** Throws if a call that was meant to stay on the device was answered in the cloud. */
export function assertOnDevice(r: GenerateContentResult) {
  if (r.response.inferenceSource !== InferenceSource.ON_DEVICE) throw new Error("The answer did not come from the on-device model.");
}

// The on-device model runs one prompt at a time here: a reading waits for any product-matching prompt still
// running (those cannot be cancelled), and while a reading is waiting, no new matching prompts start.
let deviceQueue: Promise<unknown> = Promise.resolve();
let readingWaiting = 0;
export const deviceReadWaiting = () => readingWaiting > 0;
export function onDevice<T>(job: () => Promise<T>, isReading = false): Promise<T> {
  if (isReading) readingWaiting++;
  const run = deviceQueue.then(
    () => {
      if (isReading) readingWaiting--;
      return job();
    },
    () => {
      if (isReading) readingWaiting--;
      return job();
    },
  );
  deviceQueue = run.catch(() => undefined);
  return run;
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
  stepUp?: string; // why the stronger model was used, when it was
  /** Only when the paper's own numbers were confirmed and they do not add up: the mistake is on the invoice. */
  paperError?: string;
  /** Numbers the cloud reads disagree on, for the owner to check against the paper. */
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

const ask = (model: Model, prompt: string, photo: Photo, signal: AbortSignal) =>
  model.generateContent([prompt, { type: "inlineData", inlineData: { data: photo.base64, mimeType: photo.mimeType } }], { signal });

const message = (e: unknown) => String((e as Error)?.message ?? e);

/** What went wrong with a cloud call, in terms the owner can act on. */
type Failure = "appcheck" | "offline" | "network" | "quota" | "busy" | "timeout" | "unreadable";
function failure(e: unknown): Failure {
  const m = message(e);
  if (/app ?check|\[40[13]\b/i.test(m)) return "appcheck";
  if (typeof navigator !== "undefined" && navigator.onLine === false) return "offline";
  if (/no answer after/.test(m)) return "timeout";
  // Google uses the same "quota" wording for a per-minute limit (clears within a minute: retry, as for busy) and
  // for the daily allowance (retrying only wastes time, so it is never retried and the model is skipped).
  if (/quota|exhausted|exceeded your current/i.test(m)) return /per ?day|daily/i.test(m) ? "quota" : "busy";
  if (/\[(429|500|502|503|504)\b|high demand|overloaded|unavailable/i.test(m)) return "busy";
  if (/failed to fetch|network ?error|load failed|network request failed/i.test(m)) return "network";
  return "unreadable";
}
const STEP_UP_BECAUSE: Record<Failure, string> = {
  appcheck: "",
  offline: "",
  quota: "The quick cloud model's free daily allowance is used up, so a stronger model read it.",
  network: "The quick cloud model could not be reached, so a stronger model read it.",
  busy: "The quick cloud model was busy, so a stronger model read it.",
  timeout: "The quick cloud model did not answer in time, so a stronger model read it.",
  unreadable: "The quick cloud model's answer could not be used, so a stronger model read it.",
};
const STRONG_FAILED_BECAUSE: Record<Failure, string> = {
  appcheck: "it was refused by Google's security check",
  offline: "this device went offline",
  quota: "its free daily allowance is used up",
  network: "it could not be reached",
  busy: "it was busy",
  timeout: "it did not answer in time",
  unreadable: "its answer could not be used",
};
function giveUp(e: unknown): never {
  const f = failure(e);
  if (f === "appcheck") {
    throw new Error(
      "Google's security check did not accept this browser, so the AI would not read the photo. Reload the page and try again. If it keeps happening, try another browser or come back later.",
    );
  }
  if (f === "offline") throw new Error("This phone or computer is offline, and this photo needs the cloud to be read. Connect to the internet and try again.");
  if (f === "network") throw new Error("Snap could not reach Google's AI. Check your connection and try again.");
  if (f === "quota") throw new Error("Snap's free daily allowance of Google AI reads is used up. It resets every day: please try again later.");
  throw new Error(`Google's AI could not read this photo right now (${STRONG_FAILED_BECAUSE[f]}). Please try again in a minute.`);
}

/** Cloud models whose free daily allowance ran out during this visit: not called again until the page reloads. */
const spent = new Set<string>();

export async function readInvoice(photo: Photo, onStep: (step: "device" | "cloud") => void, opts: { forceCloud?: boolean } = {}): Promise<Reading> {
  let device: Attempt | undefined;
  let whyCloud: string;
  const status = opts.forceCloud ? null : await deviceStatus();

  if (opts.forceCloud) {
    whyCloud = "You asked for a cloud read.";
  } else if (status === "available" && slow) {
    whyCloud = "The on-device model was too slow on this computer earlier, so Snap reads in the cloud for the rest of this visit.";
  } else if (status === "available") {
    onStep("device");
    const t = performance.now();
    try {
      const r = await onDevice(async () => {
        const model = await onDeviceModel({
          mode: InferenceMode.ONLY_ON_DEVICE,
          onDeviceParams: {
            createOptions: { expectedInputs: [{ type: "image" }], expectedOutputs: [{ type: "text", languages: ["en"] }] },
            promptOptions: { responseConstraint: INVOICE_JSON_SCHEMA },
          },
        });
        return timed((signal) => ask(model as Model, READ_PROMPT, photo, signal), DEVICE_TIMEOUT_MS);
      }, true);
      assertOnDevice(r);
      const invoice = normalize(r.response.text());
      const check = checkSums(invoice);
      device = { ms: Math.round(performance.now() - t), invoice, check };
      if (trustDeviceRead(check)) return { invoice, check, source: "device", ms: device.ms, device, calls: [] };
      whyCloud = !check.ok
        ? `The on-device read did not add up: ${check.problems[0]}`
        : !check.hasPrices
          ? "The on-device read found no prices, so the cloud checked the paper."
          : "The on-device read had nothing to check its prices against (no invoice total to match), so the cloud read it.";
    } catch (e) {
      if (/no answer after/.test(message(e))) slow = true;
      device = { ms: Math.round(performance.now() - t), error: message(e) };
      whyCloud = slow ? "The on-device model took too long, so the cloud read it." : "The on-device model could not read this photo.";
    }
  } else {
    whyCloud = status === "unsupported" ? "This browser has no on-device model." : "The on-device model is not ready on this computer.";
  }

  onStep("cloud");
  const t = performance.now();
  const calls: Reading["calls"] = [];
  let stepUp: string | undefined;

  const call = <T,>(m: Model, name: string, prompt: string, ms: number, read: (r: GenerateContentResult) => T) =>
    timed(async (signal) => {
      if (spent.has(name)) throw new Error(`${name}: free daily quota already used up`);
      const r = await withRetry(() => ask(m, prompt, photo, signal), signal).catch((e) => {
        if (failure(e) === "quota") spent.add(name);
        throw e;
      });
      const u = r.response.usageMetadata;
      if (u) calls.push({ model: name, prompt: u.promptTokenCount, output: u.candidatesTokenCount + (u.thoughtsTokenCount ?? 0) });
      return read(r);
    }, ms);
  const readWith = (m: Model, name: string, ms: number) => call(m, name, READ_PROMPT, ms, (r) => normalize(r.response.text()));

  const finish = (invoice: Invoice, extra: Partial<Reading> = {}): Reading => ({
    invoice,
    check: checkSums(invoice),
    source: "cloud",
    ms: Math.round(performance.now() - t),
    device,
    whyCloud,
    calls: [...calls],
    stepUp,
    ...extra,
  });

  let first: Invoice;
  try {
    first = await readWith(cloudModel, CLOUD_MODEL, QUICK_TIMEOUT_MS);
  } catch (e) {
    const f = failure(e);
    if (f === "appcheck" || f === "offline") giveUp(e);
    // The quick model is busy, unreachable, slow, or answered something unusable: the stronger model reads it.
    stepUp = STEP_UP_BECAUSE[f];
    onStep("cloud");
    let strong: Invoice;
    try {
      strong = await readWith(strongModel, STRONG_MODEL, STRONG_TIMEOUT_MS);
    } catch (e2) {
      giveUp(e2);
    }
    return finish(strong);
  }

  // Local development only: add ?strong to the address to force the second read and test the steps after it.
  const forceStrong = import.meta.env.DEV && typeof location !== "undefined" && new URLSearchParams(location.search).has("strong");
  const firstCheck = checkSums(first);
  if (firstCheck.ok && !forceStrong) return finish(first);

  // The quick read does not add up: the quick model reads the photo a second time before anything is shown.
  stepUp = firstCheck.ok ? "It was read a second time (test mode)." : `The first cloud read did not add up (${firstCheck.problems[0]}), so it was read a second time.`;
  onStep("cloud");
  let second: Invoice;
  try {
    second = await readWith(cloudModel, CLOUD_MODEL, QUICK_TIMEOUT_MS);
  } catch (e) {
    stepUp += ` The second read failed (${STRONG_FAILED_BECAUSE[failure(e)]}), so the first read is shown: please check it against the paper.`;
    return finish(first);
  }

  if (totalOnlyDispute(first, second)) {
    // Same lines, different totals, one of them adds up: read just the written total once more to settle it.
    try {
      const written = await call(totalModel, CLOUD_MODEL, TOTAL_PROMPT, TOTAL_TIMEOUT_MS, (r) => {
        const v = (JSON.parse(r.response.text()) as { total?: unknown }).total;
        return typeof v === "number" && Number.isFinite(v) ? v : null;
      });
      const s = settleTotal(first, second, written);
      return finish(s.invoice, { paperError: s.paperError, disputes: s.disputes.length ? s.disputes : undefined });
    } catch {
      /* the narrow read failed: fall through and let the owner check the disputed total */
    }
  }

  if (!sameLines(first, second)) {
    // The two quick reads disagree on the lines themselves: the stronger model gives a third opinion.
    stepUp += " The two reads disagreed on the lines, so a stronger model read it too.";
    onStep("cloud");
    try {
      const third = await readWith(strongModel, STRONG_MODEL, STRONG_TIMEOUT_MS);
      const better = checkSums(second).problems.length < checkSums(first).problems.length ? second : first;
      const r = reconcile(better, third);
      return finish(r.invoice, { paperError: r.paperError, disputes: r.disputes.length ? r.disputes : undefined });
    } catch (e) {
      stepUp += ` The stronger model could not help (${STRONG_FAILED_BECAUSE[failure(e)]}).`;
    }
  }
  const r = reconcile(first, second);
  return finish(r.invoice, { paperError: r.paperError, disputes: r.disputes.length ? r.disputes : undefined });
}

/** Retries a cloud call that failed because the service was busy or briefly unreachable, twice, unless it was cancelled. */
async function withRetry<T>(call: () => Promise<T>, signal: AbortSignal): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await call();
    } catch (e) {
      const f = failure(e);
      if ((f !== "busy" && f !== "network") || attempt >= 2 || signal.aborted) throw e;
      await new Promise<void>((ok) => {
        const id = setTimeout(ok, attempt === 0 ? 1500 : 4000);
        signal.addEventListener("abort", () => (clearTimeout(id), ok()), { once: true });
      });
      if (signal.aborted) throw e;
    }
  }
}
