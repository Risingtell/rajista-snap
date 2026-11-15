import { useEffect, useRef, useState } from "react";
import { preparePhoto, type Photo } from "./image";
import { checkSums, type Invoice, type Line } from "./invoice";
import { CLOUD_MODEL, deviceStatus, downloadDeviceModel, readInvoice, type DeviceStatus, type Reading } from "./reader";

const naira = (n: number | null) => (n === null ? "" : `₦${n.toLocaleString("en-NG")}`);
const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

export function App() {
  const [status, setStatus] = useState<DeviceStatus | null>(null);
  const [download, setDownload] = useState<number | null>(null);
  const [photo, setPhoto] = useState<Photo | null>(null);
  const [step, setStep] = useState<"device" | "cloud" | null>(null);
  const [reading, setReading] = useState<Reading | null>(null);
  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    deviceStatus().then(setStatus);
  }, []);

  async function getModel() {
    setError(null);
    setDownload(0);
    try {
      await downloadDeviceModel(setDownload);
      setStatus(await deviceStatus());
    } catch (e) {
      setError(`The on-device model could not be downloaded: ${(e as Error).message}`);
    } finally {
      setDownload(null);
    }
  }

  async function onFile(file: File | undefined) {
    if (!file) return;
    setError(null);
    setReading(null);
    setInvoice(null);
    try {
      const p = await preparePhoto(file);
      setPhoto(p);
      const r = await readInvoice(p, setStep);
      setReading(r);
      setInvoice(r.invoice);
    } catch (e) {
      setError(`Snap could not read this photo: ${(e as Error).message}`);
    } finally {
      setStep(null);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function cloudInstead() {
    if (!photo) return;
    setError(null);
    try {
      const r = await readInvoice(photo, setStep, { forceCloud: true });
      setReading(r);
      setInvoice(r.invoice);
    } catch (e) {
      setError(`The cloud could not read this photo: ${(e as Error).message}`);
    } finally {
      setStep(null);
    }
  }

  function edit(i: number, patch: Partial<Line>) {
    if (!invoice) return;
    setInvoice({ ...invoice, items: invoice.items.map((l, k) => (k === i ? { ...l, ...patch } : l)) });
  }

  const check = invoice ? checkSums(invoice) : null;

  return (
    <div className="shell">
      <header className="top">
        <div className="brand">
          <span className="mark" aria-hidden>
            R
          </span>
          <div>
            <h1>Rajista Snap</h1>
            <p>Photograph a supplier invoice. Get a clean product list.</p>
          </div>
        </div>
        <DevicePill status={status} download={download} onGet={getModel} />
      </header>

      <section className="card scan">
        <input
          ref={fileRef}
          id="photo"
          type="file"
          accept="image/*"
          capture="environment"
          hidden
          onChange={(e) => onFile(e.target.files?.[0])}
        />
        <button className="primary big" disabled={step !== null} onClick={() => fileRef.current?.click()}>
          {step ? "Reading…" : photo ? "Snap another invoice" : "Snap an invoice"}
        </button>
        {step && (
          <p className="progress" role="status">
            {step === "device" ? "Reading on this device…" : "Reading in the cloud…"}
          </p>
        )}
        {error && <p className="error">{error}</p>}
      </section>

      {photo && (
        <section className="split">
          <figure className="card photo">
            <img src={photo.url} alt="The invoice photo" />
          </figure>

          {reading && invoice && check && (
            <div className="card result">
              <SourceBanner reading={reading} />
              {reading.source === "device" && (
                <button className="link" disabled={step !== null} onClick={cloudInstead}>
                  Names look wrong? Read it again in the cloud
                </button>
              )}
              <table className="lines">
                <thead>
                  <tr>
                    <th>Qty</th>
                    <th>Product</th>
                    <th className="num">Unit price</th>
                    <th className="num">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {invoice.items.map((l, i) => (
                    <tr key={i}>
                      <td>
                        <input
                          aria-label={`Quantity, line ${i + 1}`}
                          inputMode="decimal"
                          value={l.quantity}
                          onChange={(e) => edit(i, { quantity: Number(e.target.value) || 0 })}
                        />
                      </td>
                      <td>
                        <input aria-label={`Product, line ${i + 1}`} value={l.description} onChange={(e) => edit(i, { description: e.target.value })} />
                      </td>
                      <td className="num">
                        <MoneyInput label={`Unit price, line ${i + 1}`} value={l.unit_price} onChange={(v) => edit(i, { unit_price: v })} />
                      </td>
                      <td className="num">
                        <MoneyInput label={`Total, line ${i + 1}`} value={l.line_total} onChange={(v) => edit(i, { line_total: v })} />
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={3}>Invoice total</td>
                    <td className="num">
                      <MoneyInput label="Invoice total" value={invoice.total} onChange={(v) => setInvoice({ ...invoice, total: v })} />
                    </td>
                  </tr>
                </tfoot>
              </table>
              <p className={check.ok ? "sums ok" : "sums bad"}>
                {check.ok ? (check.hasPrices ? "✓ Everything adds up." : "No prices on this paper.") : check.problems.join(" ")}
              </p>
            </div>
          )}
        </section>
      )}

      <footer className="foot">
        Reads on your device with Chrome's built-in model when it can, and in the cloud ({CLOUD_MODEL}) when it must. All AI runs through
        Firebase AI Logic.
      </footer>
    </div>
  );
}

function MoneyInput({ label, value, onChange }: { label: string; value: number | null; onChange: (v: number | null) => void }) {
  const [text, setText] = useState(value === null ? "" : value.toLocaleString("en-NG"));
  useEffect(() => setText(value === null ? "" : value.toLocaleString("en-NG")), [value]);
  return (
    <input
      aria-label={label}
      inputMode="numeric"
      className="money"
      value={text}
      placeholder="–"
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        const n = Number(text.replace(/[₦N,\s]/g, ""));
        onChange(text.trim() && Number.isFinite(n) ? n : null);
      }}
    />
  );
}

function DevicePill({ status, download, onGet }: { status: DeviceStatus | null; download: number | null; onGet: () => void }) {
  if (download !== null) return <span className="pill wait">Downloading on-device model… {Math.round(download * 100)}%</span>;
  switch (status) {
    case null:
      return <span className="pill">Checking this device…</span>;
    case "available":
      return <span className="pill device">On-device model ready</span>;
    case "downloadable":
    case "downloading":
      return (
        <button className="pill action" onClick={onGet}>
          Get the on-device model
        </button>
      );
    default:
      return <span className="pill cloud">This device reads in the cloud</span>;
  }
}

function SourceBanner({ reading }: { reading: Reading }) {
  if (reading.source === "device")
    return (
      <div className="banner device">
        <b>Read on this device</b> in {secs(reading.ms)}. Nothing left this computer. Cost: ₦0.
      </div>
    );
  return (
    <div className="banner cloud">
      <b>Read in the cloud</b> in {secs(reading.ms)}.{" "}
      {reading.device && (
        <>
          The on-device try took {secs(reading.device.ms)}. {reading.whyCloud}
        </>
      )}
      {!reading.device && reading.whyCloud}
      {reading.tokens && (
        <span className="tokens">
          {" "}
          {reading.tokens.prompt.toLocaleString()} tokens in, {reading.tokens.output.toLocaleString()} out.
        </span>
      )}
      {reading.device?.invoice && (
        <details>
          <summary>What the device read</summary>
          <ul>
            {reading.device.invoice.items.map((l, i) => (
              <li key={i}>
                {l.quantity} × {l.description} {naira(l.unit_price)} = {naira(l.line_total)}
              </li>
            ))}
            <li>Total {naira(reading.device.invoice.total)}</li>
          </ul>
        </details>
      )}
    </div>
  );
}
