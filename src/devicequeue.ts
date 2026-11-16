// The on-device model runs one prompt at a time: a reading waits for a product-matching prompt still running (those
// cannot be cancelled), and while a reading is waiting, no new matching prompts start. A reading never waits long:
// if the device is still busy after the wait limit, it gives up (its job never runs) and the cloud reads the photo.
export const DEVICE_WAIT_MS = 8_000;

let deviceQueue: Promise<unknown> = Promise.resolve();
let readingWaiting = 0;
export const deviceReadWaiting = () => readingWaiting > 0;

export function onDevice<T>(job: () => Promise<T>, isReading = false, waitMs = DEVICE_WAIT_MS): Promise<T> {
  if (!isReading) {
    const run = deviceQueue.then(job, job);
    deviceQueue = run.catch(() => undefined);
    return run;
  }
  // A reading: counted as waiting until it starts, and it gives up (so its job never runs) if it cannot start soon.
  readingWaiting++;
  let state: "waiting" | "started" | "gave up" = "waiting";
  const start = () => {
    if (state === "gave up") throw new Error("device busy");
    state = "started";
    readingWaiting--;
    return job();
  };
  const run = deviceQueue.then(start, start);
  deviceQueue = run.catch(() => undefined);
  return Promise.race([
    run,
    new Promise<never>((_, no) =>
      setTimeout(() => {
        if (state === "waiting") {
          state = "gave up";
          readingWaiting--;
          no(new Error("device busy"));
        }
      }, waitMs),
    ),
  ]);
}
