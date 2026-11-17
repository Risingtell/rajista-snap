import { describe, expect, it } from "vitest";
import { resolve, settle, type Readers } from "./flow";
import { arrange, checkSums, normalize, type Charge, type Invoice, type Line } from "./invoice";

const line = (quantity: number, description: string, unit: number, total: number): Line => ({ quantity, description, unit_price: unit, line_total: total });
/** A read as normalize() would return it: its extra rows arranged by its own arithmetic. */
const read = (inv: Omit<Invoice, "charges" | "notCounted">, ...rows: Charge[]): Invoice => arrange({ ...inv }, rows);

// Sample invoice 1: the lines make ₦109,500 but the paper's total says ₦109,000 (the supplier's own mistake).
const lines = [line(2, "Ctn. Sugar 1kg", 30000, 60000), line(3, "Ctn. Indo Ch. Kn 70g", 9500, 28500), line(1, "Ctn Peak Tin 160g", 21000, 21000)];
const paper = read({ supplier: "Rising Technology", items: lines, total: 109000 });
const discount = { label: "Discount", amount: -500 };
const paperWithDiscount = read({ supplier: "Rising Technology", items: lines, total: 109000 }, discount);
// A correct printed VAT invoice: ₦160,000 of goods, VAT ₦12,000, total ₦172,000.
const vat = { label: "VAT 7.5%", amount: 12000 };
const goods = [line(4, "Ctn Milo 400g", 40000, 160000)];
const vatInvoice = read({ supplier: "Tasiu", items: goods, total: 172000 }, vat);
const vatMissed = read({ supplier: "Tasiu", items: goods, total: 172000 });
const generator = (total: number, ...rows: Charge[]) => read({ supplier: "Tasiu", items: [line(1, "Generator", 100000, 100000)], total }, ...rows);

/** Readers that answer from a script and count every call. */
function readers(script: { again?: Invoice | Error; strong?: Invoice | Error; total?: number | null; charges?: Charge[] | Error }) {
  const calls = { again: 0, strong: 0, total: 0, charges: 0 };
  const fail = (x: unknown, what: string) => {
    throw x instanceof Error ? x : new Error(`no ${what} read scripted`);
  };
  const r: Readers = {
    again: async () => (calls.again++, script.again && !(script.again instanceof Error) ? script.again : fail(script.again, "second")),
    strong: async () => (calls.strong++, script.strong && !(script.strong instanceof Error) ? script.strong : fail(script.strong, "strong")),
    total: async () => (calls.total++, script.total ?? null),
    charges: async () => (calls.charges++, script.charges instanceof Error ? fail(script.charges, "charges") : (script.charges ?? [])),
  };
  return { r, calls };
}
const busy = () => "it was busy";

describe("resolve", () => {
  it("tells a clean invoice that adds up from one that does not", () => {
    expect(resolve(read({ ...paper, total: 109500 }), [paper], []).verdict).toBe("adds");
    expect(resolve(paper, [paper, paper], []).verdict).toBe("clean-mismatch");
  });

  it("confirms a row only when the charges read found it", () => {
    expect(resolve(vatInvoice, [vatInvoice, vatInvoice], [vat])).toMatchObject({ verdict: "adds", unsure: [] });
    const r = resolve(vatInvoice, [vatInvoice, vatInvoice], []);
    expect(r.verdict).toBe("adds-if");
    expect(r.unsure).toEqual([{ row: vat, why: "unconfirmed" }]);
    expect(r.invoice.charges).toEqual([{ ...vat, unsure: true }]);
  });

  it("ignores rows that only repeat the total or the lines' sum", () => {
    const echoes = read({ ...paper }, { label: "Total", amount: 109000 }, { label: "Sub-total", amount: 109500 });
    expect(resolve(echoes, [echoes, echoes], [{ label: "TOTAL", amount: 109000 }]).verdict).toBe("clean-mismatch");
  });

  it("does not check a total when a line has no price", () => {
    const unpriced = read({ supplier: null, items: [...goods, { quantity: 1, description: "Gift", unit_price: null, line_total: null }], total: 190000 });
    expect(resolve(unpriced, [unpriced], [{ label: "Advance", amount: 30000 }]).verdict).toBe("unchecked");
  });

  it("counts a row listed twice by the full reads but once by the charges read as only half confirmed", () => {
    const d = { label: "Delivery", amount: 1000 };
    const twice = generator(102000, d, d);
    const r = resolve(twice, [twice, twice], [d]);
    expect(r.verdict).toBe("adds-if");
    expect(r.unsure).toHaveLength(1);
  });

  it("takes 'V.A.T 7.5%' and 'VAT' for the same row, and never a delivery for a discount", () => {
    const dotted = read({ supplier: null, items: [line(1, "Generator", 100000, 100000)], total: 107500 }, { label: "V.A.T 7.5%", amount: 7500 });
    expect(resolve(dotted, [dotted], [{ label: "VAT", amount: 7500 }]).verdict).toBe("adds");
    const wrong = read({ supplier: null, items: [line(1, "Generator", 100000, 100000)], total: 110000 }, { label: "V.A.T 7.5%", amount: 7500 });
    expect(resolve(wrong, [wrong], [{ label: "VAT", amount: 7500 }]).invoice.charges).toHaveLength(1);
    const made = generator(97000, { label: "Discount", amount: -3000 });
    expect(resolve(made, [made], [{ label: "Delivery", amount: 3000 }]).verdict).toBe("adds-if");
  });
});

describe("settle: when the supplier is blamed", () => {
  it("confirms the supplier's mistake on a clean invoice read twice, with the charges read finding nothing (sample 1)", async () => {
    const { r, calls } = readers({ again: paper, charges: [] });
    const s = await settle(paper, r);
    expect(s.paperError).toMatch(/^The lines add up to ₦109,500, but the invoice total says ₦109,000\. Snap read the photo twice and got the same numbers both times\. Check these numbers/);
    expect(s.disputes).toBeUndefined();
    expect(calls).toEqual({ again: 1, strong: 0, total: 0, charges: 1 });
    expect(s.steps).toContain("VAT, delivery and discounts were also read on their own.");
  });

  it("flags a line's own arithmetic found twice, even when a charge is unconfirmed", async () => {
    const badLine = [line(2, "Ctn. Sugar 1kg", 30000, 60000), line(3, "Ctn. Indo", 5000, 18000), line(1, "Peak", 21000, 21000)]; // 3 × 5,000 is 15,000
    const plain = read({ supplier: "Rising Technology", items: badLine, total: 100000 });
    const withDelivery = read({ supplier: "Rising Technology", items: badLine, total: 100000 }, { label: "Delivery", amount: 1000 });
    const s = await settle(withDelivery, readers({ again: plain, charges: [] }).r);
    expect(s.paperError).toMatch(/^Line 2: 3 × ₦5,000 is ₦15,000, not ₦18,000\. Snap read the photo twice/);
  });

  it("settles a dispute over the total alone with a narrow read of the written total", async () => {
    const corrected = read({ ...paper, total: 109500 }); // a reader that "fixed" the paper's sum
    const a = await settle(paper, readers({ again: corrected, total: 109000, charges: [] }).r);
    expect(a.invoice.total).toBe(109000);
    expect(a.paperError).toMatch(/The total was read again on its own and came back as ₦109,000 again\./);
    const b = await settle(read({ ...paper, total: 109900 }), readers({ again: corrected, total: 109500, charges: [] }).r);
    expect(b.invoice.total).toBe(109500);
    expect(b.paperError).toBeUndefined();
    const c = await settle(paper, readers({ again: corrected, total: 190000, charges: [] }).r);
    expect(c.paperError).toBeUndefined();
    expect(c.disputes?.some((d) => d.field === "total")).toBe(true);
  });

  it("confirms the mistake when the stronger model agrees with either quick read, and says so", async () => {
    const misread = read({ ...paper, items: [line(2, "Sugar", 30000, 61000), ...lines.slice(1)] });
    const a = await settle(paper, readers({ again: misread, strong: paper, charges: [] }).r);
    expect(a.paperError).toMatch(/Two of three reads, one by a stronger model, found the same numbers\./);
    const corrected = read({ ...paper, items: [line(2, "Sugar", 30000, 59500), ...lines.slice(1)] }); // "fixed" to add up
    const b = await settle(paper, readers({ again: corrected, strong: paper, charges: [] }).r);
    expect(b.paperError).toMatch(/Two of three reads/);
    expect(b.invoice.items[0].line_total).toBe(60000);
  });
});

describe("settle: never blamed, never cleared on a guess", () => {
  it("does not blame the paper when the charges could not be looked for on their own", async () => {
    const s = await settle(paper, readers({ again: paper, charges: new Error("busy") }).r, { why: busy });
    expect(s.paperError).toBeUndefined();
    expect(s.disputes?.[0].note).toMatch(/^Reading the charges on their own failed, so Snap could not rule out/);
    expect(s.steps).toContain("Reading VAT, delivery and discounts on their own failed (it was busy).");
  });

  it("marks a discount the charges read did not find: not all clear, not blamed", async () => {
    const { r, calls } = readers({ charges: [] });
    const s = await settle(paperWithDiscount, r);
    expect(s.paperError).toBeUndefined();
    expect(s.invoice.charges).toEqual([{ ...discount, unsure: true }]);
    expect(s.disputes?.[0].note).toBe(
      "Discount -₦500 is counted, but the charges read on their own did not find it. With it the total adds up; without, the lines and other charges come to ₦109,500 and the total says ₦109,000. It is marked in orange: check against the paper.",
    );
    expect(calls).toEqual({ again: 0, strong: 0, total: 0, charges: 1 });
  });

  it("marks a VAT line the charges read missed, without a second full read (it could not confirm it)", async () => {
    const { r, calls } = readers({ charges: [] });
    const s = await settle(vatInvoice, r);
    expect(s.paperError).toBeUndefined();
    expect(s.invoice.charges).toEqual([{ ...vat, unsure: true }]);
    expect(calls).toEqual({ again: 0, strong: 0, total: 0, charges: 1 });
  });

  it("marks charges as unchecked when the charges read fails", async () => {
    const s = await settle(vatInvoice, readers({ charges: new Error("busy") }).r, { why: busy });
    expect(s.disputes?.[0].note).toMatch(/^VAT 7\.5% ₦12,000 is counted, but reading the charges on their own failed\./);
  });

  it("marks, never clears or blames, a discount that was added instead of taken off", async () => {
    const plus = { label: "Discount", amount: 3000 };
    const s = await settle(generator(103000, plus), readers({ charges: [{ label: "Discount", amount: -3000 }] }).r);
    expect(s.paperError).toBeUndefined();
    expect(s.invoice.charges).toEqual([{ ...plus, unsure: true }]);
    expect(s.disputes?.[0].note).toMatch(/^Discount ₦3,000 is counted the other way from what the label says/);
  });

  it("never lets a delivery line vouch for a discount of the same size", async () => {
    const s = await settle(generator(97000, { label: "Discount", amount: -3000 }), readers({ charges: [{ label: "Delivery", amount: 3000 }] }).r);
    expect(s.paperError).toBeUndefined();
    expect(s.invoice.charges?.some((c) => c.unsure)).toBe(true);
  });

  it("asks the owner to check the total, never blaming, when other amounts are listed and no way of counting them works", async () => {
    const wrongTotal = read({ supplier: "Tasiu", items: goods, total: 175000 }, vat); // ₦160,000 + ₦12,000 is not ₦175,000
    const s = await settle(wrongTotal, readers({ again: wrongTotal, charges: [vat] }).r);
    expect(s.paperError).toBeUndefined();
    expect(s.disputes?.[0].note).toMatch(/^This invoice lists other amounts/);
    expect(checkSums(s.invoice).problems[0]).toBe("The lines and charges add up to ₦172,000, but the invoice total says ₦175,000.");
  });

  it("never blames the supplier for a quantity nobody wrote", async () => {
    const noQty = { supplier: "Tasiu", items: [{ quantity: null, description: "Rice 50kg", unit_price: 25000, line_total: 70000 }], total: 70000 };
    expect(normalize(noQty).items[0]).toMatchObject({ quantity: 1, guessed: true });
    const s = await settle(normalize(noQty), readers({ again: normalize(noQty), charges: [] }).r);
    expect(s.paperError).toBeUndefined();
  });

  it("never blames the paper when there are more rows than can all be tried", async () => {
    const many = Array.from({ length: 14 }, (_, i) => ({ label: `Row ${i + 1}`, amount: 1000 * (i + 1) }));
    const s = await settle(read({ ...paper }, ...many), readers({ again: read({ ...paper }, ...many), charges: many }).r);
    expect(s.paperError).toBeUndefined();
  });

  it("explains a stronger-model read with charges that do not add up, without claiming a charges read", async () => {
    const s = await settle(read({ supplier: "Tasiu", items: goods, total: 175000 }, vat), readers({ charges: [] }).r, { secondRead: false });
    expect(s.paperError).toBeUndefined();
    expect(s.disputes?.[0].note).toMatch(/^This invoice lists other amounts/);
  });
});

describe("settle: all clear", () => {
  it("keeps a first read that adds up with no extra rows, with no extra reads", async () => {
    const { r, calls } = readers({});
    const s = await settle(read({ ...paper, total: 109500 }), r);
    expect(s.paperError).toBeUndefined();
    expect(s.disputes).toBeUndefined();
    expect(calls).toEqual({ again: 0, strong: 0, total: 0, charges: 0 });
  });

  it("keeps a real VAT line once the charges read confirms it", async () => {
    const { r, calls } = readers({ charges: [vat] });
    const s = await settle(vatInvoice, r);
    expect(s.invoice.charges).toEqual([vat]);
    expect(s.disputes).toBeUndefined();
    expect(calls).toEqual({ again: 0, strong: 0, total: 0, charges: 1 });
  });

  it("finds a VAT or delivery line the full reads missed, before any blame", async () => {
    const a = await settle(vatMissed, readers({ again: vatInvoice, charges: [vat] }).r);
    expect(a.invoice.charges).toEqual([vat]);
    expect(a.paperError).toBeUndefined();
    const delivery = { label: "Delivery", amount: 2000 };
    const missed = read({ supplier: "Tasiu", items: goods, total: 162000 });
    const b = await settle(missed, readers({ again: missed, charges: [delivery] }).r);
    expect(b.invoice.charges).toEqual([delivery]);
    expect(b.disputes).toBeUndefined();
  });

  it("counts rows as written whatever their labels: withholding tax, a late payment fee, an unlabelled minus", async () => {
    const wht = { label: "Withholding tax 5%", amount: -5000 };
    const vat2 = { label: "VAT 7.5%", amount: 7500 };
    const a = await settle(generator(102500, vat2, wht), readers({ charges: [vat2, wht] }).r);
    expect(a.disputes).toBeUndefined();
    const fee = { label: "Late payment fee", amount: 2000 };
    const b = await settle(generator(102000, fee), readers({ charges: [fee] }).r);
    expect(b.disputes).toBeUndefined();
    const blank = { label: "Charge", amount: -500 };
    const c = await settle(generator(99500, blank), readers({ charges: [blank] }).r);
    expect(c.disputes).toBeUndefined();
  });

  it("counts a crate deposit however its sign was written, and leaves out payments and subtotals", async () => {
    const drinks = read({ supplier: "NBC", items: [line(10, "Crate of Coke", 5000, 50000)], total: 52000 }, { label: "Crate deposit", amount: -2000 });
    const s = await settle(drinks, readers({ charges: [{ label: "Crate deposit", amount: 2000 }, { label: "Amount paid", amount: 30000 }] }).r);
    expect(s.invoice.charges).toEqual([{ label: "Crate deposit", amount: 2000 }]);
    expect(s.disputes).toBeUndefined();
    const sub = { label: "SUBTOTAL", amount: 160000 };
    const t = await settle(read({ supplier: "Tasiu", items: goods, total: 172000 }, sub, vat), readers({ charges: [sub, vat] }).r);
    expect(t.invoice.charges).toEqual([vat]);
    expect(t.disputes).toBeUndefined();
  });

  it("takes off a payment written without a minus sign when the total read is the balance", async () => {
    const paid = { label: "Paid", amount: 30000 };
    const s = await settle(generator(70000, paid), readers({ charges: [paid] }).r);
    expect(s.invoice.charges).toEqual([{ label: "Paid", amount: -30000 }]);
    expect(s.disputes).toBeUndefined();
  });
});

describe("settle: reading", () => {
  it("keeps the second read's names when both reads found the same numbers", async () => {
    const named = { ...paper, supplier: null, items: lines.map((l, i) => ({ ...l, description: ["Sugar", "Indomie", "Peak"][i] })) };
    const s = await settle(paper, readers({ again: named, charges: [] }).r);
    expect(s.invoice.items.map((l) => l.description)).toEqual(["Sugar", "Indomie", "Peak"]);
    expect(s.invoice.supplier).toBe("Rising Technology");
  });

  it("shows the first read, for the owner to check, when the second read fails", async () => {
    const s = await settle(paper, readers({ again: new Error("busy"), charges: [] }).r, { why: busy });
    expect(s.invoice.items).toEqual(paper.items);
    expect(s.paperError).toBeUndefined();
    expect(s.steps.at(-1)).toMatch(/^The second read failed \(it was busy\)/);
  });

  it("marks the disputed numbers, and keeps the supplier from either read, when the stronger model cannot help", async () => {
    const misread = read({ ...paper, supplier: null, items: [line(2, "Sugar", 30000, 61000), ...lines.slice(1)] });
    const s = await settle(paper, readers({ again: misread, strong: new Error("busy"), charges: [] }).r, { why: busy });
    expect(s.paperError).toBeUndefined();
    expect(s.disputes?.some((d) => d.line === 0 && d.field === "line_total")).toBe(true);
    expect(s.invoice.supplier).toBe("Rising Technology");
  });

  it("never shows an empty second read in place of one that found lines", async () => {
    const empty = read({ supplier: null, items: [], total: null });
    const s = await settle(paper, readers({ again: empty, strong: new Error("busy"), charges: [] }).r);
    expect(s.invoice.items).toHaveLength(3);
  });

  it("makes no second read when the first came from the stronger model", async () => {
    const { r, calls } = readers({});
    const s = await settle(paper, r, { secondRead: false });
    expect(s.invoice.items).toEqual(paper.items);
    expect(calls.again).toBe(0);
  });
});
