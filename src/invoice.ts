// What a read invoice looks like, and the check that decides whether an on-device read can be trusted.
// Pure functions only: no AI, no browser, so the rules are easy to test and to explain.

export type Line = {
  quantity: number;
  description: string;
  unit_price: number | null; // naira
  line_total: number | null; // naira
};

export type Invoice = { supplier: string | null; items: Line[]; total: number | null };

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
    supplier: { type: ["string", "null"] },
  },
  required: ["supplier", "items", "total"],
} as const;

export const READ_PROMPT =
  "This is a photo of a Nigerian shop invoice, receipt or delivery note. It may be handwritten, and the photo may be " +
  "sideways or upside down: read it the right way up. " +
  "List every product line: quantity, the product description copied exactly as written (join a description that runs over " +
  "several lines; do not expand abbreviations, explain or add words), " +
  "unit price in naira and line total in naira. Use null for a price that is not written. " +
  "Also give the document total in naira (null if none), and the supplier: the business name printed at the top " +
  "of the paper (null if none). Numbers only, no commas or currency signs. Copy every number exactly as written, even " +
  "if the arithmetic on the paper is wrong: never correct or recalculate it.";

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
  const o = (typeof raw === "string" ? JSON.parse(raw) : raw) as { items?: unknown; total?: unknown; supplier?: unknown } | null;
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
  const supplier = typeof o.supplier === "string" && o.supplier.trim() ? o.supplier.replace(/\s+/g, " ").trim() : null;
  return { supplier, items, total: num(o.total) };
}

export type Check = {
  ok: boolean;
  /** One plain sentence per problem, shown to the shop owner when a read goes to the cloud. */
  problems: string[];
  hasPrices: boolean;
  /**
   * True only when another number on the page confirms the prices: every line has a total and the lines
   * add up to the invoice total. A lone price cannot confirm itself. A paper with no prices is trivially true.
   */
  crossChecked: boolean;
};

// Naira amounts are whole numbers on these papers; allow one naira for rounding (1.5 x 3,333) and no more,
// so a real ₦2,000 adding error on a ₦2.4 million invoice is still caught.
const close = (a: number, b: number) => Math.abs(a - b) <= 1;
/** Naira as shop owners write it: ₦109,500. A missing amount shows as `none` (empty by default). */
export const naira = (n: number | null, none = "") => (n === null ? none : `₦${n.toLocaleString("en-NG")}`);

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
  const ok = problems.length === 0;
  const crossChecked = !hasPrices || (ok && inv.total !== null && allTotals && inv.items.length > 0);
  return { ok, problems, hasPrices, crossChecked };
}

/**
 * Whether an on-device read can be kept without asking the cloud: it adds up, it has prices, and another number on
 * the page confirms them. A read with no prices at all is not trusted, because the device may simply have failed
 * to read them; the cloud then checks the paper (a delivery note with no prices costs one quick cloud read).
 */
export const trustDeviceRead = (c: Check) => c.ok && c.hasPrices && c.crossChecked;

/** True when two reads found the same lines: the same number of lines, with the same quantities and prices. */
export function sameLines(a: Invoice, b: Invoice): boolean {
  return (
    a.items.length === b.items.length &&
    a.items.every((l, i) => {
      const m = b.items[i];
      return l.quantity === m.quantity && l.unit_price === m.unit_price && l.line_total === m.line_total;
    })
  );
}

/** True when two reads found every number the same, the invoice total included. */
export const sameNumbers = (a: Invoice, b: Invoice) => a.total === b.total && sameLines(a, b);

/** One number two reads disagree on. `line` is the line's index, or null for the invoice total or the line count. */
export type Dispute = {
  line: number | null;
  field: "quantity" | "unit_price" | "line_total" | "total" | "lines";
  shown: number | null;
  other: number | null;
};

/** Every number on which the read being shown differs from the other read. */
export function disputes(shown: Invoice, other: Invoice): Dispute[] {
  const out: Dispute[] = [];
  if (shown.items.length !== other.items.length) {
    out.push({ line: null, field: "lines", shown: shown.items.length, other: other.items.length });
  } else {
    shown.items.forEach((l, i) => {
      const m = other.items[i];
      for (const field of ["quantity", "unit_price", "line_total"] as const) {
        if (l[field] !== m[field]) out.push({ line: i, field, shown: l[field], other: m[field] });
      }
    });
  }
  if (shown.total !== other.total) out.push({ line: null, field: "total", shown: shown.total, other: other.total });
  return out;
}

export type Reconciled = {
  invoice: Invoice;
  from: "first" | "second";
  /** Only when both reads found exactly the same numbers and those numbers do not add up. */
  paperError?: string;
  /** The numbers the two reads disagree on, for the owner to check against the paper. */
  disputes: Dispute[];
};

/**
 * Combines a first read that did not add up with a second read of the same photo.
 *
 * - Same numbers in both: both readers saw the same thing, so if it does not add up, the paper itself is wrong.
 *   The second (stronger) read's names and supplier are kept, with the shared numbers.
 * - Different numbers: neither read is confirmed. Show the one that adds up (or has fewer problems), and list
 *   every number they disagree on. Never claim the paper is wrong here: one reader may simply have misread it,
 *   or may have "corrected" the paper's arithmetic.
 */
export function reconcile(first: Invoice, second: Invoice): Reconciled {
  const a = checkSums(first);
  const b = checkSums(second);
  if (sameNumbers(first, second)) {
    return {
      invoice: { ...second, supplier: second.supplier ?? first.supplier },
      from: "second",
      disputes: [],
      paperError: a.ok
        ? undefined
        : `${a.problems.join(" ")} Two separate reads found the same numbers, so the mistake is on the invoice itself. Check it with the supplier before you pay.`,
    };
  }
  const useSecond = b.ok || (!a.ok && b.problems.length <= a.problems.length);
  const shown = useSecond ? second : first;
  const other = useSecond ? first : second;
  return { invoice: { ...shown, supplier: shown.supplier ?? other.supplier }, from: useSecond ? "second" : "first", disputes: disputes(shown, other) };
}
