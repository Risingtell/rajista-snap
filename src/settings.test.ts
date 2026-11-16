import { describe, expect, it } from "vitest";
import { cloudCost } from "./settings";

describe("cloudCost", () => {
  it("prices the Rising Technology receipt read at Google's paid rates", () => {
    // 1,194 tokens in (prompt + photo), 182 out, measured on 15 Nov 2026.
    const rates = { cloud_price_in_usd_per_m: 0.3, cloud_price_out_usd_per_m: 2.5, strong_price_in_usd_per_m: 0.75, strong_price_out_usd_per_m: 3.75, ngn_per_usd: 1500 };
    const c = cloudCost([{ model: "gemini-3.5-flash-lite", prompt: 1194, output: 182 }], rates);
    expect(c.usd).toBeCloseTo(0.0008132, 7);
    expect(c.ngn).toBeCloseTo(1.22, 2);
    // A step-up adds the stronger model's call at its own price.
    const both = cloudCost([{ model: "gemini-3.5-flash-lite", prompt: 1194, output: 182 }, { model: "gemini-3.8-flash", prompt: 1194, output: 300 }], rates);
    expect(both.usd).toBeCloseTo(0.0008132 + 0.0008955 + 0.001125, 7);
  });
});
