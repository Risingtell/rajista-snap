// Chrome's on-device model runs one prompt at a time here, and readings come first. A reading cancels a product
// match that is still running (every on-device prompt takes an abort signal, see promptOnDevice in src/reader.ts),
// and no new match starts while a reading waits. A cancelled match just leaves that line for the owner to pick.
//
// Chrome normally stops a cancelled prompt at once. If it is slow to, the next job waits for it, but not for long: a
// reading that cannot get the device within RELEASE_MS reads in the cloud instead ("device busy").
export type DeviceJob = "read" | "pick";
export const RELEASE_MS = 3_000;

let tail: Promise<unknown> = Promise.resolve();
let running: { kind: DeviceJob; stop: AbortController } | null = null;
let releasing: Promise<void> | null = null; // a cancelled prompt Chrome has not let go of yet
let readsWaiting = 0;

export const deviceReadWaiting = () => readsWaiting > 0;

const rejectOnAbort = (signal: AbortSignal) =>
  new Promise<never>((_, no) => signal.addEventListener("abort", () => no(signal.reason), { once: true }));
const after = (ms: number) => new Promise<false>((ok) => setTimeout(() => ok(false), ms));

/**
 * Runs `job` when the device is free. The job gets a signal that is aborted when a reading needs the device (only for
 * a product match); the queue moves on as soon as that happens, and the next job waits briefly for Chrome to let go.
 */
export function onDevice<T>(job: (signal: AbortSignal) => Promise<T>, kind: DeviceJob = "pick", releaseMs = RELEASE_MS): Promise<T> {
  if (kind === "read") {
    readsWaiting++;
    if (running?.kind === "pick") running.stop.abort(new DOMException("A reading needs the on-device model.", "AbortError"));
  }
  const run = tail.then(async () => {
    if (kind === "read") readsWaiting--;
    else if (readsWaiting > 0) throw new Error("A reading is waiting for the on-device model.");
    if (releasing && !(await Promise.race([releasing.then(() => true as const), after(releaseMs)]))) throw new Error("device busy");
    // A reading may have arrived while this match waited for Chrome: readings come first.
    if (kind === "pick" && readsWaiting > 0) throw new Error("A reading is waiting for the on-device model.");
    const stop = new AbortController();
    const work = job(stop.signal);
    running = { kind, stop };
    try {
      return await Promise.race([work, rejectOnAbort(stop.signal)]);
    } finally {
      running = null;
      if (stop.signal.aborted) {
        const gone: Promise<void> = work.then(
          () => undefined,
          () => undefined,
        );
        releasing = gone;
        void gone.then(() => {
          if (releasing === gone) releasing = null;
        });
      }
    }
  });
  tail = run.catch(() => undefined);
  return run;
}
