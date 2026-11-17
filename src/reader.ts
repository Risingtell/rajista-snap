// The hybrid reader. Every AI call goes through Firebase AI Logic.
//
//   1. If this browser has the on-device model, read the photo on the device.
//   2. Check the sums (src/invoice.ts). Keep the on-device read only if another number on the page confirms it.
//   3. Otherwise send the photo to the quick cloud model, and settle what it found (src/flow.ts): charges are read
//      again on their own, a read that does not add up is read a second time, and the same numbers twice means the
//      paper itself does not add up; a dispute over the total alone is settled by a narrow read of the written
//      total; only a disagreement over the lines brings in the stronger (slower) model, and anything still unclear
//      is shown to the owner to check.
//
// The shop owner sees which reader produced each invoice and why it moved to the cloud.
import {
  getGenerativeModel,
  InferenceMode,
  InferenceSource,
  ThinkingLevel,
  type GenerateContentResult,
  type LanguageModelCreateOptions,
  type LanguageModelPromptOptions,
} from "firebase/ai";
import { ai } from "./firebase";
import { settle } from "./flow";
import {
  CHARGES_JSON_SCHEMA,
  CHARGES_PROMPT,
  chargesFrom,
  checkSums,
  INVOICE_JSON_SCHEMA,
  normalize,
  READ_PROMPT,
  TOTAL_JSON_SCHEMA,
  TOTAL_PROMPT,
  trustDeviceRead,
  type Check,
  type Dispute,
  type Invoice,
} from "./invoice";
import type { Photo } from "./image";
import { CLOUD_MODEL, STRONG_MODEL } from "./models";

export { CLOUD_MODEL, STRONG_MODEL };
/**
 * Time limits, each covering a reader's retries too. A call still running at its limit is cancelled, on the device
 * as in the cloud (see promptOnDevice). An on-device reading that runs past its limit also means this computer is
 * too slow for it, so the rest of the visit reads in the cloud (see deviceSlow).
 */
const DEVICE_TIMEOUT_MS = 90_000;
const QUICK_TIMEOUT_MS = 50_000;
// The stronger model answered in 12 s in the morning of 16 Nov and in 53 to 61 s that afternoon, so it gets more time.
const STRONG_TIMEOUT_MS = 75_000;
const TOTAL_TIMEOUT_MS = 30_000;
const CHARGES_TIMEOUT_MS = 30_000;

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
const chargesModel = cloud(CLOUD_MODEL, CHARGES_JSON_SCHEMA);
type Model = typeof cloudModel;

// ---- on-device model (Chrome's built-in Prompt API) ------------------------------------------------------
type LM = {
  availability(o?: object): Promise<"unavailable" | "downloadable" | "downloading" | "available">;
  create(o?: object): Promise<{ destroy(): void }>;
};
const lm = (): LM | undefined => (globalThis as unknown as { LanguageModel?: LM }).LanguageModel;
export type DeviceStatus = "unsupported" | "unavailable" | "downloadable" | "downloading" | "available";
const IMAGE_INPUT = { expectedInputs: [{ type: "image" }] };

/** Set when an on-device reading ran past its time limit (or the device stayed busy twice): the rest of this visit reads in the cloud. */
let slow = false;
let busyTimes = 0;
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

// The last finished prompt's session stays open for a minute, so Chrome keeps the model loaded for the next prompt (a
// product match follows a reading within seconds). It is closed when the next prompt finishes, or after that minute.
// A prompt that fails or is cancelled has its session closed at once.
const KEEP_MS = 60_000;
let keptSession: { stop: AbortController; timer: ReturnType<typeof setTimeout> } | null = null;
function keep(session: AbortController) {
  if (keptSession) {
    clearTimeout(keptSession.timer);
    keptSession.stop.abort();
  }
  const mine = {
    stop: session,
    timer: setTimeout(() => {
      if (keptSession === mine) {
        keptSession = null;
        session.abort();
      }
    }, KEEP_MS),
  };
  keptSession = mine;
}

/**
 * One prompt on Chrome's on-device model, in a fresh session. The Firebase SDK passes createOptions to
 * LanguageModel.create and promptOptions to session.prompt unchanged, so one abort signal in both cancels a running
 * prompt and closes its session: a time-out, or a reading that needs the device, really frees it, and sessions never
 * pile up. Any of `signals` cancels the prompt.
 *
 * Privacy: the model is built only after Chrome's model is confirmed present. The SDK decides at creation time
 * whether a device adapter exists, and without one it would answer an ONLY_ON_DEVICE call from the cloud. The answer
 * is also checked to have come from the device.
 */
export async function promptOnDevice(
  createOptions: LanguageModelCreateOptions,
  responseConstraint: object,
  parts: Parameters<ReturnType<typeof getGenerativeModel>["generateContent"]>[0],
  ...signals: AbortSignal[]
): Promise<GenerateContentResult> {
  const session = new AbortController();
  const cancel = () => session.abort(new DOMException("The on-device prompt was cancelled.", "AbortError"));
  for (const s of signals) {
    if (s.aborted) cancel();
    else s.addEventListener("abort", cancel, { once: true });
  }
  let kept = false;
  try {
    if (session.signal.aborted) throw session.signal.reason;
    if ((await deviceStatus()) !== "available") throw new Error("The on-device model is not available.");
    const model = getGenerativeModel(ai, {
      mode: InferenceMode.ONLY_ON_DEVICE,
      onDeviceParams: {
        createOptions: { ...createOptions, signal: session.signal },
        // Chrome's prompt() takes a signal too; the SDK's type leaves it out, but passes the options on unchanged.
        promptOptions: { responseConstraint, signal: session.signal } as LanguageModelPromptOptions,
      },
    });
    const r = await model.generateContent(parts);
    assertOnDevice(r);
    keep(session);
    kept = true;
    return r;
  } finally {
    for (const s of signals) s.removeEventListener("abort", cancel);
    if (!kept) session.abort();
  }
}

/** Throws if a call that was meant to stay on the device was answered in the cloud. */
export function assertOnDevice(r: GenerateContentResult) {
  if (r.response.inferenceSource !== InferenceSource.ON_DEVICE) throw new Error("The answer did not come from the on-device model.");
}

// One on-device prompt at a time, readings first (src/devicequeue.ts).
export { deviceReadWaiting, onDevice } from "./devicequeue";
import { onDevice } from "./devicequeue";

const READ_SESSION: LanguageModelCreateOptions = {
  expectedInputs: [{ type: "image" }],
  expectedOutputs: [{ type: "text", languages: ["en"] }],
};

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
export function timed<T>(fn: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
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

const photoPart = (photo: Photo) => ({ type: "inlineData" as const, inlineData: { data: photo.base64, mimeType: photo.mimeType } });
const ask = (model: Model, prompt: string, photo: Photo, signal: AbortSignal) => model.generateContent([prompt, photoPart(photo)], { signal });

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
    let t = performance.now();
    try {
      // A product match still running on the device is cancelled: readings come first.
      const r = await onDevice((queue) => {
        t = performance.now(); // the time the device spent reading, not waiting for it
        return timed((limit) => promptOnDevice(READ_SESSION, INVOICE_JSON_SCHEMA, [READ_PROMPT, photoPart(photo)], queue, limit), DEVICE_TIMEOUT_MS);
      }, "read");
      const invoice = normalize(r.response.text());
      const check = checkSums(invoice);
      device = { ms: Math.round(performance.now() - t), invoice, check };
      if (trustDeviceRead(check)) return { invoice, check, source: "device", ms: device.ms, device, calls: [] };
      whyCloud = !check.ok
        ? `The on-device read did not add up: ${check.problems[0]}`
        : !check.hasPrices
          ? "The on-device read found no prices, so the cloud checked the paper."
          : check.hasCharges
            ? "The on-device read listed charges (VAT, delivery or a discount), so the cloud checked them."
            : "The on-device read had nothing to check its prices against (no invoice total to match), so the cloud read it.";
    } catch (e) {
      if (/no answer after/.test(message(e))) slow = true;
      if (/device busy/.test(message(e)) && ++busyTimes >= 2) slow = true; // Chrome is not letting go: stop waiting on it
      device = { ms: Math.round(performance.now() - t), error: message(e) };
      whyCloud = slow
        ? "The on-device model took too long, so the cloud read it."
        : /device busy/.test(message(e))
          ? "The on-device model was still busy, so the cloud read it."
          : "The on-device model could not read this photo.";
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
  let fromStrong = false;
  try {
    first = await readWith(cloudModel, CLOUD_MODEL, QUICK_TIMEOUT_MS);
  } catch (e) {
    const f = failure(e);
    if (f === "appcheck" || f === "offline") giveUp(e);
    // The quick model is busy, unreachable, slow, or answered something unusable: the stronger model reads it.
    stepUp = STEP_UP_BECAUSE[f];
    onStep("cloud");
    try {
      first = await readWith(strongModel, STRONG_MODEL, STRONG_TIMEOUT_MS);
    } catch (e2) {
      giveUp(e2);
    }
    fromStrong = true;
  }

  // Local development only: add ?strong to the address to force the second read and test the steps after it.
  const forceSecond = import.meta.env.DEV && typeof location !== "undefined" && new URLSearchParams(location.search).has("strong");
  const settled = await settle(
    first,
    {
      again: () => (onStep("cloud"), readWith(cloudModel, CLOUD_MODEL, QUICK_TIMEOUT_MS)),
      strong: () => (onStep("cloud"), readWith(strongModel, STRONG_MODEL, STRONG_TIMEOUT_MS)),
      total: () =>
        call(totalModel, CLOUD_MODEL, TOTAL_PROMPT, TOTAL_TIMEOUT_MS, (r) => {
          const v = (JSON.parse(r.response.text()) as { total?: unknown }).total;
          return typeof v === "number" && Number.isFinite(v) ? v : null;
        }),
      charges: () => call(chargesModel, CLOUD_MODEL, CHARGES_PROMPT, CHARGES_TIMEOUT_MS, (r) => chargesFrom(r.response.text())),
    },
    { secondRead: !fromStrong, forceSecond, why: (e) => STRONG_FAILED_BECAUSE[failure(e)] },
  );
  stepUp = [stepUp, ...settled.steps].filter(Boolean).join(" ") || undefined;
  return finish(settled.invoice, { paperError: settled.paperError, disputes: settled.disputes });
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
