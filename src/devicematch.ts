// When the plain name matching is not sure, Chrome's on-device model picks which of the shop's products an
// invoice line means. This only ever runs on the device: the product list is private, so there is no cloud
// fallback here. Without an on-device model, the owner simply picks from the list.
import { getGenerativeModel, InferenceMode } from "firebase/ai";
import { ai } from "./firebase";
import type { Product } from "./match";

const PICK_SCHEMA = { type: "object", properties: { choice: { type: "integer" } }, required: ["choice"] } as const;

const model = getGenerativeModel(ai, {
  mode: InferenceMode.ONLY_ON_DEVICE,
  onDeviceParams: {
    createOptions: { expectedOutputs: [{ type: "text", languages: ["en"] }] },
    promptOptions: { responseConstraint: PICK_SCHEMA },
  },
});

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

/** The product the on-device model picked, or null. Throws if there is no on-device model. */
export async function pickOnDevice(supplier: string | null, line: string, candidates: Product[]): Promise<Product | null> {
  if (!candidates.length) return null;
  const r = await model.generateContent(pickPrompt(supplier, line, candidates));
  const n = Number((JSON.parse(r.response.text()) as { choice?: unknown }).choice);
  return Number.isInteger(n) && n >= 1 && n <= candidates.length ? candidates[n - 1] : null;
}
