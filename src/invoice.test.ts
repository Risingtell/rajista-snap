import { describe, expect, it } from "vitest";
import { checkSums, disputes, naira, normalize, reconcile, sameLines, sameNumbers } from "./invoice";

// The three real invoices from the first test (14 Nov 2026), as each reader returned them.
const cloudRising = {
  items: [
    { quantity: 3, description: "HP Laptop 14 ep0083nia Intel Core i3 8gb Ram, 256gb ssd", unit_price: 595000, line_total: 1785000 },
    { quantity: 1, description: "HP X360 Intel Core i5 8gb Ram / 256gb SSD", unit_price: 580000, line_total: 580000 },
  ],
  total: 2365000,
};
const deviceRising = {
  items: [
    { quantity: 1, description: "HP Laptop 14 EP005s/Intel Core 13\n8gb Ram/256gb SSD", unit_price: 59500, line_total: 59500 },
    { quantity: 3, description: "HP X360 Intel Core i5\n8gb Ram/256gb SSD", unit_price: 58000, line_total: 174000 },
  ],
  total: 236500,
};
const goodwill = { items: [{ quantity: 1, description: "Maxi Standing gas cooker All gas burners", unit_price: null, line_total: 140000 }], total: 140000 };
const deliveryNote = { items: [{ quantity: 1, description: 'Optoma SFP2075C17-D03 75" 4k (UHD) Interactive Flat Panel', unit_price: null, line_total: null }], total: null };

describe("checkSums", () => {
  it("passes a correct read", () => {
    expect(checkSums(normalize(cloudRising))).toEqual({ ok: true, problems: [], hasPrices: true, crossChecked: true });
  });

  it("catches the on-device misread of the Rising Technology receipt", () => {
    const c = checkSums(normalize(deviceRising));
    expect(c.ok).toBe(false);
    expect(c.problems).toEqual(["The lines add up to ₦233,500, but the invoice total says ₦236,500."]);
  });

  it("passes a one-line invoice whose line total matches the invoice total", () => {
    expect(checkSums(normalize(goodwill))).toMatchObject({ ok: true, crossChecked: true });
  });

  it("does not trust a lone price with nothing to confirm it (the on-device read of the gas cooker invoice)", () => {
    const deviceGoodwill = { items: [{ quantity: 1, description: "Maxi Stalling Gas cooker All gas burners", unit_price: 160000, line_total: 160000 }], total: null };
    expect(checkSums(normalize(deviceGoodwill))).toMatchObject({ ok: true, crossChecked: false });
  });

  it("passes a delivery note with no prices, and says so", () => {
    expect(checkSums(normalize(deliveryNote))).toEqual({ ok: true, problems: [], hasPrices: false, crossChecked: true });
  });

  it("catches quantity times price that does not match the line total", () => {
    const c = checkSums(normalize({ items: [{ quantity: 2, description: "Milo 400g", unit_price: 3500, line_total: 6000 }], total: 6000 }));
    expect(c.problems).toEqual(["Line 1: 2 × ₦3,500 is ₦7,000, not ₦6,000."]);
  });

  it("rejects an empty read", () => {
    expect(checkSums(normalize({ items: [], total: null })).ok).toBe(false);
  });

  it("flags a total with no line prices at all", () => {
    expect(checkSums(normalize({ items: [{ quantity: 1, description: "Gas cooker", unit_price: null, line_total: null }], total: 140000 })).ok).toBe(false);
  });
});

describe("normalize", () => {
  it("cleans numbers written as text and joins broken descriptions", () => {
    const inv = normalize({ items: [{ quantity: "3", description: " HP Laptop\n 14 ", unit_price: "₦595,000", line_total: "1,785,000" }], total: "N1,785,000" });
    expect(inv).toEqual({ supplier: null, items: [{ quantity: 3, description: "HP Laptop 14", unit_price: 595000, line_total: 1785000 }], total: 1785000 });
  });

  it("accepts a JSON string", () => {
    expect(normalize('{"items":[{"quantity":1,"description":"Salt","unit_price":400,"line_total":400}],"total":400}').items).toHaveLength(1);
  });

  it("throws when there is no item list", () => {
    expect(() => normalize({ total: 5 })).toThrow();
  });
});

describe("sameNumbers", () => {
  // Alhaji Musa invoice 1 (16 Nov sample): the lines add up to 109,500, but the trader wrote 109,000.
  const paper = { supplier: null, items: [
    { quantity: 2, description: "Ctn. Sugar 1kg", unit_price: 30000, line_total: 60000 },
    { quantity: 3, description: "Ctn. Indo Chkn 70g", unit_price: 9500, line_total: 28500 },
    { quantity: 1, description: "Ctn Peak Tin 160g", unit_price: 21000, line_total: 21000 },
  ], total: 109000 };

  it("sees that two readers agree, so the paper itself does not add up", () => {
    const other = { ...paper, items: paper.items.map((l) => ({ ...l, description: l.description.toUpperCase() })) };
    expect(sameNumbers(paper, other)).toBe(true);
    expect(checkSums(paper).problems).toEqual(["The lines add up to ₦109,500, but the invoice total says ₦109,000."]);
  });

  it("notices when a reader changed a number", () => {
    expect(sameNumbers(paper, { ...paper, total: 109500 })).toBe(false);
  });
});

describe("reconcile", () => {
  const line = (quantity: number, description: string, unit_price: number | null, line_total: number | null) => ({ quantity, description, unit_price, line_total });
  // Alhaji Musa invoice 1 as written: the lines make 109,500, the trader wrote 109,000.
  const quick = { supplier: null, items: [line(2, "Ctn. Sgar 1kg", 30000, 60000), line(3, "Ctn. Indo Chkn 70g", 9500, 28500), line(1, "Ctn Peak Tin 160g", 21000, 21000)], total: 109000 };

  it("confirms a paper error only when both reads found the same numbers, keeping the stronger read's names", () => {
    const strong = { ...quick, supplier: "Alhaji Musa Wholesale", items: quick.items.map((l, i) => (i === 0 ? { ...l, description: "Ctn. Sugar 1kg" } : l)) };
    const r = reconcile(quick, strong);
    expect(r.paperError).toBe(
      "The lines add up to ₦109,500, but the invoice total says ₦109,000. Two separate reads found the same numbers, so the mistake is on the invoice itself. Check it with the supplier before you pay.",
    );
    expect(r.invoice.items[0].description).toBe("Ctn. Sugar 1kg");
    expect(r.invoice.supplier).toBe("Alhaji Musa Wholesale");
    expect(r.disputes).toEqual([]);
  });

  it("does not blame the paper when the quick read simply misread the total", () => {
    const misread = { ...quick, total: 108500 };
    const right = { ...quick, total: 109500 };
    const r = reconcile(misread, right);
    expect(r.paperError).toBeUndefined();
    expect(r.from).toBe("second");
    expect(r.invoice.total).toBe(109500);
    expect(r.disputes).toEqual([{ line: null, field: "total", shown: 109500, other: 108500 }]);
  });

  it("flags every number a stronger read changed, so a 'corrected' line cannot slip through unseen", () => {
    const paper = { supplier: null, items: [line(3, "Milo", 1500, 4000), line(1, "Salt", 8000, 8000)], total: 12000 };
    const fixed = { supplier: null, items: [line(3, "Milo", 1500, 4500), line(1, "Salt", 8000, 8000)], total: 12500 };
    const r = reconcile(paper, fixed);
    expect(r.paperError).toBeUndefined();
    expect(r.disputes).toEqual([
      { line: 0, field: "line_total", shown: 4500, other: 4000 },
      { line: null, field: "total", shown: 12500, other: 12000 },
    ]);
  });

  it("handles a second read with no total without inventing a sum", () => {
    const r = reconcile(quick, { ...quick, total: null });
    expect(r.paperError).toBeUndefined();
    expect(r.disputes).toEqual([{ line: null, field: "total", shown: null, other: 109000 }]);
  });

  it("reports a different number of lines as a dispute on the line count", () => {
    expect(disputes(quick, { ...quick, items: quick.items.slice(0, 2) })).toEqual([{ line: null, field: "lines", shown: 3, other: 2 }]);
  });

  it("sameLines ignores the total; sameNumbers does not", () => {
    expect(sameLines(quick, { ...quick, total: 1 })).toBe(true);
    expect(sameNumbers(quick, { ...quick, total: 1 })).toBe(false);
  });
});

describe("naira", () => {
  it("formats amounts and shows a chosen word for a missing one", () => {
    expect(naira(109500)).toBe("₦109,500");
    expect(naira(null)).toBe("");
    expect(naira(null, "none")).toBe("none");
  });
});
