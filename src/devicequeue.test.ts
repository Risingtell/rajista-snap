import { describe, expect, it } from "vitest";
import { deviceReadWaiting, onDevice } from "./devicequeue";

const later = <T,>(ms: number, v: T) => new Promise<T>((ok) => setTimeout(() => ok(v), ms));
/** A job that runs until it is cancelled, like a stuck on-device prompt. */
const untilCancelled = (log: string[]) => (signal: AbortSignal) =>
  new Promise<string>((_, no) => signal.addEventListener("abort", () => (log.push("pick cancelled"), no(signal.reason)), { once: true }));

describe("onDevice", () => {
  it("runs one job at a time, in order", async () => {
    const order: string[] = [];
    await Promise.all([
      onDevice(async () => (order.push("a start"), await later(30, 0), order.push("a end"))),
      onDevice(async () => (order.push("b start"), await later(5, 0), order.push("b end"))),
    ]);
    expect(order).toEqual(["a start", "a end", "b start", "b end"]);
  });

  it("lets a reading cancel a running product match and start at once", async () => {
    const log: string[] = [];
    const pick = onDevice(untilCancelled(log));
    await later(5, 0);
    const t = Date.now();
    const read = onDevice(async () => (log.push("read"), "read"), "read");
    await expect(pick).rejects.toThrow("A reading needs the on-device model.");
    expect(await read).toBe("read");
    expect(Date.now() - t).toBeLessThan(100);
    expect(log).toEqual(["pick cancelled", "read"]);
  });

  it("never cancels a reading, and refuses a product match queued while another reading waits", async () => {
    const order: string[] = [];
    const read = onDevice(async () => (await later(30, 0), order.push("read"), "read"), "read");
    const pick = onDevice(async () => (order.push("pick"), "pick"));
    expect(await read).toBe("read");
    expect(await pick).toBe("pick"); // queued behind a reading: it simply runs after it
    expect(order).toEqual(["read", "pick"]);

    const first = onDevice(() => later(20, "first read"), "read");
    const queuedPick = onDevice(async () => "pick");
    const second = onDevice(() => later(5, "second read"), "read");
    expect(deviceReadWaiting()).toBe(true);
    expect(await first).toBe("first read");
    await expect(queuedPick).rejects.toThrow("A reading is waiting");
    expect(await second).toBe("second read");
    expect(deviceReadWaiting()).toBe(false);
  });

  it("keeps going after a job fails", async () => {
    await expect(onDevice(async () => Promise.reject(new Error("no model")))).rejects.toThrow("no model");
    expect(await onDevice(async () => "next")).toBe("next");
  });
});
