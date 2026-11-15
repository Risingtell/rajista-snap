import { describe, expect, it } from "vitest";
import { rajistaCsv, rows, whatsappText } from "./export";
import type { Product } from "./match";

const inv = {
  supplier: "Goodwill Electro-Solar Ventures",
  items: [
    { quantity: 3, description: "HP Laptop 14 ep0083nia Intel Core i3", unit_price: 595000, line_total: 1785000 },
    { quantity: 1, description: "Maxi standing gas cooker, all gas burners", unit_price: null, line_total: 140000 },
  ],
  total: 1925000,
};
const hp: Product = { id: "hp", name: "HP Laptop 14 Core i3 8GB 256GB", sellPrice: 650000, lastCost: null, aliases: [] };

describe("rows", () => {
  it("uses the shop's own product name and price, and works out a unit cost from a line total", () => {
    expect(rows(inv, [hp, null])).toEqual([
      { name: "HP Laptop 14 Core i3 8GB 256GB", quantity: 3, cost: 595000, price: 650000 },
      { name: "Maxi standing gas cooker, all gas burners", quantity: 1, cost: 140000, price: null },
    ]);
  });
});

describe("rajistaCsv", () => {
  it("writes the headings Rajista recognises, quotes commas, and leaves out lines with no selling price", () => {
    const withPrice = rows(inv, [hp, { ...hp, id: "c", name: "Maxi cooker, 4 burners", sellPrice: 165000 }]);
    expect(rajistaCsv(withPrice)).toEqual({
      csv: 'Name,Price,Cost price,Qty\r\nHP Laptop 14 Core i3 8GB 256GB,650000,595000,3\r\n"Maxi cooker, 4 burners",165000,140000,1\r\n',
      skipped: 0,
    });
    expect(rajistaCsv(rows(inv, [hp, null])).skipped).toBe(1);
  });
});

describe("whatsappText", () => {
  it("lists the stock and keeps cost prices out unless asked", () => {
    const t = whatsappText(inv.supplier, rows(inv, [hp, null]), false);
    expect(t).toBe(
      "New stock from Goodwill Electro-Solar Ventures:\n• 3 × HP Laptop 14 Core i3 8GB 256GB, sell ₦650,000\n• 1 × Maxi standing gas cooker, all gas burners\n\nSent from Rajista Snap",
    );
    expect(whatsappText(null, rows(inv, [hp, null]), true)).toContain("cost ₦595,000");
  });
});
