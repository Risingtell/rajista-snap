// Values that can change without a new release, from Firebase Remote Config. The defaults below are used
// until Remote Config answers, when it has no template, and when the device is offline.
//
//   cloud_price_in_usd_per_m   Google's paid price per million input tokens for the cloud model (images included)
//   cloud_price_out_usd_per_m  Google's paid price per million output tokens (thinking included)
//   strong_price_in_usd_per_m  the same for the stronger model used when the first cloud read does not add up
//   strong_price_out_usd_per_m
//   ngn_per_usd                naira per US dollar, to show the cost in naira
//
// Prices from ai.google.dev/gemini-api/docs/pricing, read 15 Nov 2026: gemini-3.5-flash-lite $0.30 / $2.50,
// gemini-3.8-flash $0.75 / $3.75 (through 31 December 2026).
import { getApp } from "firebase/app";
import { fetchAndActivate, getRemoteConfig, getValue } from "firebase/remote-config";

const DEFAULTS = {
  cloud_price_in_usd_per_m: 0.3,
  cloud_price_out_usd_per_m: 2.5,
  strong_price_in_usd_per_m: 0.75,
  strong_price_out_usd_per_m: 3.75,
  ngn_per_usd: 1352, // open.er-api.com, 15 Nov 2026
};
export type Settings = typeof DEFAULTS;

let current: Settings = { ...DEFAULTS };
export const settings = () => current;

/** Fetches Remote Config once per hour at most; never throws (the defaults stay in place). */
export async function loadSettings(): Promise<Settings> {
  try {
    const rc = getRemoteConfig(getApp());
    rc.settings.minimumFetchIntervalMillis = 60 * 60 * 1000;
    rc.defaultConfig = DEFAULTS;
    await fetchAndActivate(rc);
    current = {
      cloud_price_in_usd_per_m: getValue(rc, "cloud_price_in_usd_per_m").asNumber() || DEFAULTS.cloud_price_in_usd_per_m,
      cloud_price_out_usd_per_m: getValue(rc, "cloud_price_out_usd_per_m").asNumber() || DEFAULTS.cloud_price_out_usd_per_m,
      strong_price_in_usd_per_m: getValue(rc, "strong_price_in_usd_per_m").asNumber() || DEFAULTS.strong_price_in_usd_per_m,
      strong_price_out_usd_per_m: getValue(rc, "strong_price_out_usd_per_m").asNumber() || DEFAULTS.strong_price_out_usd_per_m,
      ngn_per_usd: getValue(rc, "ngn_per_usd").asNumber() || DEFAULTS.ngn_per_usd,
    };
  } catch {
    /* offline or no template: keep the defaults */
  }
  return current;
}

/** What a read's cloud calls would cost at Google's paid rates, each at its own model's price. */
export function cloudCost(calls: { model?: string; prompt: number; output: number }[], s: Settings = current) {
  const usd = calls.reduce((sum, c) => {
    const strong = c.model !== undefined && c.model !== "gemini-3.5-flash-lite";
    const pin = strong ? s.strong_price_in_usd_per_m : s.cloud_price_in_usd_per_m;
    const pout = strong ? s.strong_price_out_usd_per_m : s.cloud_price_out_usd_per_m;
    return sum + (c.prompt * pin + c.output * pout) / 1e6;
  }, 0);
  return { usd, ngn: usd * s.ngn_per_usd };
}
