import { describe, expect, it } from "vitest";
import {
  addingSubset,
  allPriced,
  arrange,
  CHARGES_PROMPT,
  chargesFrom,
  checkSums,
  disputes,
  INVOICE_JSON_SCHEMA,
  kindOf,
  labelDoubt,
  looksLikeCharge,
  naira,
  normalize,
  READ_PROMPT,
  sameKind,
  withoutEchoes,
  sameLines,
  trustDeviceRead,
} from "./invoice";

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
    expect(split.notes).toEqual(["Line 1: 12 × ₦1,083 is ₦12,996, but the line says ₦13,000 (₦4 more). A rounded unit price could explain that much, but check the line total against the paper before you pay."]);
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

  it("notes any gap rounding can explain, never failing it, and fails a bigger gap", () => {
    const sums = (quantity: number, unit: number, total: number) =>
      checkSums(normalize({ items: [{ quantity, description: "Sachets", unit_price: unit, line_total: total }], total }));
    // Within half a naira per piece, plus half a naira: a note to check, never "does not add up".
    const c = sums(100, 250, 25040);
    expect(c.ok).toBe(true);
    expect(c.notes).toEqual(["Line 1: 100 × ₦250 is ₦25,000, but the line says ₦25,040 (₦40 more). A rounded unit price could explain that much, but check the line total against the paper before you pay."]);
    expect(sums(100, 333, 33333).notes).toHaveLength(1); // 3 for ₦1,000, with the line total rounded too
    expect(sums(12, 1000, 12006).notes).toHaveLength(1);
    expect(sums(1000, 250, 250499).notes).toEqual([
      "Line 1: 1000 × ₦250 is ₦250,000, but the line says ₦250,499 (₦499 more). A rounded unit price could explain that much, but check the line total against the paper before you pay.",
    ]);
    // Beyond what rounding can explain: the check fails.
    const big = sums(1000, 250, 250600);
    expect(big.ok).toBe(false);
    expect(big.notes).toEqual([]);
    expect(big.problems[0]).toBe("Line 1: 1000 × ₦250 is ₦250,000, not ₦250,600.");
    expect(sums(12, 1000, 12007).ok).toBe(false);
    // A unit price written with kobo was not rounded to the naira: no allowance per piece.
    expect(sums(2000, 250.5, 501000).ok).toBe(true);
    expect(sums(2000, 250.5, 501500).ok).toBe(false);
    // A whole-naira price on 2,000 pieces: a ₦1,000 gap is within rounding, so a note to check before paying.
    expect(sums(2000, 250, 501000).notes[0]).toMatch(/\(₦1,000 more\)\. A rounded unit price could explain that much, but check the line total against the paper before you pay\.$/);
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
    expect(inv).toEqual({ supplier: null, items: [{ quantity: 3, description: "HP Laptop 14", unit_price: 595000, line_total: 1785000 }], charges: [], notCounted: [], total: 1785000 });
  });

  it("accepts a JSON string", () => {
    expect(normalize('{"items":[{"quantity":1,"description":"Salt","unit_price":400,"line_total":400}],"total":400}').items).toHaveLength(1);
  });

  it("throws when there is no item list", () => {
    expect(() => normalize({ total: 5 })).toThrow();
  });
});

describe("disputes", () => {
  const quick = {
    supplier: null,
    items: [
      { quantity: 2, description: "Ctn. Sugar 1kg", unit_price: 30000, line_total: 60000 },
      { quantity: 3, description: "Ctn. Indo", unit_price: 9500, line_total: 28500 },
      { quantity: 1, description: "Ctn Peak Tin 160g", unit_price: 21000, line_total: 21000 },
    ],
    total: 109000,
  };

  it("lists each number two reads disagree on", () => {
    const other = { ...quick, items: [{ ...quick.items[0], line_total: 61000 }, ...quick.items.slice(1)], total: 109500 };
    expect(disputes(quick, other)).toEqual([
      { line: 0, field: "line_total", shown: 60000, other: 61000 },
      { line: null, field: "total", shown: 109000, other: 109500 },
    ]);
  });

  it("reports a different number of lines as a dispute on the line count", () => {
    expect(disputes(quick, { ...quick, items: quick.items.slice(0, 2) })).toEqual([{ line: null, field: "lines", shown: 3, other: 2 }]);
  });

  it("sameLines compares the numbers on each line, not the names or the total", () => {
    expect(sameLines(quick, { ...quick, total: 1, items: quick.items.map((l) => ({ ...l, description: "x" })) })).toBe(true);
    expect(sameLines(quick, { ...quick, items: [{ ...quick.items[0], quantity: 3 }, ...quick.items.slice(1)] })).toBe(false);
  });
});

describe("naira", () => {
  it("writes amounts the way shop owners do", () => {
    expect(naira(109500)).toBe("₦109,500");
    expect(naira(null)).toBe("");
    expect(naira(null, "₦0")).toBe("₦0");
  });
});

describe("extra rows (VAT, delivery, deposits, subtotals, payments)", () => {
  const goods = [{ quantity: 4, description: "Ctn Milo 400g", unit_price: 40000, line_total: 160000 }];
  const vat = { label: "VAT 7.5%", amount: 12000 };

  it("keeps every labelled, non-zero row a reader returned; the arithmetic decides which count", () => {
    expect(chargesFrom('{"charges":[{"label":"VAT 7.5%","amount":"12,000"},{"label":"","amount":-500},{"label":"Delivery","amount":0}]}')).toEqual([
      { label: "VAT 7.5%", amount: 12000 },
      { label: "Other amount", amount: -500 },
    ]);
    expect(chargesFrom({ charges: [] })).toEqual([]);
    expect(chargesFrom({})).toEqual([]);
  });

  it("reads labels only as a hint: payments, balances and sums do not read like charges", () => {
    for (const label of ["SUBTOTAL", "Grand Total", "Amount Paid", "Balance", "Less: Deposit", "Advance paid", "Previous balance", "Bal b/f", "Part payment", "Cash", "Change"])
      expect(looksLikeCharge(label)).toBe(false);
    for (const label of ["VAT", "Total VAT", "Cash discount", "Delivery", "Transport", "Loading fee", "Total charges"]) expect(looksLikeCharge(label)).toBe(true);
  });

  it("finds the rows the total really includes, whatever their labels", () => {
    // A subtotal copied among the charges (seen 16 Nov 2026) is left out because the sum says so.
    expect(addingSubset(160000, 172000, [{ label: "SUBTOTAL", amount: 160000 }, vat])).toEqual([vat]);
    // Transport equal to the goods: still counted, because the total includes it.
    expect(addingSubset(5000, 10000, [{ label: "Transport", amount: 5000 }])).toEqual([{ label: "Transport", amount: 5000 }]);
    // A crate deposit is a charge; a customer's deposit is a payment: the total tells them apart.
    const crate = { label: "Crate deposit", amount: 2000 };
    expect(addingSubset(48000, 50000, [crate, { label: "Amount paid", amount: 30000 }])).toEqual([crate]);
    expect(addingSubset(100000, 100000, [{ label: "Less: Deposit", amount: 50000 }, { label: "Balance", amount: 50000 }])).toEqual([]);
    // A summary row among real ones: the combination that adds up wins.
    const discount = { label: "Discount", amount: -5000 };
    const vat2 = { label: "VAT", amount: 7125 };
    expect(addingSubset(100000, 102125, [discount, { label: "Total excl. VAT", amount: 95000 }, vat2])).toEqual([discount, vat2]);
    // An old balance carried onto the total counts too.
    expect(addingSubset(100000, 120000, [{ label: "Previous balance", amount: 20000 }])).toEqual([{ label: "Previous balance", amount: 20000 }]);
    // Nothing adds up: null.
    expect(addingSubset(109500, 109000, [])).toBeNull();
    // Two equal rows, one of them a summary of the other: only one is counted.
    expect(addingSubset(100000, 107500, [{ label: "VAT", amount: 7500 }, { label: "Total VAT", amount: 7500 }])).toEqual([{ label: "VAT", amount: 7500 }]);
  });

  it("splits one read's rows into the ones its total includes and the rest", () => {
    const inv = { supplier: null, items: goods, total: 172000 };
    const sub = { label: "SUBTOTAL", amount: 160000 };
    expect(arrange(inv, [sub, vat])).toEqual({ ...inv, charges: [vat], notCounted: [sub] });
    // A full read is cleaned the same way, so a copied total cannot make a correct invoice look wrong.
    const read = normalize({ items: goods, charges: [vat, { label: "Total incl. VAT", amount: 172000 }], total: 172000 });
    expect(read.charges).toEqual([vat]);
    expect(checkSums(read).ok).toBe(true);
    // Nothing adds up: the rows that read like charges are shown, the rest kept aside.
    expect(arrange({ ...inv, total: 180000 }, [sub, vat])).toEqual({ ...inv, total: 180000, charges: [vat], notCounted: [sub] });
  });

  it("asks the charges-only read for charges, without adding anything up", () => {
    expect(CHARGES_PROMPT).toMatch(/Do not add anything up/);
  });
});

describe("labels only ever add doubt", () => {
  it("count every row as written or with its sign turned, whatever its label", () => {
    // A discount written without a minus sign, and a crate deposit written with one.
    expect(addingSubset(100000, 97000, [{ label: "Discount", amount: 3000 }])).toEqual([{ label: "Discount", amount: -3000 }]);
    expect(addingSubset(50000, 52000, [{ label: "Crate deposit", amount: -2000 }])).toEqual([{ label: "Crate deposit", amount: 2000 }]);
    // Withholding tax and an unlabelled minus count as written.
    expect(addingSubset(100000, 102500, [{ label: "VAT", amount: 7500 }, { label: "Withholding tax", amount: -5000 }])).toHaveLength(2);
    expect(addingSubset(100000, 99500, [{ label: "Other amount", amount: -500 }])).toEqual([{ label: "Other amount", amount: -500 }]);
  });

  it("know what kind of row a label names, the specific words first", () => {
    const kinds: [string, string | null][] = [
      ["VAT 7.5%", "vat"],
      ["VAT7.5%", "vat"], // written without a space, as handwriting often is
      ["V.A.T", "vat"],
      ["Total VAT", "vat"],
      ["Tax", "vat"],
      ["Vatable amount", null],
      ["Withholding tax 5%", "withholding"],
      ["Transport", "delivery"],
      ["Loading fee", "delivery"],
      ["Late payment fee", "fee"],
      ["Service charge", "fee"],
      ["Credit card charge", "fee"],
      ["7.5%", null],
      ["Others", null],
      ["Freight", "delivery"],
      ["Cash discount", "discount"],
      ["Credit", "discount"],
      ["Less", "discount"],
      ["Less: Deposit", "payment"],
      ["Amount paid", "payment"],
      ["Deposit", "payment"],
      ["Crate deposit", "returnable"],
      ["Previous balance", "brought"],
      ["Bal b/f", "brought"],
      ["Balance", "balance"],
      ["Amount due", "balance"],
      ["Sub-total", "sum"],
      ["SUBTOTAL", "sum"],
      ["Grand Total", "sum"],
      ["Total excl. VAT", "sum"],
      ["Total", "sum"],
      ["Other amount", null],
    ];
    for (const [label, kind] of kinds) expect([label, kindOf(label)]).toEqual([label, kind]);
  });

  it("flag a row counted against its label, for the owner to check", () => {
    // Added, but reads like money taken off.
    for (const label of ["Discount", "Amount paid", "Credit", "Deposit", "Advance", "Refund", "Withholding tax"])
      expect([label, labelDoubt({ label, amount: 5000 })]).toEqual([label, expect.stringMatching(/^is added, but/)]);
    // Taken off, but reads like something added.
    for (const label of ["VAT7.5%", "V.A.T 7.5%", "Tax", "Levy", "Freight", "Delivery", "Service fee", "Previous balance"])
      expect([label, labelDoubt({ label, amount: -5000 })]).toEqual([label, expect.stringMatching(/^is taken off, but/)]);
    // A total or a balance is never an extra amount, whichever way it is counted.
    expect(labelDoubt({ label: "Subtotal", amount: 50000 })).toMatch(/^is counted, but its label reads like a total or a balance/);
    expect(labelDoubt({ label: "Balance", amount: -5000 })).toMatch(/^is counted, but/);
    // Counted the way its label says, or a label that says nothing: no doubt.
    for (const row of [
      { label: "Discount", amount: -3000 },
      { label: "Withholding tax", amount: -5000 },
      { label: "Amount paid", amount: -30000 },
      { label: "Late payment fee", amount: 2000 },
      { label: "Crate deposit", amount: 2000 },
      { label: "Crate deposit", amount: -2000 },
      { label: "Previous balance", amount: 20000 },
      { label: "Other amount", amount: -500 },
    ])
      expect([row.label, labelDoubt(row)]).toEqual([row.label, null]);
  });

  it("never take rows of different kinds for the same row", () => {
    expect(sameKind("V.A.T 7.5%", "VAT")).toBe(true);
    expect(sameKind("Transport", "Delivery")).toBe(true);
    expect(sameKind("Less", "Discount")).toBe(true);
    expect(sameKind("Other amount", "Discount")).toBe(true);
    expect(sameKind("Discount", "Delivery")).toBe(false);
    expect(sameKind("Discount", "Paid")).toBe(false);
    expect(sameKind("VAT", "Delivery")).toBe(false);
    expect(sameKind("Crate deposit", "Deposit")).toBe(false);
  });

  it("drop only the rows that repeat the total", () => {
    const keep = (rows: { label: string; amount: number }[], total: number) => withoutEchoes(rows, total).map((r) => r.label);
    expect(keep([{ label: "Total", amount: 109000 }, { label: "Balance", amount: 109000 }, { label: "Amount paid", amount: 109000 }], 109000)).toEqual([]);
    // Payments that together make the total: a deposit and the balance, or cash less change.
    expect(keep([{ label: "Deposit", amount: 50000 }, { label: "Balance", amount: 59000 }], 109000)).toEqual([]);
    expect(keep([{ label: "Cash", amount: 120000 }, { label: "Change", amount: 11000 }], 109000)).toEqual([]);
    // A subtotal equal to the lines is kept: it shows the total adds something to them.
    expect(keep([{ label: "Sub-total", amount: 109500 }], 109000)).toEqual(["Sub-total"]);
    // A part payment, a charge equal to the total, or rows that do not make the total are kept.
    expect(keep([{ label: "Amount paid", amount: 50000 }], 109000)).toEqual(["Amount paid"]);
    expect(keep([{ label: "VAT", amount: 109000 }], 109000)).toEqual(["VAT"]);
    expect(keep([{ label: "Deposit", amount: 50000 }, { label: "Balance", amount: 50000 }], 109000)).toEqual(["Deposit", "Balance"]);
  });

  it("search many rows quickly, even when no way of counting them works", () => {
    const many = Array.from({ length: 14 }, (_, i) => ({ label: `Row ${i + 1}`, amount: 1000 * (i + 1) }));
    const start = performance.now();
    for (let k = 0; k < 10; k++) expect(addingSubset(109500, 109000, many)).toBeNull();
    expect((performance.now() - start) / 10).toBeLessThan(20);
  });
});

describe("a quantity nobody wrote", () => {
  it("may be returned as null by both readers, who are told to", () => {
    expect(INVOICE_JSON_SCHEMA.properties.items.items.properties.quantity.type).toEqual(["number", "null"]);
    expect(READ_PROMPT).toMatch(/quantity \(null if no quantity is written\)/);
  });

  it("is taken from the line when that gives whole pieces, noted, and never checked as an error", () => {
    const inferred = normalize({ items: [{ quantity: null, description: "Rice 50kg", unit_price: 25000, line_total: 75000 }], total: 75000 });
    expect(inferred.items[0]).toMatchObject({ quantity: 3, guessed: true });
    const odd = normalize({ items: [{ description: "Rice 50kg", unit_price: 25000, line_total: 70000 }], total: 70000 });
    expect(odd.items[0]).toMatchObject({ quantity: 1, guessed: true });
    const c = checkSums(odd);
    expect(c.ok).toBe(true);
    expect(c.notes).toEqual(["Line 1: no quantity was written, so Snap took it as 1; check it."]);
    expect(trustDeviceRead(c)).toBe(false);
  });

  it("leaves the total unchecked when the line has only a unit price, so a guess of one piece is never summed", () => {
    // "Rice @ 25,000" with no quantity and no line total, and "3 x 1,000 = 3,000": the paper's ₦53,000 may be right.
    const rice = normalize({
      items: [
        { quantity: null, description: "Rice", unit_price: 25000, line_total: null },
        { quantity: 3, description: "Salt", unit_price: 1000, line_total: 3000 },
      ],
      total: 53000,
    });
    expect(rice.items[0]).toMatchObject({ quantity: 1, guessed: true });
    expect(allPriced(rice)).toBe(false);
    const c = checkSums(rice);
    expect(c.ok).toBe(true);
    expect(c.crossChecked).toBe(false);
    expect(c.problems).toEqual([]);
    // Once the owner types the quantity in, the total is checked.
    const typed = { ...rice, items: [{ ...rice.items[0], quantity: 2, guessed: undefined }, rice.items[1]] };
    expect(allPriced(typed)).toBe(true);
    expect(checkSums(typed)).toMatchObject({ ok: true, crossChecked: true });
  });
});
