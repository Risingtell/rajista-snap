import { useEffect, useMemo, useRef, useState } from "react";
import { rajistaCsv, rows, whatsappText } from "./export";
import { preparePhoto, type Photo } from "./image";
import { checkSums, type Invoice, type Line } from "./invoice";
import { pickOnDevice } from "./devicematch";
import { aliasKey, matchLine, type Product } from "./match";
import { CLOUD_MODEL, deviceStatus, downloadDeviceModel, readInvoice, type DeviceStatus, type Reading } from "./reader";
import { cloudCost, loadSettings } from "./settings";
import { deleteProduct, listProducts, newId, saveProducts } from "./store";

const naira = (n: number | null) => (n === null ? "" : `₦${n.toLocaleString("en-NG")}`);
const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
/** What the owner picked for a line: a product id, "new" for a new product, or undefined to accept Snap's match. */
type Choice = string | "new" | undefined;

export function App() {
  const [status, setStatus] = useState<DeviceStatus | null>(null);
  const [download, setDownload] = useState<number | null>(null);
  const [photo, setPhoto] = useState<Photo | null>(null);
  const [step, setStep] = useState<"device" | "cloud" | null>(null);
  const [reading, setReading] = useState<Reading | null>(null);
  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [choices, setChoices] = useState<Choice[]>([]);
  const [prices, setPrices] = useState<(number | null)[]>([]);
  const [saved, setSaved] = useState<string | null>(null);
  // Lines the on-device model matched to a product (id), or "none" when it found no match.
  const [devicePicks, setDevicePicks] = useState<(string | undefined)[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    deviceStatus().then(setStatus);
    listProducts().then(setProducts);
    loadSettings();
  }, []);

  function show(r: Reading) {
    setReading(r);
    setInvoice(r.invoice);
    setChoices([]);
    setPrices([]);
    setSaved(null);
    setDevicePicks([]);
  }

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
      show(await readInvoice(p, setStep));
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
      show(await readInvoice(photo, setStep, { forceCloud: true }));
    } catch (e) {
      setError(`The cloud could not read this photo: ${(e as Error).message}`);
    } finally {
      setStep(null);
    }
  }

  function edit(i: number, patch: Partial<Line>) {
    if (!invoice) return;
    setInvoice({ ...invoice, items: invoice.items.map((l, k) => (k === i ? { ...l, ...patch } : l)) });
    setSaved(null);
  }

  // Snap's suggestion for each line, from the private product list (src/match.ts).
  const matches = useMemo(
    () => (invoice ? invoice.items.map((l) => matchLine(invoice.supplier, l.description, products)) : []),
    [invoice, products],
  );
  // Lines the name matching was unsure about go to the on-device model, one at a time, privately.
  useEffect(() => {
    if (status !== "available" || !invoice || !products.length) return;
    let stop = false;
    (async () => {
      for (let i = 0; i < matches.length && !stop; i++) {
        if (matches[i].best || devicePicks[i] !== undefined) continue;
        const pool = matches[i].others.length ? matches[i].others : products.length <= 15 ? products : [];
        if (!pool.length) continue;
        let pick: string = "none";
        try {
          pick = (await pickOnDevice(invoice.supplier, invoice.items[i].description, pool))?.id ?? "none";
        } catch {
          /* no on-device answer: the owner picks */
        }
        if (!stop) setDevicePicks((d) => Object.assign([...d], { [i]: pick }));
      }
    })();
    return () => {
      stop = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matches, status]);

  const resolved: (Product | null)[] = matches.map((m, i) => {
    const c = choices[i];
    if (c === "new") return null;
    if (c) return products.find((p) => p.id === c) ?? null;
    if (m.best) return m.best.product;
    const d = devicePicks[i];
    return d && d !== "none" ? products.find((p) => p.id === d) ?? null : null;
  });
  const withPrices = resolved.map((p, i) => (p ? { ...p, sellPrice: prices[i] ?? p.sellPrice } : null));

  /** Saves every line to the product list: new products, latest cost prices, selling prices, and what each supplier calls them. */
  async function saveAll() {
    if (!invoice) return;
    const byId = new Map(products.map((p) => [p.id, { ...p, aliases: [...p.aliases] }]));
    let added = 0, learned = 0;
    invoice.items.forEach((l, i) => {
      const cost = l.unit_price ?? (l.line_total !== null && l.quantity > 0 ? Math.round(l.line_total / l.quantity) : null);
      const picked = resolved[i];
      if (!picked) {
        const id = newId();
        byId.set(id, { id, name: l.description, sellPrice: prices[i] ?? null, lastCost: cost, aliases: invoice.supplier ? [aliasKey(invoice.supplier, l.description)] : [] });
        added++;
        return;
      }
      const p = byId.get(picked.id)!;
      if (cost !== null) p.lastCost = cost;
      if (prices[i] != null) p.sellPrice = prices[i]!;
      const key = aliasKey(invoice.supplier, l.description);
      if (!p.aliases.includes(key)) {
        p.aliases.push(key);
        learned++;
      }
    });
    const next = [...byId.values()];
    await saveProducts(next);
    setProducts(await listProducts());
    setChoices([]);
    setPrices([]);
    setSaved(`Saved on this device: ${added} new product${added === 1 ? "" : "s"}, ${learned} new supplier name${learned === 1 ? "" : "s"} learned.`);
  }

  function downloadCsv() {
    if (!invoice) return;
    const { csv, skipped } = rajistaCsv(rows(invoice, withPrices));
    if (skipped === invoice.items.length) {
      setError("Add your selling price to at least one line first: Rajista needs a price for every product.");
      return;
    }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    a.download = `rajista-import-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
    setError(skipped ? `${skipped} line${skipped === 1 ? " has" : "s have"} no selling price yet, so ${skipped === 1 ? "it was" : "they were"} left out of the file.` : null);
  }

  function shareWhatsApp() {
    if (!invoice) return;
    window.open(`https://wa.me/?text=${encodeURIComponent(whatsappText(invoice.supplier, rows(invoice, withPrices), false))}`, "_blank", "noopener");
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
        <input ref={fileRef} id="photo" type="file" accept="image/*" capture="environment" hidden onChange={(e) => onFile(e.target.files?.[0])} />
        <button className="primary big" disabled={step !== null} onClick={() => fileRef.current?.click()}>
          {step ? "Reading…" : photo ? "Snap another invoice" : "Snap an invoice"}
        </button>
        <div className="samples">
          <span>No invoice to hand? Try one from Alhaji Musa Wholesale, three visits in November:</span>
          {[
            ["1", "3 Nov"],
            ["2", "9 Nov"],
            ["3", "15 Nov"],
          ].map(([n, day]) => (
            <button
              key={n}
              className="chip"
              disabled={step !== null}
              onClick={async () => {
                const r = await fetch(`/samples/alhaji-musa-${n}.jpg`);
                onFile(new File([await r.blob()], `alhaji-musa-${n}.jpg`, { type: "image/jpeg" }));
              }}
            >
              Invoice {n} · {day}
            </button>
          ))}
        </div>
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
              {reading.paperError && (
                <div className="paper-error" role="alert">
                  <b>This invoice does not add up.</b> {reading.paperError}
                </div>
              )}
              {reading.source === "device" && (
                <button className="link" disabled={step !== null} onClick={cloudInstead}>
                  Names look wrong? Read it again in the cloud
                </button>
              )}
              <label className="supplier">
                Supplier
                <input id="supplier" value={invoice.supplier ?? ""} placeholder="Not on the paper" onChange={(e) => setInvoice({ ...invoice, supplier: e.target.value || null })} />
              </label>
              <table className="lines">
                <thead>
                  <tr>
                    <th>Qty</th>
                    <th>Product</th>
                    <th className="num">Unit cost</th>
                    <th className="num">Total</th>
                    <th className="num">Your price</th>
                  </tr>
                </thead>
                <tbody>
                  {invoice.items.map((l, i) => (
                    <tr key={i}>
                      <td data-label="Qty">
                        <input aria-label={`Quantity, line ${i + 1}`} inputMode="decimal" value={l.quantity} onChange={(e) => edit(i, { quantity: Number(e.target.value) || 0 })} />
                      </td>
                      <td data-label="Product" className="product">
                        <input aria-label={`Product, line ${i + 1}`} value={l.description} onChange={(e) => edit(i, { description: e.target.value })} />
                        <MatchPicker
                          line={i}
                          suggestion={matches[i]}
                          devicePick={devicePicks[i] && devicePicks[i] !== "none" ? products.find((p) => p.id === devicePicks[i]) : undefined}
                          choice={choices[i]}
                          products={products}
                          onPick={(c) => setChoices((cs) => Object.assign([...cs], { [i]: c }))}
                        />
                      </td>
                      <td className="num" data-label="Unit cost">
                        <MoneyInput label={`Unit cost, line ${i + 1}`} value={l.unit_price} onChange={(v) => edit(i, { unit_price: v })} />
                      </td>
                      <td className="num" data-label="Total">
                        <MoneyInput label={`Total, line ${i + 1}`} value={l.line_total} onChange={(v) => edit(i, { line_total: v })} />
                      </td>
                      <td className="num" data-label="Your price">
                        <MoneyInput
                          label={`Your selling price, line ${i + 1}`}
                          value={prices[i] ?? resolved[i]?.sellPrice ?? null}
                          onChange={(v) => setPrices((ps) => Object.assign([...ps], { [i]: v }))}
                        />
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
                    <td />
                  </tr>
                </tfoot>
              </table>
              <p className={check.ok ? "sums ok" : "sums bad"}>
                {check.ok ? (check.hasPrices ? "✓ Everything adds up." : "No prices on this paper.") : check.problems.join(" ")}
              </p>
              <div className="actions">
                <button className="primary" onClick={saveAll}>
                  Save to my products
                </button>
                <button className="ghost" onClick={downloadCsv}>
                  Download for Rajista
                </button>
                <button className="ghost" onClick={shareWhatsApp}>
                  Share on WhatsApp
                </button>
              </div>
              {saved && <p className="saved">{saved}</p>}
              <p className="private">Your product list, selling prices and supplier names stay in this browser. They are never uploaded.</p>
            </div>
          )}
        </section>
      )}

      <ProductList products={products} onChange={async () => setProducts(await listProducts())} />

      <footer className="foot">
        Reads on your device with Chrome's built-in model when it can, and in the cloud ({CLOUD_MODEL}) when it must. All AI runs through Firebase AI Logic.
      </footer>
    </div>
  );
}

function MatchPicker({
  line,
  suggestion,
  devicePick,
  choice,
  products,
  onPick,
}: {
  line: number;
  suggestion: ReturnType<typeof matchLine>;
  devicePick?: Product;
  choice: Choice;
  products: Product[];
  onPick: (c: Choice) => void;
}) {
  if (!products.length) return <span className="match none">New product</span>;
  const auto = suggestion.best ?? (devicePick ? { product: devicePick, score: 1, how: "device" as const } : null);
  const value = choice ?? (auto ? auto.product.id : "new");
  const options = [...(auto ? [auto.product] : []), ...suggestion.others.filter((p) => p !== auto?.product)];
  const rest = products.filter((p) => !options.includes(p));
  const label =
    choice === undefined && auto ? (auto.how === "learned" ? "Known from this supplier" : auto.how === "device" ? "Matched on this device" : "Looks like") : choice === "new" || (!choice && !auto) ? "New product" : "Your choice";
  return (
    <label className={`match ${value === "new" ? "none" : auto && choice === undefined ? auto.how : "picked"}`}>
      <span>{label}</span>
      <select id={`match-${line}`} value={value} onChange={(e) => onPick(e.target.value)}>
        <option value="new">New product</option>
        {options.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
        {rest.length > 0 && (
          <optgroup label="All my products">
            {rest.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </optgroup>
        )}
      </select>
    </label>
  );
}

function ProductList({ products, onChange }: { products: Product[]; onChange: () => void }) {
  if (!products.length) return null;
  return (
    <details className="card products">
      <summary>
        My products <span className="count">{products.length}</span>
      </summary>
      <table className="lines">
        <thead>
          <tr>
            <th>Product</th>
            <th className="num">Last cost</th>
            <th className="num">Your price</th>
            <th className="num">Names learned</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {products.map((p) => (
            <tr key={p.id}>
              <td>{p.name}</td>
              <td className="num">{naira(p.lastCost)}</td>
              <td className="num">
                <MoneyInput
                  label={`Your price for ${p.name}`}
                  value={p.sellPrice}
                  onChange={async (v) => {
                    await saveProducts([{ ...p, sellPrice: v }]);
                    onChange();
                  }}
                />
              </td>
              <td className="num">{p.aliases.length}</td>
              <td className="num">
                <button
                  className="link"
                  onClick={async () => {
                    await deleteProduct(p.id);
                    onChange();
                  }}
                >
                  Remove
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
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
        const v = text.trim() && Number.isFinite(n) ? n : null;
        if (v !== value) onChange(v);
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
        <b>Read on this device</b> in {secs(reading.ms)}. The photo never left this computer, and the prices were confirmed by the invoice total.
        <span className="tokens"> Cost: ₦0.</span>
      </div>
    );
  return (
    <div className="banner cloud">
      <b>Read in the cloud</b> in {secs(reading.ms)}.{" "}
      {reading.device && <>The on-device try took {secs(reading.device.ms)}. </>}
      {reading.whyCloud}
      {reading.stepUp && <> {reading.stepUp}</>}
      {reading.calls.length > 0 && <CostNote calls={reading.calls} />}
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

function CostNote({ calls }: { calls: Reading["calls"] }) {
  const c = cloudCost(calls);
  const tin = calls.reduce((n, x) => n + x.prompt, 0), tout = calls.reduce((n, x) => n + x.output, 0);
  return (
    <span className="tokens">
      {" "}
      {calls.length > 1 ? `${calls.length} cloud reads, ` : ""}
      {tin.toLocaleString()} tokens in, {tout.toLocaleString()} out: about ${c.usd.toFixed(4)} (₦{c.ngn.toFixed(2)}) at Google's paid rates, free on this
      project's plan.
    </span>
  );
}
