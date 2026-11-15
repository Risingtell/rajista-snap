import { describe, expect, it } from "vitest";
import { cloudCost } from "./settings";

describe("cloudCost", () => {
  it("prices the Rising Technology receipt read at Google's paid rates", () => {
    // 1,194 tokens in (prompt + photo), 182 out, measured on 15 Nov 2026.
    const c = cloudCost({ prompt: 1194, output: 182 }, { cloud_price_in_usd_per_m: 0.3, cloud_price_out_usd_per_m: 2.5, ngn_per_usd: 1500 });
    expect(c.usd).toBeCloseTo(0.0008132, 7);
    expect(c.ngn).toBeCloseTo(1.22, 2);
  });
});
