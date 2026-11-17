// Chrome's on-device model runs one prompt at a time here, and readings come first. A reading cancels a product
// match that is still running (every on-device prompt takes an abort signal, see promptOnDevice in src/reader.ts), so
// it starts at once; and no new match starts while a reading waits. A cancelled match just leaves that line for the
// owner to pick.
export type DeviceJob = "read" | "pick";

let tail: Promise<unknown> = Promise.resolve();
let running: { kind: DeviceJob; stop: AbortController } | null = null;
let readsWaiting = 0;

export const deviceReadWaiting = () => readsWaiting > 0;

const rejectOnAbort = (signal: AbortSignal) =>
  new Promise<never>((_, no) => signal.addEventListener("abort", () => no(signal.reason), { once: true }));

/**
 * Runs `job` when the device is free. The job gets a signal that is aborted when a reading needs the device (only
 * for a product match); the queue moves on as soon as that happens, without waiting for the job to wind down.
 */
export function onDevice<T>(job: (signal: AbortSignal) => Promise<T>, kind: DeviceJob = "pick"): Promise<T> {
  if (kind === "read") {
    readsWaiting++;
    if (running?.kind === "pick") running.stop.abort(new DOMException("A reading needs the on-device model.", "AbortError"));
  }
  const run = tail.then(async () => {
    if (kind === "read") readsWaiting--;
    else if (readsWaiting > 0) throw new Error("A reading is waiting for the on-device model.");
    const stop = new AbortController();
    running = { kind, stop };
    try {
      return await Promise.race([job(stop.signal), rejectOnAbort(stop.signal)]);
    } finally {
      running = null;
    }
  });
  tail = run.catch(() => undefined);
  return run;
}
