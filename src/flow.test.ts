import { describe, expect, it } from "vitest";
import { resolve, settle, type Readers } from "./flow";
import { arrange, type Charge, type Invoice, type Line } from "./invoice";

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
  it("counts a row the charges read found, and marks one that only full reads found", () => {
    expect(resolve(vatInvoice, [vatInvoice, vatInvoice], [vat]).invoice.charges).toEqual([vat]);
    expect(resolve(vatMissed, [vatMissed, vatMissed], [vat]).invoice.charges).toEqual([vat]);
    // Two full reads are the same model seeing the same gap: they do not confirm a row on their own.
    const r = resolve(vatInvoice, [vatInvoice, vatInvoice], []);
    expect(r.unsure).toEqual([vat]);
    expect(r.invoice.charges).toEqual([{ ...vat, unsure: true }]);
  });

  it("never searches rows to fill a gap left by a line with no price", () => {
    const unpriced = read({ supplier: null, items: [...goods, { quantity: 1, description: "Gift", unit_price: null, line_total: null }], total: 190000 });
    const r = resolve(unpriced, [unpriced], [{ label: "Advance", amount: 30000 }]);
    expect(r.unsure).toEqual([]);
    expect(r.invoice.charges).toEqual([]);
  });

  it("never blames the paper when there are more rows than can all be tried", () => {
    const many = Array.from({ length: 13 }, (_, i) => ({ label: `Row ${i + 1}`, amount: 1000 * (i + 1) }));
    const r = resolve(paper, [paper, paper], many);
    expect(r.capped).toBe(true);
  });

  it("marks a row only one full read found as unsure, and never makes it up", () => {
    const r = resolve(paperWithDiscount, [paperWithDiscount, paper], []);
    expect(r.unsure).toEqual([discount]);
    expect(r.invoice.charges).toEqual([{ ...discount, unsure: true }]);
    expect(resolve(paper, [paper, paper], []).adds).toBe(false);
  });
});

describe("settle", () => {
  it("keeps a first read that adds up with no extra rows, with no extra reads", async () => {
    const ok = read({ ...paper, total: 109500 });
    const { r, calls } = readers({});
    const s = await settle(ok, r);
    expect(s.invoice.total).toBe(109500);
    expect(s.paperError).toBeUndefined();
    expect(calls).toEqual({ again: 0, strong: 0, total: 0, charges: 0 });
  });

  it("confirms the supplier's mistake when two reads and the charges read agree (sample invoice 1)", async () => {
    const { r, calls } = readers({ again: paper, charges: [] });
    const s = await settle(paper, r);
    expect(s.paperError).toMatch(/^The lines add up to ₦109,500, but the invoice total says ₦109,000\. Snap read the photo twice and got the same numbers both times\. Check these numbers/);
    expect(s.disputes).toBeUndefined();
    expect(calls).toEqual({ again: 1, strong: 0, total: 0, charges: 1 });
    expect(s.steps).toContain("VAT, delivery and discounts were also read on their own.");
  });

  it("keeps the second read's names when both reads found the same numbers", async () => {
    const named = { ...paper, supplier: null, items: lines.map((l, i) => ({ ...l, description: ["Sugar", "Indomie", "Peak"][i] })) };
    const { r } = readers({ again: named, charges: [] });
    const s = await settle(paper, r);
    expect(s.invoice.items.map((l) => l.description)).toEqual(["Sugar", "Indomie", "Peak"]);
    expect(s.invoice.supplier).toBe("Rising Technology");
  });

  it("never lets a discount one read made up hide the mistake: it is marked for the owner, with the sum without it", async () => {
    const { r } = readers({ again: paper, charges: [] });
    const s = await settle(paperWithDiscount, r);
    expect(s.paperError).toBeUndefined();
    expect(s.invoice.charges).toEqual([{ ...discount, unsure: true }]);
    expect(s.disputes).toEqual([
      {
        line: null,
        field: "charges",
        shown: -500,
        other: 0,
        note: "Discount -₦500 was not found when the charges were read on their own, so it is marked in orange. With it, the total adds up; without, the lines and other charges come to ₦109,500 and the total says ₦109,000.",
      },
    ]);
  });

  it("does not let the same discount made up by both full reads hide the mistake when the charges read saw none", async () => {
    const { r } = readers({ again: paperWithDiscount, charges: [] });
    const s = await settle(paperWithDiscount, r);
    expect(s.paperError).toBeUndefined();
    expect(s.invoice.charges).toEqual([{ ...discount, unsure: true }]);
    expect(s.disputes?.[0].note).toMatch(/^Discount -₦500 was not found when the charges were read on their own/);
  });

  it("still flags a line's arithmetic two reads confirmed, even when a charge is unsure", async () => {
    const badLine = [line(2, "Ctn. Sugar 1kg", 30000, 60000), line(3, "Ctn. Indo", 5000, 18000), line(1, "Peak", 21000, 21000)]; // 3 × 5,000 is 15,000
    const delivery = { label: "Delivery", amount: 1000 };
    const withDelivery = read({ supplier: "Rising Technology", items: badLine, total: 100000 }, delivery);
    const plain = read({ supplier: "Rising Technology", items: badLine, total: 100000 });
    const s = await settle(withDelivery, readers({ again: plain, charges: [] }).r);
    expect(s.paperError).toMatch(/^Line 2: 3 × ₦5,000 is ₦15,000, not ₦18,000\. Snap read the photo twice/);
    expect(s.disputes?.[0].note).toMatch(/the total adds up/);
  });

  it("takes off a payment or discount written without a minus sign", async () => {
    const paid = { label: "Paid", amount: 30000 };
    const balanceDue = read({ supplier: "Tasiu", items: [line(1, "Generator", 100000, 100000)], total: 70000 }, paid);
    const s1 = await settle(balanceDue, readers({ charges: [paid] }).r);
    expect(s1.invoice.charges).toEqual([{ label: "Paid", amount: -30000 }]);
    expect(s1.paperError).toBeUndefined();
    const off = { label: "Discount", amount: 5000 };
    const discounted = read({ supplier: "Tasiu", items: [line(1, "Generator", 100000, 100000)], total: 95000 }, off);
    const s2 = await settle(discounted, readers({ charges: [off] }).r);
    expect(s2.invoice.charges).toEqual([{ label: "Discount", amount: -5000 }]);
    expect(s2.disputes).toBeUndefined();
  });

  it("marks a charge only the second read found, rather than believing it", async () => {
    const over = read({ ...paper, total: 110000 }); // lines ₦109,500, total ₦110,000: a ₦500 overcharge
    const delivery = { label: "Delivery", amount: 500 };
    const { r } = readers({ again: read({ ...paper, total: 110000 }, delivery), charges: [] });
    const s = await settle(over, r);
    expect(s.paperError).toBeUndefined();
    expect(s.invoice.charges).toEqual([{ ...delivery, unsure: true }]);
  });

  it("marks a charge only the stronger model found (it is weighed like any other read)", async () => {
    const misread = read({ ...paper, items: [line(2, "Sugar", 30000, 61000), ...lines.slice(1)] });
    const { r, calls } = readers({ again: misread, strong: paperWithDiscount, charges: [] });
    const s = await settle(paper, r);
    expect(calls.strong).toBe(1);
    expect(s.paperError).toBeUndefined();
    expect(s.invoice.charges).toEqual([{ ...discount, unsure: true }]);
  });

  it("marks, never blames, a VAT line both full reads found but the charges read missed", async () => {
    const { r, calls } = readers({ again: vatInvoice, charges: [] });
    const s = await settle(vatInvoice, r);
    expect(s.invoice.charges).toEqual([{ ...vat, unsure: true }]);
    expect(s.paperError).toBeUndefined();
    expect(s.disputes?.[0].note).toMatch(/^VAT 7\.5% ₦12,000 was not found when the charges were read on their own/);
    expect(calls).toEqual({ again: 1, strong: 0, total: 0, charges: 1 });
  });

  it("keeps a real VAT line once the charges read confirms it, without a second full read", async () => {
    const { r, calls } = readers({ charges: [vat] });
    const s = await settle(vatInvoice, r);
    expect(s.invoice.charges).toEqual([vat]);
    expect(s.disputes).toBeUndefined();
    expect(calls).toEqual({ again: 0, strong: 0, total: 0, charges: 1 });
  });

  it("never blames the paper when only one of three reads found the VAT: it is marked instead", async () => {
    const { r } = readers({ again: vatMissed, charges: [] });
    const s = await settle(vatInvoice, r);
    expect(s.paperError).toBeUndefined();
    expect(s.invoice.charges).toEqual([{ ...vat, unsure: true }]);
  });

  it("finds a VAT or delivery line that both full reads missed, before any blame", async () => {
    const delivery = { label: "Delivery", amount: 2000 };
    const missed = read({ supplier: "Tasiu", items: goods, total: 162000 });
    const { r } = readers({ again: missed, charges: [delivery] });
    const s = await settle(missed, r);
    expect(s.invoice.charges).toEqual([delivery]);
    expect(s.paperError).toBeUndefined();
    expect(s.disputes).toBeUndefined();
  });

  it("counts rows by the arithmetic, not the label: transport equal to the goods, a crate deposit", async () => {
    const transport = { label: "Transport", amount: 5000 };
    const cement = read({ supplier: "Dangote", items: [line(1, "Bag of cement", 5000, 5000)], total: 10000 }, transport);
    const s1 = await settle(cement, readers({ charges: [transport] }).r);
    expect(s1.invoice.charges).toEqual([transport]);
    expect(s1.paperError).toBeUndefined();
    const crate = { label: "Crate deposit", amount: 2000 };
    const drinks = read({ supplier: "NBC", items: [line(12, "Crate of Coke", 4000, 48000)], total: 50000 }, crate, { label: "Amount paid", amount: 30000 });
    const s2 = await settle(drinks, readers({ charges: [crate, { label: "Amount paid", amount: 30000 }] }).r);
    expect(s2.invoice.charges).toEqual([crate]);
    expect(s2.paperError).toBeUndefined();
  });

  it("leaves out a subtotal or total that a reader copied among the charges (seen 16 Nov 2026)", async () => {
    const sub = { label: "SUBTOTAL", amount: 160000 };
    const s = await settle(read({ supplier: "Tasiu", items: goods, total: 172000 }, sub, vat), readers({ charges: [sub, vat, { label: "Grand Total", amount: 172000 }] }).r);
    expect(s.invoice.charges).toEqual([vat]);
    expect(s.paperError).toBeUndefined();
  });

  it("does not blame the paper when the charges could not be looked for on their own", async () => {
    const { r } = readers({ again: paper, charges: new Error("busy") });
    const s = await settle(paper, r, { why: busy });
    expect(s.paperError).toBeUndefined();
    expect(s.disputes).toEqual([
      {
        line: null,
        field: "charges",
        shown: 0,
        other: null,
        note: "Snap could not check every VAT, delivery or discount line on its own, so check the paper for any that is not listed here.",
      },
    ]);
    expect(s.steps).toContain("Reading VAT, delivery and discounts on their own failed (it was busy).");
  });

  it("marks a charge as not checked when the charges read fails", async () => {
    const { r } = readers({ again: vatInvoice, charges: new Error("busy") });
    const s = await settle(vatInvoice, r, { why: busy });
    expect(s.invoice.charges).toEqual([{ ...vat, unsure: true }]);
    expect(s.paperError).toBeUndefined();
    expect(s.disputes?.[0].note).toMatch(/could not be checked \(reading the charges on their own failed\)/);
    expect(s.steps.join(" ")).toMatch(/reading them on their own failed \(it was busy\)/);
  });

  it("shows the first read, for the owner to check, when the second read fails", async () => {
    const { r } = readers({ again: new Error("busy"), charges: [] });
    const s = await settle(paper, r, { why: busy });
    expect(s.invoice.items).toEqual(paper.items);
    expect(s.paperError).toBeUndefined();
    expect(s.steps.at(-1)).toMatch(/^The second read failed \(it was busy\)/);
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

  it("brings in the stronger model only when the lines disagree, and confirms the mistake when it agrees", async () => {
    const misread = read({ ...paper, items: [line(2, "Sugar", 30000, 61000), ...lines.slice(1)] });
    const { r, calls } = readers({ again: misread, strong: paper, charges: [] });
    const s = await settle(paper, r);
    expect(calls.strong).toBe(1);
    expect(s.paperError).toMatch(/Snap read the photo twice/);
  });

  it("confirms the mistake when the stronger model agrees with either quick read", async () => {
    const corrected = read({ ...paper, items: [line(2, "Sugar", 30000, 59500), ...lines.slice(1)] }); // "fixed" to add up
    const { r } = readers({ again: corrected, strong: paper, charges: [] });
    const s = await settle(paper, r);
    expect(s.paperError).toMatch(/Snap read the photo twice/);
    expect(s.invoice.items[0].line_total).toBe(60000);
  });

  it("keeps the supplier from either read when it shows one of two that differ", async () => {
    const misread = read({ ...paper, supplier: null, items: [line(2, "Sugar", 30000, 61000), ...lines.slice(1)] });
    const nameless = read({ ...paper, supplier: null });
    const s = await settle(nameless, readers({ again: misread, strong: new Error("busy"), charges: [] }).r);
    expect(s.invoice.supplier).toBeNull();
    const s2 = await settle(paper, readers({ again: read({ ...misread }), strong: new Error("busy"), charges: [] }).r);
    expect(s2.invoice.supplier).toBe("Rising Technology");
  });

  it("marks the disputed numbers when the stronger model cannot help", async () => {
    const misread = read({ ...paper, items: [line(2, "Sugar", 30000, 61000), ...lines.slice(1)] });
    const s = await settle(paper, readers({ again: misread, strong: new Error("busy"), charges: [] }).r, { why: busy });
    expect(s.paperError).toBeUndefined();
    expect(s.disputes?.some((d) => d.line === 0 && d.field === "line_total")).toBe(true);
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
