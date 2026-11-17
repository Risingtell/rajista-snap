// What a read invoice looks like, and the checks that decide whether a read can be trusted.
// Pure functions only: no AI, no browser, so the rules are easy to test and to explain.

export type Line = {
  quantity: number;
  description: string;
  unit_price: number | null; // naira
  line_total: number | null; // naira
};

/** An amount on the paper that is not a product: VAT, delivery, transport, a deposit, or a discount (negative). */
export type Charge = {
  label: string;
  amount: number;
  /** Found by only one read: the total adds up only if this row is really on the paper, so the owner checks it. */
  unsure?: true;
};

/**
 * `charges`: the extra rows the total includes. `notCounted`: rows seen but not part of the sum (a subtotal, a
 * payment, a balance), kept so the reads can be weighed against each other.
 */
export type Invoice = { supplier: string | null; items: Line[]; total: number | null; charges?: Charge[]; notCounted?: Charge[] };

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
  "delivery, transport or a discount (a discount as a negative number). A subtotal, the total, an amount paid, a " +
  "deposit or a balance is never a charge. Never invent a charge to make the numbers add up; leave charges empty if " +
  "none is written. " +
  "Also give the document total in naira (null if none), and the supplier: the business name printed at the top " +
  "of the paper (null if none). Numbers only, no commas or currency signs. Copy every number exactly as written, even " +
  "if the arithmetic on the paper is wrong: never correct or recalculate it.";

/**
 * A narrow look at the charges alone (VAT, delivery, transport, discounts). Charges are the one kind of number a
 * reader can make up to close a gap, so whenever a full read lists any, this read decides them (see src/flow.ts).
 * It is not asked to add anything up, so it has no gap to close.
 */
export const CHARGES_JSON_SCHEMA = {
  type: "object",
  properties: { charges: INVOICE_JSON_SCHEMA.properties.charges },
  required: ["charges"],
} as const;
export const CHARGES_PROMPT =
  "Look only for amounts written on this invoice that are not product lines but are part of the amount to pay, such as " +
  "VAT, delivery, transport or a discount (a discount as a negative number). A subtotal, the total, an amount paid, a " +
  "deposit or a balance is never one of these: leave them out. Copy each label and figure exactly as written. Do not " +
  "add anything up or work anything out. If no such amount is written, return an empty list. The photo may be " +
  "sideways. Numbers only, no commas or currency signs.";

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

// A row's label is only a hint. Readers copy subtotals, totals, payments and balances among the charges (seen on 16
// Nov 2026: "SUBTOTAL 160,000" next to "VAT 7.5% 12,000"), and the same word can mean either ("Crate deposit" is a
// charge, "Less: Deposit" a payment). So the arithmetic decides which rows the total includes (addingSubset); the
// label only breaks ties, and picks what to show when nothing adds up.
const PAYMENT = /\b(deposit|advance|balance|bal|b\/f|c\/f|brought\s+forward|carried\s+forward|paid|payments?|amount\s+(due|payable))\b/i;
const MONEY_HANDED = /\b(cash|change)\b/i;
const SUMMARY = /\b(sub[\s-]*total|grand[\s-]*total|net[\s-]*total|total)\b/gi;
const A_CHARGE = /vat|tax|levy|deliver|transport|freight|carriage|loading|discount|rebate|commission|surcharge|fee|charge/i;

/** Whether a row's label reads like a charge (VAT, delivery, a discount) rather than a sum, a payment or a balance. */
export function looksLikeCharge(label: string): boolean {
  if (PAYMENT.test(label)) return false; // "Less: Deposit", "Advance paid", "Previous balance", "Bal b/f"
  const rest = label.replace(SUMMARY, " ");
  if (rest !== label && !A_CHARGE.test(rest)) return false; // "Subtotal", "Grand total"; but "Total VAT" is VAT
  if (MONEY_HANDED.test(label) && !A_CHARGE.test(label)) return false; // "Cash", "Change"; but "Cash discount" is one
  return true;
}

/** Every extra row in whatever a model returned: labelled, non-zero amounts. Which ones count is decided later. */
export function chargesFrom(raw: unknown): Charge[] {
  const o = (typeof raw === "string" ? JSON.parse(raw) : raw) as { charges?: unknown } | null;
  return (Array.isArray(o?.charges) ? o.charges : [])
    .map((c) => {
      const r = (c ?? {}) as Record<string, unknown>;
      return { label: String(r.label ?? "").replace(/\s+/g, " ").trim() || "Charge", amount: num(r.amount) };
    })
    .filter((c): c is Charge => c.amount !== null && c.amount !== 0);
}

/** The sum of the line totals (a line with no total counts as quantity × unit price, if it has one). */
export const linesTotal = (inv: Pick<Invoice, "items">) =>
  inv.items.reduce((s, l) => s + (l.line_total ?? (l.unit_price !== null ? l.quantity * l.unit_price : 0)), 0);

const MAX_ROWS = 10;
/**
 * The extra rows that make lines + rows = total, to the naira, or null if no choice of them does. When several
 * choices work, the one with the most rows that read like charges, and the fewest that read like sums or payments,
 * wins; then the one with fewer rows.
 */
export function addingSubset(lines: number, total: number, rows: Charge[]): Charge[] | null {
  const k = Math.min(rows.length, MAX_ROWS);
  let best: { set: Charge[]; score: number } | null = null;
  for (let mask = 0; mask < 1 << k; mask++) {
    const set = rows.slice(0, k).filter((_, i) => (mask >> i) & 1);
    if (Math.abs(lines + set.reduce((t, r) => t + r.amount, 0) - total) > 1) continue;
    const score = set.reduce((t, r) => t + (looksLikeCharge(r.label) ? 100 : -200), 0) - set.length;
    if (!best || score > best.score) best = { set, score };
  }
  return best ? best.set : null;
}

/** One read's extra rows, split into those its total includes and the rest, as far as one read can tell. */
export function arrange(inv: Invoice, rows: Charge[]): Invoice {
  const set = inv.total !== null && inv.items.length ? addingSubset(linesTotal(inv), inv.total, rows) : null;
  const counted = set ?? rows.filter((r) => looksLikeCharge(r.label));
  return { ...inv, charges: counted, notCounted: rows.filter((r) => !counted.includes(r)) };
}

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
  const total = num(o.total);
  const supplier = typeof o.supplier === "string" && o.supplier.trim() ? o.supplier.replace(/\s+/g, " ").trim() : null;
  return arrange({ supplier, items, total }, chargesFrom(o));
}

export type Check = {
  ok: boolean;
  /** One plain sentence per problem, shown to the shop owner when a read goes to the cloud. */
  problems: string[];
  /**
   * Line differences that rounding can explain (half a naira per piece, plus half a naira): the numbers cannot tell
   * that from a small overcharge, so the owner is shown a note to check. Not a failure, but never "all clear".
   */
  notes: string[];
  hasPrices: boolean;
  /** The total includes extra rows (VAT, delivery, discounts). They are only trusted once another read finds them. */
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
// total to within ₦1, except where rounding can explain the gap. A per-piece price is often rounded to the naira (a
// carton of 12 for ₦13,000 is ₦1,083.33 a piece, written ₦1,083), and so may the line total be, so a gap of up to
// half a naira per piece, plus half a naira, is shown to the owner as a note to check. (A unit price written with
// kobo was not rounded to the naira, so it gets half a kobo per piece.) It never fails the check (a false "does not
// add up" would blame an honest supplier) and never reads as "all clear". A bigger gap fails.
const closeTotal = (a: number, b: number) => Math.abs(a - b) <= 1;
const roundingCovers = (quantity: number, unit: number, gap: number) =>
  Math.abs(gap) <= (Number.isInteger(unit) ? 0.5 : 0.005) * quantity + 0.5;

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
        if (roundingCovers(l.quantity, l.unit_price, gap)) {
          notes.push(
            `Line ${i + 1}: ${l.quantity} × ${naira(l.unit_price)} is ${naira(product)}, but the line says ${naira(l.line_total)} (${naira(Math.abs(gap))} ${gap > 0 ? "more" : "less"}). A rounded unit price could explain that much, but check the line total against the paper before you pay.`,
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
 * Whether an on-device read can be kept without asking the cloud: it adds up with nothing to note, it has prices,
 * another number on the page confirms them, and its total needs no extra rows. A read with no prices is not trusted
 * (the device may simply have failed to read them), and neither is one that adds up only with extra rows: a reader
 * could invent a "discount" to close a gap, so such rows are always checked by another read, in the cloud.
 */
export const trustDeviceRead = (c: Check) => c.ok && c.notes.length === 0 && c.hasPrices && c.crossChecked && !c.hasCharges;

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
