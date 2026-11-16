// What a read invoice looks like, and the checks that decide whether a read can be trusted.
// Pure functions only: no AI, no browser, so the rules are easy to test and to explain.

export type Line = {
  quantity: number;
  description: string;
  unit_price: number | null; // naira
  line_total: number | null; // naira
};

/** An amount that is part of the total but is not a product: VAT, delivery, transport, or a discount (negative). */
export type Charge = { label: string; amount: number };

export type Invoice = { supplier: string | null; items: Line[]; total: number | null; charges?: Charge[] };

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
    charges: {
      type: "array",
      items: {
        type: "object",
        properties: { label: { type: "string" }, amount: { type: "number" } },
        required: ["label", "amount"],
      },
    },
    total: { type: ["number", "null"] },
    supplier: { type: ["string", "null"] },
  },
  required: ["supplier", "items", "charges", "total"],
} as const;

export const READ_PROMPT =
  "This is a photo of a Nigerian shop invoice, receipt or delivery note. It may be handwritten, and the photo may be " +
  "sideways or upside down: read it the right way up. " +
  "List every product line: quantity, the product description copied exactly as written (join a description that runs over " +
  "several lines; do not expand abbreviations, explain or add words), " +
  "unit price in naira and line total in naira. Use null for a price that is not written. " +
  "List in charges any other amount that is written on the paper with its own figure and makes up the total, such as VAT, " +
  "delivery, transport or a discount (a discount as a negative number). Never invent a charge to make the numbers add " +
  "up; leave charges empty if none is written. " +
  "Also give the document total in naira (null if none), and the supplier: the business name printed at the top " +
  "of the paper (null if none). Numbers only, no commas or currency signs. Copy every number exactly as written, even " +
  "if the arithmetic on the paper is wrong: never correct or recalculate it.";

/** A narrow second look at one number: the total as written. Used to settle two reads that disagree on it. */
export const TOTAL_JSON_SCHEMA = { type: "object", properties: { total: { type: ["number", "null"] } }, required: ["total"] } as const;
export const TOTAL_PROMPT =
  "Look only at the grand total written on this invoice: the final amount to pay. Copy it exactly as written, digit by " +
  "digit, even if it does not match the lines above it. The photo may be sideways. Number only, no commas or currency " +
  "signs; null if there is no total.";

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
  const o = (typeof raw === "string" ? JSON.parse(raw) : raw) as { items?: unknown; total?: unknown; supplier?: unknown; charges?: unknown } | null;
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
  const charges: Charge[] = (Array.isArray(o.charges) ? o.charges : [])
    .map((c) => {
      const r = (c ?? {}) as Record<string, unknown>;
      return { label: String(r.label ?? "").replace(/\s+/g, " ").trim() || "Charge", amount: num(r.amount) };
    })
    .filter((c): c is Charge => c.amount !== null && c.amount !== 0);
  const supplier = typeof o.supplier === "string" && o.supplier.trim() ? o.supplier.replace(/\s+/g, " ").trim() : null;
  return { supplier, items, charges, total: num(o.total) };
}

export type Check = {
  ok: boolean;
  /** One plain sentence per problem, shown to the shop owner when a read goes to the cloud. */
  problems: string[];
  /** Small differences that could be a rounded unit price or a real overcharge: shown, but not a failure. */
  notes: string[];
  hasPrices: boolean;
  /** The read lists charges (VAT, delivery, discounts). They are confirmed by a second read before being trusted. */
  hasCharges: boolean;
  /**
   * True only when another number on the page confirms the prices: every line has a total and the lines
   * add up to the invoice total. A lone price cannot confirm itself. A paper with no prices is trivially true.
   */
  crossChecked: boolean;
};

/** Naira as shop owners write it: ₦109,500. A missing amount shows as `none` (empty by default). */
export const naira = (n: number | null, none = "") => (n === null ? none : `₦${n.toLocaleString("en-NG")}`);

/** The sum of the non-product charges (VAT, delivery, discounts). */
export const chargesTotal = (inv: Invoice) => (inv.charges ?? []).reduce((s, c) => s + c.amount, 0);

// Totals on these papers are whole naira: the lines (and charges) must match the invoice total to within ₦1, so a
// real ₦2,000 adding error on a ₦2.4 million invoice is caught. A line's quantity × unit price must also match its
// total to within ₦1. When it does not, but the unit price is the line total divided by the quantity rounded to the
// naira (a carton split per piece: 12 × ₦1,083 for ₦13,000), the numbers cannot tell a rounded price from a small
// overcharge, so the difference is shown to the owner as a note instead of failing the check.
const closeTotal = (a: number, b: number) => Math.abs(a - b) <= 1;

/**
 * Does the invoice add up? Quantity x unit price must equal each line total, and the lines plus any charges must
 * add up to the invoice total. A delivery note with no prices passes (there is nothing to add up).
 */
export function checkSums(inv: Invoice): Check {
  const problems: string[] = [];
  const notes: string[] = [];
  if (inv.items.length === 0) problems.push("No product lines were found.");
  let sum = 0;
  let allTotals = true;
  inv.items.forEach((l, i) => {
    if (l.quantity <= 0) problems.push(`Line ${i + 1}: the quantity ${l.quantity} cannot be right.`);
    const lineTotal = l.line_total ?? (l.unit_price !== null ? l.quantity * l.unit_price : null);
    if (l.unit_price !== null && l.line_total !== null && l.quantity > 0) {
      const product = l.quantity * l.unit_price;
      const gap = l.line_total - product;
      if (Math.abs(gap) > 1) {
        if (Math.abs(l.unit_price - l.line_total / l.quantity) <= 0.5) {
          notes.push(
            `Line ${i + 1}: ${l.quantity} × ${naira(l.unit_price)} is ${naira(product)}, and the line says ${naira(l.line_total)} (${naira(Math.abs(gap))} ${gap > 0 ? "more" : "less"}). The unit price may be rounded; check it if it matters.`,
          );
        } else {
          problems.push(`Line ${i + 1}: ${l.quantity} × ${naira(l.unit_price)} is ${naira(product)}, not ${naira(l.line_total)}.`);
        }
      }
    }
    if (lineTotal === null) allTotals = false;
    else sum += lineTotal;
  });
  const extra = chargesTotal(inv);
  const hasPrices = inv.items.some((l) => l.unit_price !== null || l.line_total !== null) || inv.total !== null;
  if (inv.total !== null && allTotals && inv.items.length > 0 && !closeTotal(sum + extra, inv.total)) {
    problems.push(
      extra
        ? `The lines and charges add up to ${naira(sum + extra)}, but the invoice total says ${naira(inv.total)}.`
        : `The lines add up to ${naira(sum)}, but the invoice total says ${naira(inv.total)}.`,
    );
  }
  if (inv.total !== null && inv.items.length > 0 && !allTotals && inv.items.every((l) => l.line_total === null && l.unit_price === null)) {
    problems.push("There is a total but no line prices.");
  }
  const ok = problems.length === 0;
  const crossChecked = !hasPrices || (ok && inv.total !== null && allTotals && inv.items.length > 0);
  return { ok, problems, notes, hasPrices, hasCharges: (inv.charges ?? []).length > 0, crossChecked };
}

/**
 * Whether an on-device read can be kept without asking the cloud: it adds up, it has prices, another number on the
 * page confirms them, and it lists no charges. A read with no prices is not trusted (the device may simply have
 * failed to read them), and neither is one that adds up only with charges: a reader could invent a "discount" to
 * close a gap, so charges are always confirmed by a second, cloud read.
 */
export const trustDeviceRead = (c: Check) => c.ok && c.hasPrices && c.crossChecked && !c.hasCharges;

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

/** True when two reads found every number the same: lines, charges and total. */
export const sameNumbers = (a: Invoice, b: Invoice) => a.total === b.total && chargesTotal(a) === chargesTotal(b) && sameLines(a, b);

/** One number two reads disagree on. `line` is the line's index, or null for the total, the charges or the line count. */
export type Dispute = {
  line: number | null;
  field: "quantity" | "unit_price" | "line_total" | "total" | "charges" | "lines";
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
  if (chargesTotal(shown) !== chargesTotal(other)) out.push({ line: null, field: "charges", shown: chargesTotal(shown), other: chargesTotal(other) });
  if (shown.total !== other.total) out.push({ line: null, field: "total", shown: shown.total, other: other.total });
  return out;
}

export type Reconciled = {
  invoice: Invoice;
  /** Only when the paper's own numbers were confirmed and they do not add up. */
  paperError?: string;
  /** The numbers the two reads disagree on, for the owner to check against the paper. */
  disputes: Dispute[];
};

const PAPER_ADVICE =
  " Check these numbers against the paper: if they match, the invoice itself does not add up, so check it with the supplier before you pay. (If the total includes VAT, delivery or a discount that is not listed above, it may not be a mistake.)";

/**
 * Combines a first read that did not add up (or listed charges) with a second read of the same photo.
 *
 * - Same numbers in both: both readers saw the same thing, so if it does not add up, the paper itself is wrong.
 *   The second (stronger) read's names and supplier are kept, with the shared numbers.
 * - Different numbers: neither read is confirmed. Show the read that adds up (or has clearly fewer problems), and
 *   list every number they disagree on. Never claim the paper is wrong here: one reader may simply have misread it,
 *   or may have "corrected" the paper's arithmetic. On a tie the second (later, or stronger) read is shown, but an
 *   empty read never replaces one that found lines.
 */
export function reconcile(first: Invoice, second: Invoice): Reconciled {
  const a = checkSums(first);
  const b = checkSums(second);
  if (sameNumbers(first, second)) {
    return {
      invoice: { ...second, supplier: second.supplier ?? first.supplier },
      disputes: [],
      paperError: a.ok ? undefined : `${a.problems.join(" ")} Snap read the photo twice and got the same numbers both times.${PAPER_ADVICE}`,
    };
  }
  const secondEmpty = second.items.length === 0 && first.items.length > 0;
  const useSecond = !secondEmpty && (b.ok || (!a.ok && b.problems.length <= a.problems.length));
  const shown = useSecond ? second : first;
  const other = useSecond ? first : second;
  return { invoice: { ...shown, supplier: shown.supplier ?? other.supplier }, disputes: disputes(shown, other) };
}

/**
 * True when two reads agree on every line and charge but not on the total, and exactly one of them adds up. Then one
 * reader either misread the total or "corrected" the paper's sum, and a narrow look at the written total settles it.
 */
export function totalOnlyDispute(first: Invoice, second: Invoice): boolean {
  return (
    first.total !== second.total &&
    sameLines(first, second) &&
    chargesTotal(first) === chargesTotal(second) &&
    checkSums(first).ok !== checkSums(second).ok
  );
}

/**
 * Settles a total-only dispute with the total as written, read on its own a third time.
 * - It matches the read that does not add up: the paper says that, so the paper's sum is wrong.
 * - It matches the read that adds up: the other reader misread the total.
 * - Anything else: still unclear, so the owner checks the disputed total.
 */
export function settleTotal(first: Invoice, second: Invoice, written: number | null): Reconciled {
  const failing = checkSums(first).ok ? second : first;
  const passing = failing === first ? second : first;
  // Keep the stronger (second) read's names and supplier in every case; only the total is in question.
  const names = { ...second, supplier: second.supplier ?? first.supplier };
  if (written !== null && written === failing.total) {
    const invoice = { ...names, total: failing.total };
    return {
      invoice,
      disputes: [],
      paperError: `${checkSums(invoice).problems.join(" ")} The total was read again on its own and came back as ${naira(failing.total)} again.${PAPER_ADVICE}`,
    };
  }
  if (written !== null && written === passing.total) return { invoice: { ...names, total: passing.total }, disputes: [] };
  return reconcile(first, second);
}
