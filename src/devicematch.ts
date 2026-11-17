// When the plain name matching is not sure, Chrome's on-device model picks which of the shop's products an
// invoice line means. This only ever runs on the device: the product list is private, so there is no cloud
// fallback here. Without an on-device model, the owner simply picks from the list.
import type { LanguageModelCreateOptions } from "firebase/ai";
import type { Product } from "./match";
import { deviceReadWaiting, deviceSlow, onDevice, promptOnDevice, timed } from "./reader";

/** A pick still running at this limit is cancelled, and no more picks are tried in this visit: the owner picks. */
const PICK_TIMEOUT_MS = 30_000;
let picksOff = false;
/** True once a pick ran past its time limit: this computer is too slow to match products on the device. */
export const devicePicksOff = () => picksOff;

const PICK_SESSION: LanguageModelCreateOptions = { expectedOutputs: [{ type: "text", languages: ["en"] }] };
const PICK_SCHEMA = { type: "object", properties: { choice: { type: "integer" } }, required: ["choice"] } as const;

export function pickPrompt(supplier: string | null, line: string, candidates: Product[]): string {
  return [
    "A Nigerian shop received an invoice" + (supplier ? ` from ${supplier}` : "") + ". One line on it says:",
    `"${line}"`,
    "Which of the shop's own products is this? Suppliers abbreviate (ctn = carton, pcs = pieces) and misspell.",
    ...candidates.map((p, i) => `${i + 1}. ${p.name}`),
    "0. None of these",
    'Answer with JSON {"choice": number}. Choose 0 unless you are confident.',
  ].join("\n");
}

/**
 * The product the on-device model picked, or null. Throws if there is no on-device model, if a reading needs the
 * model (readings go first, and cancel a pick that is running), or if the device is too slow for picks in this
 * visit. The prompt runs only on the device (see promptOnDevice), so the product list never reaches the cloud.
 */
export async function pickOnDevice(supplier: string | null, line: string, candidates: Product[]): Promise<Product | null> {
  if (!candidates.length) return null;
  if (picksOff || deviceSlow()) throw new Error("The on-device model is too slow on this computer to match products.");
  if (deviceReadWaiting()) throw new Error("A reading is waiting for the on-device model.");
  return onDevice(async (queue) => {
    try {
      const r = await timed((limit) => promptOnDevice(PICK_SESSION, PICK_SCHEMA, pickPrompt(supplier, line, candidates), queue, limit), PICK_TIMEOUT_MS);
      let n = NaN;
      try {
        n = Number((JSON.parse(r.response.text()) as { choice?: unknown }).choice);
      } catch {
        /* an answer that is not JSON is no pick */
      }
      return Number.isInteger(n) && n >= 1 && n <= candidates.length ? candidates[n - 1] : null;
    } catch (e) {
      const m = String((e as Error)?.message ?? e);
      // Too slow, or (never expected) an answer that did not come from the device: no more picks this visit.
      if (/no answer after|did not come from the on-device model/.test(m)) {
        picksOff = true;
        throw e;
      }
      if (queue.aborted || (e as Error)?.name === "AbortError") throw e; // a reading needs the device: stop for now
      return null; // this line's prompt failed: no pick for it, and the next line is tried
    }
  });
}
