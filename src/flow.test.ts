import { describe, expect, it } from "vitest";
import { settle, type Readers } from "./flow";
import type { Charge, Invoice, Line } from "./invoice";

const line = (quantity: number, description: string, unit: number, total: number): Line => ({ quantity, description, unit_price: unit, line_total: total });
// Sample invoice 1: the lines make ₦109,500 but the paper's total says ₦109,000 (the supplier's own mistake).
const lines = [line(2, "Ctn. Sugar 1kg", 30000, 60000), line(3, "Ctn. Indo Ch. Kn 70g", 9500, 28500), line(1, "Ctn Peak Tin 160g", 21000, 21000)];
const paper: Invoice = { supplier: "Rising Technology", items: lines, total: 109000, charges: [] };
const withCharge = (inv: Invoice, ...charges: Charge[]): Invoice => ({ ...inv, charges });
const discount = { label: "Discount", amount: -500 };

/** Readers that answer from a script and count every call. */
function readers(script: { again?: Invoice[]; strong?: Invoice; total?: number | null; charges?: Charge[] | Error }) {
  const calls = { again: 0, strong: 0, total: 0, charges: 0 };
  const again = [...(script.again ?? [])];
  const r: Readers = {
    again: async () => {
      calls.again++;
      const next = again.shift();
      if (!next) throw new Error("no second read scripted");
      return next;
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

describe("settle", () => {
  it("keeps a first read that adds up with no charges, with no extra reads", async () => {
    const ok = { ...paper, total: 109500 };
    const { r, calls } = readers({});
    const s = await settle(ok, r);
    expect(s.invoice).toEqual(ok);
    expect(s.paperError).toBeUndefined();
    expect(calls).toEqual({ again: 0, strong: 0, total: 0, charges: 0 });
  });

  it("confirms the supplier's mistake when a second read finds the same numbers", async () => {
    const { r, calls } = readers({ again: [paper] });
    const s = await settle(paper, r);
    expect(s.paperError).toMatch(/^The lines add up to ₦109,500, but the invoice total says ₦109,000\. Snap read the photo twice/);
    expect(calls).toEqual({ again: 1, strong: 0, total: 0, charges: 0 });
  });

  it("does not let an invented discount in the first read hide the mistake", async () => {
    const { r, calls } = readers({ again: [paper], charges: [] });
    const s = await settle(withCharge(paper, discount), r);
    expect(s.invoice.charges).toEqual([]);
    expect(s.paperError).toMatch(/does not add up|add up to ₦109,500/);
    expect(calls.charges).toBe(1);
  });

  it("does not let the same invented discount in both reads hide the mistake", async () => {
    const { r } = readers({ again: [withCharge(paper, discount)], charges: [] });
    const s = await settle(withCharge(paper, discount), r);
    expect(s.invoice.charges).toEqual([]);
    expect(s.paperError).toMatch(/Snap read the photo twice and got the same numbers both times/);
    expect(s.disputes).toBeUndefined();
  });

  it("does not let an invented charge in the second read win over a first read without it", async () => {
    const over = { ...paper, total: 110000 }; // lines ₦109,500, total ₦110,000: a ₦500 overcharge
    const { r, calls } = readers({ again: [withCharge(over, { label: "Delivery", amount: 500 })], charges: [] });
    const s = await settle(over, r);
    expect(s.invoice.charges).toEqual([]);
    expect(s.paperError).toMatch(/the invoice total says ₦110,000/);
    expect(calls).toEqual({ again: 1, strong: 0, total: 0, charges: 1 });
  });

  it("keeps a real VAT line once the charges read on their own agree, without a second full read", async () => {
    const vat = { label: "VAT 7.5%", amount: 12000 };
    const inv: Invoice = { supplier: "Tasiu", items: [line(4, "Ctn Milo 400g", 40000, 160000)], total: 172000, charges: [vat] };
    const { r, calls } = readers({ charges: [vat] });
    const s = await settle(inv, r);
    expect(s.invoice.charges).toEqual([vat]);
    expect(s.paperError).toBeUndefined();
    expect(s.disputes).toBeUndefined();
    expect(calls).toEqual({ again: 0, strong: 0, total: 0, charges: 1 });
  });

  it("never counts a subtotal or total that a reader listed among the charges (seen 16 Nov 2026)", async () => {
    const vat = { label: "VAT 7.5%", amount: 12000 };
    const inv: Invoice = { supplier: "Tasiu", items: [line(4, "Ctn Milo 400g", 40000, 160000)], total: 172000, charges: [vat] };
    // Even with a label the filter does not know, an amount equal to the lines or to the total is not a charge.
    const { r } = readers({ charges: [{ label: "Amount before tax", amount: 160000 }, vat, { label: "To pay", amount: 172000 }] });
    const s = await settle(inv, r);
    expect(s.invoice.charges).toEqual([vat]);
    expect(s.paperError).toBeUndefined();
  });

  it("adds a VAT line the full read missed when the charges read finds it", async () => {
    const vat = { label: "VAT", amount: 12000 };
    const missed: Invoice = { supplier: "Tasiu", items: [line(4, "Ctn Milo 400g", 40000, 160000)], total: 172000, charges: [] };
    const { r } = readers({ again: [withCharge(missed, vat)], charges: [vat] });
    const s = await settle(missed, r);
    expect(s.invoice.charges).toEqual([vat]);
    expect(s.paperError).toBeUndefined();
  });

  it("marks the charges for the owner to check when they cannot be read on their own", async () => {
    const vat = { label: "VAT", amount: 12000 };
    const inv: Invoice = { supplier: "Tasiu", items: [line(4, "Ctn Milo 400g", 40000, 160000)], total: 172000, charges: [vat] };
    const { r } = readers({ charges: new Error("busy") });
    const s = await settle(inv, r, { why: () => "it was busy" });
    expect(s.disputes).toEqual([{ line: null, field: "charges", shown: 12000, other: null }]);
    expect(s.steps.join(" ")).toMatch(/reading them on their own failed \(it was busy\)/);
  });

  it("shows the first read, for the owner to check, when the second read fails", async () => {
    const { r } = readers({ again: [] });
    const s = await settle(paper, r, { why: () => "it was busy" });
    expect(s.invoice).toEqual(paper);
    expect(s.paperError).toBeUndefined();
    expect(s.steps.at(-1)).toMatch(/^The second read failed \(it was busy\)/);
  });

  it("settles a dispute over the total alone with a narrow read of the written total", async () => {
    const corrected = { ...paper, total: 109500 }; // a reader that "fixed" the paper's sum
    const { r, calls } = readers({ again: [corrected], total: 109000 });
    const s = await settle(paper, r);
    expect(s.invoice.total).toBe(109000);
    expect(s.paperError).toMatch(/The total was read again on its own/);
    expect(calls.total).toBe(1);
  });

  it("brings in the stronger model only when the lines disagree", async () => {
    const misread = { ...paper, items: [line(2, "Sugar", 30000, 61000), ...lines.slice(1)] };
    const { r, calls } = readers({ again: [misread], strong: paper });
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
