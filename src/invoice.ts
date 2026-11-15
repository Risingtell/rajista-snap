// What a read invoice looks like, and the check that decides whether an on-device read can be trusted.
// Pure functions only: no AI, no browser, so the rules are easy to test and to explain.

export type Line = {
  quantity: number;
  description: string;
  unit_price: number | null; // naira
  line_total: number | null; // naira
};

export type Invoice = { items: Line[]; total: number | null };

/** The JSON shape both readers are asked for. Written once so the device and the cloud get the same contract. */
export const INVOICE_JSON_SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          quantity: { type: "number" },
          description: { type: "string" },
          unit_price: { type: ["number", "null"] },
          line_total: { type: ["number", "null"] },
        },
        required: ["quantity", "description", "unit_price", "line_total"],
      },
    },
    total: { type: ["number", "null"] },
  },
  required: ["items", "total"],
} as const;

export const READ_PROMPT =
  "This is a photo of a Nigerian shop invoice, receipt or delivery note. It may be handwritten. " +
  "List every product line: quantity, the full product description (join a description that runs over several lines), " +
  "unit price in naira and line total in naira. Use null for a price that is not written. " +
  "Also give the document total in naira (null if none). Numbers only, no commas or currency signs.";

const num = (v: unknown): number | null => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v.replace(/[₦N,\s]/g, ""));
    return v.trim() && Number.isFinite(n) ? n : null;
  }
  return null;
};

/** Turns whatever a model returned into a clean Invoice, or throws if it is not one. */
export function normalize(raw: unknown): Invoice {
  const o = (typeof raw === "string" ? JSON.parse(raw) : raw) as { items?: unknown; total?: unknown } | null;
  if (!o || !Array.isArray(o.items)) throw new Error("The reader did not return a list of items.");
  const items: Line[] = o.items
    .map((it) => {
      const r = (it ?? {}) as Record<string, unknown>;
      return {
        quantity: num(r.quantity) ?? 1,
        description: String(r.description ?? "").replace(/\s+/g, " ").trim(),
        unit_price: num(r.unit_price),
        line_total: num(r.line_total),
      };
    })
    .filter((l) => l.description);
  return { items, total: num(o.total) };
}

export type Check = {
  ok: boolean;
  /** One plain sentence per problem, shown to the shop owner when a read goes to the cloud. */
  problems: string[];
  hasPrices: boolean;
};

const close = (a: number, b: number) => Math.abs(a - b) <= Math.max(1, Math.abs(b) * 0.001);
const naira = (n: number) => `₦${n.toLocaleString("en-NG")}`;

/**
 * Does the invoice add up? Quantity x unit price must equal each line total, and the lines must add up
 * to the invoice total. A delivery note with no prices passes (there is nothing to add up).
 */
export function checkSums(inv: Invoice): Check {
  const problems: string[] = [];
  if (inv.items.length === 0) problems.push("No product lines were found.");
  let sum = 0;
  let allTotals = true;
  inv.items.forEach((l, i) => {
    if (l.quantity <= 0) problems.push(`Line ${i + 1}: the quantity ${l.quantity} cannot be right.`);
    const lineTotal = l.line_total ?? (l.unit_price !== null ? l.quantity * l.unit_price : null);
    if (l.unit_price !== null && l.line_total !== null && !close(l.quantity * l.unit_price, l.line_total)) {
      problems.push(`Line ${i + 1}: ${l.quantity} × ${naira(l.unit_price)} is ${naira(l.quantity * l.unit_price)}, not ${naira(l.line_total)}.`);
    }
    if (lineTotal === null) allTotals = false;
    else sum += lineTotal;
  });
  const hasPrices = inv.items.some((l) => l.unit_price !== null || l.line_total !== null) || inv.total !== null;
  if (inv.total !== null && allTotals && inv.items.length > 0 && !close(sum, inv.total)) {
    problems.push(`The lines add up to ${naira(sum)}, but the invoice total says ${naira(inv.total)}.`);
  }
  if (inv.total !== null && inv.items.length > 0 && !allTotals && inv.items.every((l) => l.line_total === null && l.unit_price === null)) {
    problems.push("There is a total but no line prices.");
  }
  return { ok: problems.length === 0, problems, hasPrices };
}
