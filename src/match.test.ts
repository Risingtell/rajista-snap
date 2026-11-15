import { describe, expect, it } from "vitest";
import { aliasKey, matchLine, similarity, words, type Product } from "./match";

const p = (id: string, name: string, aliases: string[] = []): Product => ({ id, name, sellPrice: null, lastCost: null, aliases });
const shop = [
  p("cooker", "Maxi standing gas cooker"),
  p("hp14", "HP Laptop 14 Core i3 8GB 256GB"),
  p("x360", "HP x360 Core i5 8GB 256GB"),
  p("milo", "Milo 400g refill"),
  p("panel", "Optoma 75 inch interactive flat panel"),
];

describe("words", () => {
  it("joins sizes to their numbers and expands shop shorthand", () => {
    expect(words("2 ctn Milo 400 G")).toEqual(["carton", "milo", "400g"]);
  });
});

describe("matchLine", () => {
  it("matches the garbled on-device read of the gas cooker to the shop's product", () => {
    const m = matchLine("Goodwill", "Maxi Stabila Gas cooker Air compressor All gas burners", shop);
    expect(m.best?.product.id).toBe("cooker");
  });

  it("tells the two HP laptops apart by their model words", () => {
    expect(matchLine(null, "HP Laptop 14 ep0083nia Intel Core i3 8gb Ram, 256gb ssd", shop).best?.product.id).toBe("hp14");
    expect(matchLine(null, "HP X360 Intel Core i5 8gb Ram / 256gb SSD", shop).best?.product.id).toBe("x360");
  });

  it("does not guess when nothing is close", () => {
    expect(matchLine(null, "Dangote sugar 1kg", shop).best).toBeNull();
  });

  it("uses what the owner taught it for that supplier, even when the words share nothing", () => {
    const taught = [...shop.slice(0, 3), p("milo", "Milo 400g refill", [aliasKey("Mama Tolu", "2 ctn MLO")])];
    const m = matchLine("Mama Tolu", "2 ctn MLO", taught);
    expect(m.best).toMatchObject({ how: "learned", product: { id: "milo" } });
    // The same shorthand from another supplier is not assumed to mean the same thing.
    expect(matchLine("Someone else", "2 ctn MLO", taught).best).toBeNull();
  });

  it("treats sizes as exact, so 400g never matches 900g", () => {
    expect(similarity("Milo 900g refill", "Milo 400g refill")).toBeLessThan(0.75);
  });
});
