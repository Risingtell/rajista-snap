import { useEffect, useMemo, useRef, useState } from "react";
import { rajistaCsv, rows, whatsappText } from "./export";
import { preparePhoto, type Photo } from "./image";
import { checkSums, naira, type Dispute, type Invoice, type Line } from "./invoice";
import { devicePicksOff, pickOnDevice } from "./devicematch";
import { aliasKey, isAliasOf, matchLine, type Product } from "./match";
import { CLOUD_MODEL, deviceReadWaiting, deviceSlow, deviceStatus, downloadDeviceModel, readInvoice, type DeviceStatus, type Reading } from "./reader";
import { cloudCost, loadSettings } from "./settings";
import { deleteProduct, listProducts, newId, saveProducts } from "./store";

const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
/** What the owner picked for a line: a product id, "new" for a new product, or undefined to accept Snap's match. */
type Choice = string | "new" | undefined;

/** The sample invoices on the first screen. Both suppliers are made up; the handwriting and receipt book are real. */
const SAMPLES = [
  { file: "alhaji-musa-1.jpg", label: "Invoice 1 · 3 Nov" },
  { file: "alhaji-musa-2.jpg", label: "Invoice 2 · 9 Nov" },
  { file: "alhaji-musa-3.jpg", label: "Invoice 3 · 15 Nov" },
  { file: "printed-invoice.jpg", label: "Printed invoice · 12 Nov" },
];

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
  // Lines the on-device model matched to a product (id), or "none" when it found no match, with the text it
  // judged: once the owner edits a line's text or the supplier, that pick no longer applies to it.
  const [devicePicks, setDevicePicks] = useState<({ key: string; id: string } | undefined)[]>([]);
  const savingRef = useRef(false);
  const [saving, setSaving] = useState(false);
  // One reading at a time: a second tap while one is running is ignored (busyRef is checked synchronously).
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  // A sample invoice is matched against, and saved to, the sample products only, never the shop's real list.
  const [fromSample, setFromSample] = useState(false);
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

  /** Runs one reading job at a time, with the busy flag and the error message handled in one place. */
  async function exclusive(job: () => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await job();
    } finally {
      busyRef.current = false;
      setBusy(false);
      setStep(null);
    }
  }

  async function readPhoto(blob: Blob, sample: boolean) {
    setReading(null);
    setInvoice(null);
    let p: Photo;
    try {
      p = await preparePhoto(blob);
    } catch {
      setError("Snap could not open this photo. Please try another one.");
      return;
    }
    setPhoto(p);
    setFromSample(sample);
    try {
      show(await readInvoice(p, setStep));
    } catch (e) {
      setError(`Snap could not read this photo: ${(e as Error).message}`);
    }
  }

  function onFile(file: File | undefined) {
    if (fileRef.current) fileRef.current.value = "";
    if (file) exclusive(() => readPhoto(file, false));
  }

  function trySample(file: string) {
    exclusive(async () => {
      let blob: Blob;
      try {
        const r = await fetch(`/samples/${file}`);
        if (!r.ok || !(r.headers.get("content-type") ?? "").startsWith("image/")) throw new Error(String(r.status));
        blob = await r.blob();
      } catch {
        setError("The sample invoice could not be loaded. Check your connection and try again.");
        return;
      }
      await readPhoto(blob, true);
    });
  }

  function cloudInstead() {
    if (!photo) return;
    exclusive(async () => {
      try {
        show(await readInvoice(photo, setStep, { forceCloud: true }));
      } catch (e) {
        setError(`The cloud could not read this photo: ${(e as Error).message}`);
      }
    });
  }

  function edit(i: number, patch: Partial<Line>) {
    if (!invoice) return;
    setInvoice({ ...invoice, items: invoice.items.map((l, k) => (k === i ? { ...l, ...patch } : l)) });
    setSaved(null);
  }

  // The products this invoice is matched against: the shop's own, or the sample ones for a sample invoice.
  const pool = useMemo(() => products.filter((p) => !!p.demo === fromSample), [products, fromSample]);
  // Snap's suggestion for each line, from the private product list (src/match.ts).
  const matches = useMemo(
    () => (invoice ? invoice.items.map((l) => matchLine(invoice.supplier, l.description, pool)) : []),
    [invoice, pool],
  );
  // Only rerun the on-device matching when the products themselves change, not on every reload of the same list.
  const poolKey = useMemo(() => pool.map((p) => `${p.id}:${p.name}:${p.aliases.length}`).join("|"), [pool]);
  const poolRef = useRef(pool);
  poolRef.current = pool;
  const picksRef = useRef(devicePicks);
  picksRef.current = devicePicks;
  // Lines the name matching was unsure about go to the on-device model, one at a time, privately. This runs once per
  // reading (not on every keystroke), on the text as read, skips lines already decided, and stops as soon as a new
  // reading starts (readings get the on-device model first).
  useEffect(() => {
    if (status !== "available" || deviceSlow() || devicePicksOff() || !reading) return;
    const inv = reading.invoice;
    let stop = false;
    (async () => {
      for (let i = 0; i < inv.items.length && !stop; i++) {
        if (busyRef.current || deviceReadWaiting()) return;
        const key = aliasKey(inv.supplier, inv.items[i].description);
        if (picksRef.current[i]?.key === key) continue;
        const pool = poolRef.current;
        if (!pool.length) return;
        const m = matchLine(inv.supplier, inv.items[i].description, pool);
        if (m.best) continue;
        const candidates = m.others.length ? m.others : pool.length <= 15 ? pool : [];
        if (!candidates.length) continue;
        let id: string;
        try {
          id = (await pickOnDevice(inv.supplier, inv.items[i].description, candidates))?.id ?? "none";
        } catch {
          // The device could not answer (a reading took it, it is busy or too slow): stop, and leave the lines
          // undecided so the owner picks, or the device tries again after the next reading.
          return;
        }
        if (!stop) setDevicePicks((d) => Object.assign([...d], { [i]: { key, id } }));
      }
    })();
    return () => {
      stop = true;
    };
  }, [reading, status, poolKey]);

  /** The on-device pick for line i, only while the line still says what the device judged. */
  const devicePickFor = (i: number) => {
    const d = devicePicks[i];
    if (!d || d.id === "none" || !invoice || d.key !== aliasKey(invoice.supplier, invoice.items[i]?.description ?? "")) return undefined;
    return pool.find((p) => p.id === d.id);
  };

  const resolved: (Product | null)[] = matches.map((m, i) => {
    const c = choices[i];
    if (c === "new") return null;
    if (c) return products.find((p) => p.id === c) ?? null;
    if (m.best) return m.best.product;
    return devicePickFor(i) ?? null;
  });

  /** Saves every line to the product list: new products, latest cost prices, selling prices, and what each supplier calls them. */
  async function saveAll() {
    if (!invoice || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    try {
      await saveLines(invoice);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  async function saveLines(invoice: Invoice) {
    const byId = new Map(products.map((p) => [p.id, { ...p, aliases: [...p.aliases] }]));
    let added = 0, learned = 0;
    invoice.items.forEach((l, i) => {
      const cost = l.unit_price ?? (l.line_total !== null && l.quantity > 0 ? Math.round(l.line_total / l.quantity) : null);
      const picked = resolved[i];
      if (!picked) {
        const id = newId();
        byId.set(id, {
          id,
          name: l.description,
          sellPrice: prices[i] ?? null,
          lastCost: cost,
          aliases: invoice.supplier ? [aliasKey(invoice.supplier, l.description)] : [],
          ...(fromSample ? { demo: true } : {}),
        });
        added++;
        return;
      }
      const p = byId.get(picked.id)!;
      if (cost !== null) p.lastCost = cost;
      if (prices[i] != null) p.sellPrice = prices[i]!;
      const key = aliasKey(invoice.supplier, l.description);
      if (!p.aliases.some((a) => isAliasOf(a, invoice.supplier, l.description))) {
        p.aliases.push(key);
        learned++;
      }
    });
    const next = [...byId.values()];
    await saveProducts(next);
    setProducts(await listProducts());
    setChoices([]);
    setPrices([]);
    setSaved(
      `Saved on this device${fromSample ? " (sample products, kept apart from your own)" : ""}: ${added} new product${added === 1 ? "" : "s"}, ${learned} new supplier name${learned === 1 ? "" : "s"} learned.`,
    );
  }

  function downloadCsv() {
    if (!invoice) return;
    const { csv, skipped } = rajistaCsv(rows(invoice, resolved, prices));
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
    window.open(`https://wa.me/?text=${encodeURIComponent(whatsappText(invoice.supplier, rows(invoice, resolved, prices), false))}`, "_blank", "noopener");
  }

  const check = invoice ? checkSums(invoice) : null;
  /** What the other cloud read found for this number, when the two reads disagree on it. */
  const other = (line: number | null, field: Dispute["field"]) => reading?.disputes?.find((d) => d.line === line && d.field === field);

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
        <input ref={fileRef} id="photo" type="file" accept="image/*" hidden onChange={(e) => onFile(e.target.files?.[0])} />
        <button className="primary big" disabled={busy} onClick={() => fileRef.current?.click()}>
          {busy ? "Reading…" : photo ? "Snap another invoice" : "Snap an invoice"}
        </button>
        <div className="samples">
          <span>
            No invoice to hand? Try three handwritten invoices written on Rising Technology's own receipt book (Alhaji Musa Wholesale is a made-up
            name), or a printed invoice from a made-up distributor:
          </span>
          {SAMPLES.map((x) => (
            <button key={x.file} className="chip" disabled={busy} onClick={() => trySample(x.file)}>
              {x.label}
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
              {reading.paperError &&
                (check.ok ? (
                  <p className="private">You changed the numbers. As written, the paper did not add up.</p>
                ) : (
                  <div className="paper-error" role="alert">
                    <b>This invoice does not add up.</b> {reading.paperError}
                  </div>
                ))}
              {reading.disputes && <DisputesNote disputes={reading.disputes} invoice={invoice} />}
              {reading.source === "device" && (
                <button className="link" disabled={busy} onClick={cloudInstead}>
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
                        <QuantityInput line={i} value={l.quantity} onChange={(q) => edit(i, { quantity: q })} dispute={other(i, "quantity")} />
                      </td>
                      <td data-label="Product" className="product">
                        <input aria-label={`Product, line ${i + 1}`} value={l.description} onChange={(e) => edit(i, { description: e.target.value })} />
                        <MatchPicker
                          line={i}
                          suggestion={matches[i]}
                          devicePick={devicePickFor(i)}
                          choice={choices[i]}
                          products={pool}
                          onPick={(c) => setChoices((cs) => Object.assign([...cs], { [i]: c }))}
                        />
                      </td>
                      <td className="num" data-label="Unit cost">
                        <MoneyInput label={`Unit cost, line ${i + 1}`} value={l.unit_price} onChange={(v) => edit(i, { unit_price: v })} dispute={other(i, "unit_price")} />
                      </td>
                      <td className="num" data-label="Total">
                        <MoneyInput label={`Total, line ${i + 1}`} value={l.line_total} onChange={(v) => edit(i, { line_total: v })} dispute={other(i, "line_total")} />
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
                  {(invoice.charges ?? []).map((c, k) => (
                    <tr key={`c${k}`} className="charge">
                      <td colSpan={3}>{c.label}</td>
                      <td className="num">
                        <MoneyInput
                          label={`${c.label}, amount`}
                          flagged={c.unsure === true}
                          value={c.amount}
                          onChange={(v) =>
                            setInvoice({
                              ...invoice,
                              charges: (invoice.charges ?? []).flatMap((x, j) => (j !== k ? [x] : v === null ? [] : [{ ...x, amount: v }])),
                            })
                          }
                        />
                      </td>
                      <td />
                    </tr>
                  ))}
                  <tr>
                    <td colSpan={3}>Invoice total</td>
                    <td className="num">
                      <MoneyInput label="Invoice total" value={invoice.total} onChange={(v) => setInvoice({ ...invoice, total: v })} dispute={other(null, "total")} />
                    </td>
                    <td />
                  </tr>
                </tfoot>
              </table>
              <p className={check.ok && !reading.disputes && !check.notes.length ? "sums ok" : "sums bad"}>
                {!check.ok
                  ? check.problems.join(" ")
                  : !check.hasPrices
                    ? "No prices on this paper."
                    : reading.disputes
                      ? reading.disputes.some((d) => d.field !== "lines" && d.field !== "charges")
                        ? "Adds up as shown, but check the numbers marked in orange against the paper."
                        : reading.disputes.some((d) => d.field === "lines")
                          ? "Adds up as shown, but the two reads disagreed: check every line against the paper."
                          : "Adds up as shown, but check the charges (VAT, delivery or a discount) against the paper."
                      : check.notes.length
                        ? "Adds up, but check the note below."
                        : "✓ Everything adds up."}
              </p>
              {check.notes.length > 0 && <p className="notes">{check.notes.join(" ")}</p>}
              <div className="actions">
                <button className="primary" disabled={saving} onClick={saveAll}>
                  {saving ? "Saving…" : "Save to my products"}
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
  const samples = products.filter((p) => p.demo);
  return (
    <details className="card products">
      <summary>
        {products.length > samples.length ? (
          <>
            My products <span className="count">{products.length - samples.length}</span>
          </>
        ) : (
          "Sample products"
        )}
        {samples.length > 0 && <span className="count">{products.length > samples.length ? `+ ${samples.length} from the samples` : samples.length}</span>}
      </summary>
      {samples.length > 0 && (
        <button
          className="link"
          onClick={async () => {
            for (const p of samples) await deleteProduct(p.id);
            onChange();
          }}
        >
          Remove the sample products
        </button>
      )}
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
              <td>
                {p.name}
                {p.demo && <span className="tag">sample</span>}
              </td>
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

/** Explains disputed numbers without promising marks that are not on screen. */
function DisputesNote({ disputes, invoice }: { disputes: Dispute[]; invoice: Invoice }) {
  const marked = disputes.filter((d) => d.field !== "lines" && d.field !== "charges").length;
  const lines = disputes.find((d) => d.field === "lines");
  const charges = disputes.find((d) => d.field === "charges");
  const twoReads = disputes.some((d) => d.field !== "charges");
  const unsure = (invoice.charges ?? []).filter((c) => c.unsure);
  const chargeRows = unsure.length > 0;
  return (
    <div className="disputes" role="status">
      <b>Check this invoice against the paper.</b>
      {twoReads && " Two cloud reads disagreed."}
      {lines && ` One found ${lines.shown} lines and the other ${lines.other}, so check every line.`}
      {charges &&
        (charges.note
          ? ` ${charges.note}`
          : chargeRows
            ? ` ${unsure.map((c) => `${c.label} ${naira(c.amount)}`).join(" and ")} could not be confirmed, so ${unsure.length === 1 ? "it is" : "they are"} marked in orange.`
            : ` The charges (VAT, delivery or a discount) came to ${naira(charges.shown, "₦0")} in one read and ${naira(charges.other, "₦0")} in another.`)}
      {marked > 0 && ` ${marked === 1 ? "The number they disagree on is" : `The ${marked} numbers they disagree on are`} marked in orange, with the other read beside ${marked === 1 ? "it" : "them"}.`}
    </div>
  );
}

function QuantityInput({ line, value, onChange, dispute }: { line: number; value: number; onChange: (q: number) => void; dispute?: Dispute }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  return (
    <>
      <input
        aria-label={`Quantity, line ${line + 1}`}
        className={dispute ? "disputed" : undefined}
        inputMode="decimal"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          const n = Number(text.replace(/,/g, "").trim()); // 1,000 is one thousand; decimals use a point
          if (text.trim() && Number.isFinite(n) && n !== value) onChange(n);
          else setText(String(value));
        }}
      />
      <OtherRead d={dispute} plain />
    </>
  );
}

/** The other cloud read's value for a disputed number, shown under the field. */
function OtherRead({ d, plain }: { d?: Dispute; plain?: boolean }) {
  if (!d) return null;
  return <span className="other-read">other read: {d.other === null ? "blank" : plain ? d.other : naira(d.other)}</span>;
}

function MoneyInput({
  label,
  value,
  onChange,
  dispute,
  flagged,
}: {
  label: string;
  value: number | null;
  onChange: (v: number | null) => void;
  dispute?: Dispute;
  /** Marked for the owner to check, with no other read to show beside it. */
  flagged?: boolean;
}) {
  const [text, setText] = useState(value === null ? "" : value.toLocaleString("en-NG"));
  useEffect(() => setText(value === null ? "" : value.toLocaleString("en-NG")), [value]);
  return (
    <>
      <input
        aria-label={label}
        inputMode="numeric"
        className={dispute || flagged ? "money disputed" : "money"}
      value={text}
      placeholder="–"
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        const n = Number(text.replace(/[₦N,\s]/g, ""));
        const v = text.trim() && Number.isFinite(n) ? n : null;
        if (v !== value) onChange(v);
      }}
      />
      <OtherRead d={dispute} />
    </>
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
