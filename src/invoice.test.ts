import { describe, expect, it } from "vitest";
import { CHARGES_PROMPT, chargesFrom, checkSums, disputes, naira, normalize, reconcile, sameLines, sameNumbers, settleTotal, totalOnlyDispute, trustDeviceRead } from "./invoice";

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
    expect(checkSums(normalize(cloudRising))).toEqual({ ok: true, problems: [], notes: [], hasPrices: true, hasCharges: false, crossChecked: true });
  });

  it("allows half a naira per unit for a unit price rounded to the naira (a carton split per piece)", () => {
    const split = checkSums(normalize({ items: [{ quantity: 12, description: "Indomie (pieces)", unit_price: 1083, line_total: 13000 }], total: 13000 }));
    expect(split.ok).toBe(true);
    expect(split.notes).toEqual(["Line 1: 12 × ₦1,083 is ₦12,996, but the line says ₦13,000 (₦4 more). The unit price looks rounded from a pack price; check the line total against the paper."]);
    expect(trustDeviceRead(split)).toBe(false);
    expect(checkSums(normalize({ items: [{ quantity: 12, description: "Indomie (pieces)", unit_price: 1083, line_total: 13100 }], total: 13100 })).ok).toBe(false);
  });

  it("counts VAT, delivery and discounts in the sum, so a normal VAT invoice is not called wrong", () => {
    const vat = { items: [{ quantity: 1, description: "Gas cooker", unit_price: 100000, line_total: 100000 }], charges: [{ label: "VAT 7.5%", amount: 7500 }], total: 107500 };
    expect(checkSums(normalize(vat)).ok).toBe(true);
    const discount = { ...vat, charges: [{ label: "Discount", amount: -5000 }], total: 95000 };
    expect(checkSums(normalize(discount)).ok).toBe(true);
    expect(checkSums(normalize({ ...vat, total: 108500 })).problems).toEqual(["The lines and charges add up to ₦107,500, but the invoice total says ₦108,500."]);
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
    expect(checkSums(normalize(deliveryNote))).toEqual({ ok: true, problems: [], notes: [], hasPrices: false, hasCharges: false, crossChecked: true });
  });

  it("catches quantity times price that does not match the line total", () => {
    const c = checkSums(normalize({ items: [{ quantity: 2, description: "Milo 400g", unit_price: 3500, line_total: 6000 }], total: 6000 }));
    expect(c.problems).toEqual(["Line 1: 2 × ₦3,500 is ₦7,000, not ₦6,000."]);
  });

  it("catches a ₦2,000 adding error on a ₦2.4 million invoice, but allows one naira of rounding", () => {
    const big = { supplier: null, items: [{ quantity: 1, description: "Laptops", unit_price: 2363000, line_total: 2363000 }], total: 2365000 };
    expect(checkSums(normalize(big)).ok).toBe(false);
    expect(checkSums(normalize({ ...big, total: 2363001 })).ok).toBe(true);
    expect(checkSums(normalize({ supplier: null, items: [{ quantity: 1.5, description: "Rice", unit_price: 3333, line_total: 5000 }], total: 5000 })).ok).toBe(true);
  });

  it("does not trust an on-device read that found no prices on the paper", () => {
    const noPrices = checkSums(normalize({ items: [{ quantity: 2, description: "Sugar", unit_price: null, line_total: null }], total: null }));
    expect(noPrices.ok && noPrices.crossChecked).toBe(true);
    expect(trustDeviceRead(noPrices)).toBe(false);
    expect(trustDeviceRead(checkSums(normalize(cloudRising)))).toBe(true);
  });

  it("does not trust an on-device read that adds up only with a charge (a reader could invent a discount)", () => {
    const invented = { items: [{ quantity: 1, description: "Sugar", unit_price: 109500, line_total: 109500 }], charges: [{ label: "Discount", amount: -500 }], total: 109000 };
    const c = checkSums(normalize(invented));
    expect(c.ok).toBe(true);
    expect(trustDeviceRead(c)).toBe(false);
  });

  it("notes a gap only a rounded pack price explains, and fails any other gap", () => {
    // ₦250.40 a piece is ₦1,252 for 5: a pack price, so this is a note for the owner.
    const c = checkSums(normalize({ items: [{ quantity: 100, description: "Sachets", unit_price: 250, line_total: 25040 }], total: 25040 }));
    expect(c.ok).toBe(true);
    expect(c.notes).toEqual(["Line 1: 100 × ₦250 is ₦25,000, but the line says ₦25,040 (₦40 more). The unit price looks rounded from a pack price; check the line total against the paper."]);
    // ₦250.499 a piece is no pack price: a ₦499 overcharge fails the check.
    const big = checkSums(normalize({ items: [{ quantity: 1000, description: "Sachets", unit_price: 250, line_total: 250499 }], total: 250499 }));
    expect(big.ok).toBe(false);
    expect(big.notes).toEqual([]);
    expect(big.problems[0]).toBe("Line 1: 1000 × ₦250 is ₦250,000, not ₦250,499.");
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
    expect(inv).toEqual({ supplier: null, items: [{ quantity: 3, description: "HP Laptop 14", unit_price: 595000, line_total: 1785000 }], charges: [], total: 1785000 });
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
    expect(r.paperError).toMatch(/^The lines add up to ₦109,500, but the invoice total says ₦109,000\. Snap read the photo twice and got the same numbers both times\. Check these numbers against the paper/);
    expect(r.paperError).toContain("check it with the supplier before you pay");
    expect(r.invoice.items[0].description).toBe("Ctn. Sugar 1kg");
    expect(r.invoice.supplier).toBe("Alhaji Musa Wholesale");
    expect(r.disputes).toEqual([]);
  });

  it("does not blame the paper when the quick read simply misread the total", () => {
    const misread = { ...quick, total: 108500 };
    const right = { ...quick, total: 109500 };
    const r = reconcile(misread, right);
    expect(r.paperError).toBeUndefined();
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

describe("reconcile edge cases", () => {
  const line = (quantity: number, description: string, unit_price: number | null, line_total: number | null) => ({ quantity, description, unit_price, line_total });
  const quick = { supplier: null, items: [line(2, "Sugar", 30000, 60000), line(3, "Indo", 9500, 28500), line(1, "Peak", 21000, 21000)], total: 109000 };

  it("never lets an empty stronger read replace a read that found lines", () => {
    const r = reconcile(quick, { supplier: null, items: [], total: null });
    expect(r.invoice.items).toHaveLength(3);
  });

  it("keeps the read with fewer problems, and shows the second (stronger) read on a tie", () => {
    const worse = { supplier: null, items: [line(2, "Sugar", 30000, 61000), line(3, "Indo", 9500, 28500), line(1, "Peak", 21000, 21000)], total: 100000 };
    expect(reconcile(quick, worse).invoice.items[0].line_total).toBe(60000);
    const tie = { ...quick, items: quick.items.map((l, i) => (i === 1 ? { ...l, description: "Indomie" } : l)), total: 108000 };
    expect(reconcile(quick, tie).invoice.total).toBe(108000);
  });
});

describe("settleTotal (a third, narrow read of the written total)", () => {
  const line = (quantity: number, description: string, unit_price: number | null, line_total: number | null) => ({ quantity, description, unit_price, line_total });
  const items = [line(2, "Ctn. Sugar 1kg", 30000, 60000), line(3, "Ctn. Indo Chkn 70g", 9500, 28500), line(1, "Ctn Peak Tin 160g", 21000, 21000)];
  const copied = { supplier: null, items, total: 109000 }; // copied the paper faithfully: does not add up
  const fixed = { supplier: "Alhaji Musa Wholesale", items, total: 109500 }; // "corrected" the sum: adds up

  it("recognises a total-only dispute", () => {
    expect(totalOnlyDispute(copied, fixed)).toBe(true);
    expect(totalOnlyDispute(copied, { ...fixed, total: 109000 })).toBe(false);
  });

  it("confirms the paper's error when the written total matches the read that does not add up", () => {
    const r = settleTotal(copied, fixed, 109000);
    expect(r.invoice.total).toBe(109000);
    expect(r.invoice.supplier).toBe("Alhaji Musa Wholesale");
    expect(r.paperError).toMatch(/^The lines add up to ₦109,500, but the invoice total says ₦109,000\. The total was read again on its own and came back as ₦109,000 again\. Check these numbers against the paper/);
    expect(r.disputes).toEqual([]);
  });

  it("trusts the read that adds up when the written total matches it (the quick read misread)", () => {
    const misread = { ...copied, total: 108500 };
    const right = { ...fixed, total: 109500 };
    const r = settleTotal(misread, right, 109500);
    expect(r.invoice.total).toBe(109500);
    expect(r.paperError).toBeUndefined();
    expect(r.disputes).toEqual([]);
  });

  it("leaves the total for the owner to check when the third read agrees with neither", () => {
    const r = settleTotal(copied, fixed, 190000);
    expect(r.paperError).toBeUndefined();
    expect(r.disputes).toEqual([{ line: null, field: "total", shown: 109500, other: 109000 }]);
  });
});

describe("chargesFrom", () => {
  it("keeps labelled, non-zero charges as written", () => {
    expect(chargesFrom('{"charges":[{"label":"VAT 7.5%","amount":"12,000"},{"label":"","amount":-500},{"label":"Delivery","amount":0}]}')).toEqual([
      { label: "VAT 7.5%", amount: 12000 },
      { label: "Charge", amount: -500 },
    ]);
    expect(chargesFrom({ charges: [] })).toEqual([]);
    // A subtotal, total or payment copied into the charges is dropped; a VAT total is still a charge.
    const copied = { charges: [{ label: "SUBTOTAL", amount: 160000 }, { label: "VAT 7.5%", amount: 12000 }, { label: "Grand Total", amount: 172000 }, { label: "Amount Paid", amount: 100000 }, { label: "Balance", amount: 72000 }, { label: "Total VAT", amount: 12000 }, { label: "Delivery", amount: 2000 }] };
    expect(chargesFrom(copied).map((c) => c.label)).toEqual(["VAT 7.5%", "Total VAT", "Delivery"]);
    expect(chargesFrom({})).toEqual([]);
  });

  it("asks for the charges only, without adding anything up", () => {
    expect(CHARGES_PROMPT).toMatch(/Do not add anything up/);
  });
});
