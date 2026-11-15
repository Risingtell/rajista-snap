import { describe, expect, it } from "vitest";
import { checkSums, normalize } from "./invoice";

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
    expect(checkSums(normalize(cloudRising))).toEqual({ ok: true, problems: [], hasPrices: true });
  });

  it("catches the on-device misread of the Rising Technology receipt", () => {
    const c = checkSums(normalize(deviceRising));
    expect(c.ok).toBe(false);
    expect(c.problems).toEqual(["The lines add up to ₦233,500, but the invoice total says ₦236,500."]);
  });

  it("passes a one-line invoice with only a line total", () => {
    expect(checkSums(normalize(goodwill)).ok).toBe(true);
  });

  it("passes a delivery note with no prices, and says so", () => {
    expect(checkSums(normalize(deliveryNote))).toEqual({ ok: true, problems: [], hasPrices: false });
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
    expect(inv).toEqual({ items: [{ quantity: 3, description: "HP Laptop 14", unit_price: 595000, line_total: 1785000 }], total: 1785000 });
  });

  it("accepts a JSON string", () => {
    expect(normalize('{"items":[{"quantity":1,"description":"Salt","unit_price":400,"line_total":400}],"total":400}').items).toHaveLength(1);
  });

  it("throws when there is no item list", () => {
    expect(() => normalize({ total: 5 })).toThrow();
  });
});
