import { describe, expect, it } from "vitest";
import { deviceReadWaiting, onDevice } from "./devicequeue";

const later = <T,>(ms: number, v: T) => new Promise<T>((ok) => setTimeout(() => ok(v), ms));

describe("onDevice", () => {
  it("runs one job at a time, in order", async () => {
    const order: string[] = [];
    await Promise.all([
      onDevice(async () => (order.push("a start"), await later(30, 0), order.push("a end"))),
      onDevice(async () => (order.push("b start"), await later(5, 0), order.push("b end"))),
    ]);
    expect(order).toEqual(["a start", "a end", "b start", "b end"]);
  });

  it("lets a reading run after a short job, and says a reading is waiting meanwhile", async () => {
    const pick = onDevice(() => later(20, "pick"));
    const read = onDevice(() => later(5, "read"), true, 500);
    expect(deviceReadWaiting()).toBe(true);
    expect(await pick).toBe("pick");
    expect(await read).toBe("read");
    expect(deviceReadWaiting()).toBe(false);
  });

  it("gives up on the device when a stuck job blocks it, and never runs the reading's job later", async () => {
    let ran = false;
    const stuck = onDevice(() => later(120, "slow pick"));
    const read = onDevice(async () => ((ran = true), "read"), true, 30);
    await expect(read).rejects.toThrow("device busy");
    expect(deviceReadWaiting()).toBe(false);
    await stuck;
    await later(10, 0);
    expect(ran).toBe(false);
  });
});
