// When the plain name matching is not sure, Chrome's on-device model picks which of the shop's products an
// invoice line means. This only ever runs on the device: the product list is private, so there is no cloud
// fallback here. Without an on-device model, the owner simply picks from the list.
import { InferenceMode } from "firebase/ai";
import type { Product } from "./match";
import { assertOnDevice, deviceReadWaiting, onDevice, onDeviceModel } from "./reader";

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
 * The product the on-device model picked, or null. Throws if there is no on-device model, or if an invoice reading
 * is waiting for the model (readings go first). The model is created only after Chrome's model is confirmed present
 * (see onDeviceModel), so the product list cannot be sent to the cloud; the answer is also checked to have come
 * from the device.
 */
export async function pickOnDevice(supplier: string | null, line: string, candidates: Product[]): Promise<Product | null> {
  if (!candidates.length) return null;
  if (deviceReadWaiting()) throw new Error("A reading is waiting for the on-device model.");
  return onDevice(async () => {
    const model = await onDeviceModel({
      mode: InferenceMode.ONLY_ON_DEVICE,
      onDeviceParams: {
        createOptions: { expectedOutputs: [{ type: "text", languages: ["en"] }] },
        promptOptions: { responseConstraint: PICK_SCHEMA },
      },
    });
    const r = await model.generateContent(pickPrompt(supplier, line, candidates));
    assertOnDevice(r);
    const n = Number((JSON.parse(r.response.text()) as { choice?: unknown }).choice);
    return Number.isInteger(n) && n >= 1 && n <= candidates.length ? candidates[n - 1] : null;
  });
}
