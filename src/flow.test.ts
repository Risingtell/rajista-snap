import { describe, expect, it } from "vitest";
import { judgeCharges, settle, type Readers } from "./flow";
import type { Charge, Invoice, Line } from "./invoice";

const line = (quantity: number, description: string, unit: number, total: number): Line => ({ quantity, description, unit_price: unit, line_total: total });
// Sample invoice 1: the lines make ₦109,500 but the paper's total says ₦109,000 (the supplier's own mistake).
const lines = [line(2, "Ctn. Sugar 1kg", 30000, 60000), line(3, "Ctn. Indo Ch. Kn 70g", 9500, 28500), line(1, "Ctn Peak Tin 160g", 21000, 21000)];
const paper: Invoice = { supplier: "Rising Technology", items: lines, total: 109000, charges: [] };
const withCharge = (inv: Invoice, ...charges: Charge[]): Invoice => ({ ...inv, charges });
const discount = { label: "Discount", amount: -500 };
// A correct printed VAT invoice: ₦160,000 of goods, VAT ₦12,000, total ₦172,000.
const vat = { label: "VAT 7.5%", amount: 12000 };
const goods = [line(4, "Ctn Milo 400g", 40000, 160000)];
const vatInvoice: Invoice = { supplier: "Tasiu", items: goods, total: 172000, charges: [vat] };
const vatMissed: Invoice = { ...vatInvoice, charges: [] };

/** Readers that answer from a script and count every call. */
function readers(script: { again?: Invoice | Error; strong?: Invoice; total?: number | null; charges?: Charge[] | Error }) {
  const calls = { again: 0, strong: 0, total: 0, charges: 0 };
  const r: Readers = {
    again: async () => {
      calls.again++;
      if (!script.again || script.again instanceof Error) throw script.again ?? new Error("no second read scripted");
      return script.again;
    },
    strong: async () => {
      calls.strong++;
      if (!script.strong) throw new Error("no strong read scripted");
      return script.strong;
    },
    total: async () => {
      calls.total++;
      return script.total ?? null;
    },
    charges: async () => {
      calls.charges++;
      if (script.charges instanceof Error) throw script.charges;
      return script.charges ?? [];
    },
  };
  return { r, calls };
}

describe("judgeCharges", () => {
  it("takes charges read on their own when they make the read add up, and confirms matching ones", () => {
    expect(judgeCharges(vatMissed, [vat])).toEqual({ inv: vatInvoice, state: "confirmed" });
    expect(judgeCharges(vatInvoice, [vat]).state).toBe("confirmed");
    expect(judgeCharges(paper, []).state).toBe("none");
  });

  it("disputes charges that only a full read found, and leaves them unchecked without a narrow read", () => {
    expect(judgeCharges(withCharge(paper, discount), []).state).toBe("disputed");
    expect(judgeCharges(vatInvoice, []).state).toBe("disputed");
    expect(judgeCharges(vatInvoice, null).state).toBe("unchecked");
    expect(judgeCharges(paper, null).state).toBe("none");
  });
});

describe("settle", () => {
  it("keeps a first read that adds up with no charges, with no extra reads", async () => {
    const ok = { ...paper, total: 109500 };
    const { r, calls } = readers({});
    const s = await settle(ok, r);
    expect(s.invoice).toEqual(ok);
    expect(s.paperError).toBeUndefined();
    expect(calls).toEqual({ again: 0, strong: 0, total: 0, charges: 0 });
  });

  it("confirms the supplier's mistake when the second read and the charges read agree (sample invoice 1)", async () => {
    const { r, calls } = readers({ again: paper, charges: [] });
    const s = await settle(paper, r);
    expect(s.paperError).toMatch(/^The lines add up to ₦109,500, but the invoice total says ₦109,000\. Snap read the photo twice/);
    expect(s.disputes).toBeUndefined();
    expect(calls).toEqual({ again: 1, strong: 0, total: 0, charges: 1 });
    expect(s.steps).toContain("VAT, delivery and discounts were also read on their own.");
  });

  it("finds the mistake when only the first read invented a discount", async () => {
    const { r } = readers({ again: paper, charges: [] });
    const s = await settle(withCharge(paper, discount), r);
    expect(s.invoice.charges).toEqual([]);
    expect(s.paperError).toMatch(/Snap read the photo twice/);
  });

  it("finds the mistake when only the second read invented a charge", async () => {
    const over = { ...paper, total: 110000 }; // lines ₦109,500, total ₦110,000: a ₦500 overcharge
    const { r } = readers({ again: withCharge(over, { label: "Delivery", amount: 500 }), charges: [] });
    const s = await settle(over, r);
    expect(s.invoice.charges).toEqual([]);
    expect(s.paperError).toMatch(/the invoice total says ₦110,000/);
  });

  it("blames nothing when both full reads list a discount the charges read did not find, and marks it", async () => {
    const { r } = readers({ again: withCharge(paper, discount), charges: [] });
    const s = await settle(withCharge(paper, discount), r);
    expect(s.paperError).toBeUndefined();
    expect(s.disputes).toEqual([{ line: null, field: "charges", shown: -500, other: 0 }]);
  });

  it("keeps a real VAT line once the charges read confirms it, without a second full read", async () => {
    const { r, calls } = readers({ charges: [vat] });
    const s = await settle(vatInvoice, r);
    expect(s.invoice.charges).toEqual([vat]);
    expect(s.paperError).toBeUndefined();
    expect(s.disputes).toBeUndefined();
    expect(calls).toEqual({ again: 0, strong: 0, total: 0, charges: 1 });
  });

  it("never calls a correct VAT invoice wrong when the charges read misses the VAT", async () => {
    const { r, calls } = readers({ again: vatInvoice, charges: [] });
    const s = await settle(vatInvoice, r);
    expect(s.paperError).toBeUndefined();
    expect(s.invoice.charges).toEqual([vat]);
    expect(s.disputes).toEqual([{ line: null, field: "charges", shown: 12000, other: 0 }]);
    expect(calls.again).toBe(1);
  });

  it("adds a VAT line the first full read missed when the charges read finds it", async () => {
    const { r } = readers({ again: vatInvoice, charges: [vat] });
    const s = await settle(vatMissed, r);
    expect(s.invoice.charges).toEqual([vat]);
    expect(s.paperError).toBeUndefined();
    expect(s.disputes).toBeUndefined();
  });

  it("never blames the paper for a delivery line both full reads missed", async () => {
    const delivery = { label: "Delivery", amount: 2000 };
    const missed: Invoice = { supplier: "Tasiu", items: goods, total: 162000, charges: [] };
    const { r } = readers({ again: missed, charges: [delivery] });
    const s = await settle(missed, r);
    expect(s.invoice.charges).toEqual([delivery]);
    expect(s.paperError).toBeUndefined();
  });

  it("never counts a subtotal or total that a reader listed among the charges (seen 16 Nov 2026)", async () => {
    const { r } = readers({ charges: [{ label: "Amount before tax", amount: 160000 }, vat, { label: "To pay", amount: 172000 }] });
    const s = await settle(vatInvoice, r);
    expect(s.invoice.charges).toEqual([vat]);
    expect(s.paperError).toBeUndefined();
  });

  it("marks charges for the owner to check when they cannot be read on their own", async () => {
    const { r } = readers({ charges: new Error("busy") });
    const s = await settle(vatInvoice, r, { why: () => "it was busy" });
    expect(s.disputes).toEqual([{ line: null, field: "charges", shown: 12000, other: null }]);
    expect(s.steps.join(" ")).toMatch(/reading them on their own failed \(it was busy\)/);
  });

  it("still finds the supplier's mistake when the charges read fails and no read lists charges", async () => {
    const { r } = readers({ again: paper, charges: new Error("busy") });
    const s = await settle(paper, r, { why: () => "it was busy" });
    expect(s.paperError).toMatch(/Snap read the photo twice/);
    expect(s.steps).toContain("Reading VAT, delivery and discounts on their own failed (it was busy).");
  });

  it("shows the first read, for the owner to check, when the second read fails", async () => {
    const { r } = readers({ again: new Error("busy"), charges: [] });
    const s = await settle(paper, r, { why: () => "it was busy" });
    expect(s.invoice).toEqual(paper);
    expect(s.paperError).toBeUndefined();
    expect(s.steps.at(-1)).toMatch(/^The second read failed \(it was busy\)/);
  });

  it("settles a dispute over the total alone with a narrow read of the written total", async () => {
    const corrected = { ...paper, total: 109500 }; // a reader that "fixed" the paper's sum
    const { r, calls } = readers({ again: corrected, total: 109000, charges: [] });
    const s = await settle(paper, r);
    expect(s.invoice.total).toBe(109000);
    expect(s.paperError).toMatch(/The total was read again on its own/);
    expect(calls.total).toBe(1);
  });

  it("brings in the stronger model only when the lines disagree", async () => {
    const misread = { ...paper, items: [line(2, "Sugar", 30000, 61000), ...lines.slice(1)] };
    const { r, calls } = readers({ again: misread, strong: paper, charges: [] });
    const s = await settle(paper, r);
    expect(calls.strong).toBe(1);
    expect(s.paperError).toMatch(/Snap read the photo twice/);
  });

  it("makes no second read when the first came from the stronger model", async () => {
    const { r, calls } = readers({});
    const s = await settle(paper, r, { secondRead: false });
    expect(s.invoice).toEqual(paper);
    expect(calls.again).toBe(0);
  });
});
