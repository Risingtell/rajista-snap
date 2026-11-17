# Rajista Snap

Photograph a supplier invoice and get a clean product list, ready for your shop's records.

Built for Nigerian shops, where most supplier invoices are handwritten in carbon-copy books, with shorthand like `2 ctn GP Sugar @ 30,000`. Snap reads the photo, checks the arithmetic, matches each line to the shop's own products, and sends the result to [Rajista](https://www.rajista.com) or WhatsApp.

**Try it:** https://snap.rajista.com (Chrome on a desktop or laptop shows the on-device path; any phone browser uses the cloud path).

## For judges: try it in two minutes

No account, no login, nothing to install. Open **https://snap.rajista.com** in any browser, on a phone or a computer.

1. Tap **Invoice 1 · 3 Nov**. It is a real handwritten invoice, written on Rising Technology's own receipt book to a made-up customer, Alhaji Musa Wholesale. Snap reads it and warns that **the invoice itself does not add up**: the lines make ₦109,500, but the trader wrote ₦109,000.
2. Tap **Save to my products**, then **Invoice 2 · 9 Nov**. The sugar and the noodles are written differently this time, and Snap still matches them to the products saved from invoice 1.
3. Save again, then tap **Invoice 3 · 15 Nov**. Lines Snap has seen from this supplier say **Known from this supplier**.
4. Type a selling price on a line, then try **Download for Rajista** (a file Rajista's Import screen reads) or **Share on WhatsApp**.

Every result says which reader produced it, how long it took, why it went to the cloud when it did, and what the cloud reads would cost at Google's paid rates.

### Seeing the on-device path

The on-device reader needs desktop Chrome on a computer that meets [Chrome's built-in AI requirements](https://developer.chrome.com/docs/ai/get-started) (Windows, macOS, Linux or ChromeOS; 16 GB of RAM and 4 cores, or a GPU with more than 4 GB of memory; 22 GB of free disk). On such a computer:

1. Click **Get the on-device model** at the top right (a one-off download of a few minutes).
2. Tap **Printed invoice · 12 Nov**. It is read entirely on the device: the photo never leaves the computer, the numbers cross-check, and the cost is ₦0.
3. Tap a handwritten sample. The device reads it first; when its numbers do not add up, Snap sends the photo to the cloud and says why.

Phones and other browsers use the cloud path. Everything else (samples, matching, the product list, export) works the same on every device.

## How the hybrid AI works

All AI calls go through **Firebase AI Logic**, protected by **App Check** (reCAPTCHA Enterprise).

1. **Read on the device first.** If Chrome's built-in model (Gemini Nano) is available, Snap reads the photo on the device (`InferenceMode.ONLY_ON_DEVICE`, image input, JSON constrained to one schema).
2. **Check the sums.** Every line must satisfy quantity × unit price = line total, and the lines plus any extra rows the total includes must add up to the invoice total, to the naira. Which extra rows (VAT, delivery, a crate deposit, a discount, an old balance) the total includes is worked out from the arithmetic, not guessed from their labels, so a subtotal or an amount paid that a reader copies among them is simply left out. The one exception on a line is a gap that rounding can explain, up to half a naira per piece (a carton of 12 for ₦13,000 written as ₦1,083 a piece): that line is shown to the owner as a note to check, never as a failure and never as "everything adds up". A quantity nobody wrote is taken from the line (the line total over the unit price) and noted, never checked as an error. When some lines have no price, or there is no total, the screen says the total could not be checked instead of "everything adds up". A price is only trusted when another number on the page agrees with it (`src/invoice.ts`).
3. **Send to the cloud only when needed.** If the device's read does not add up, found no prices, listed charges, or the device cannot read, the same photo goes to `gemini-3.5-flash-lite` (`InferenceMode.ONLY_IN_CLOUD`). If that read adds up only with extra rows, one narrow read of just the extra amounts checks them (`src/flow.ts`). If it does not add up, the quick model reads the photo a second time, with the charges read on their own at the same time (about 3 seconds). Only when the two quick reads disagree on the lines themselves, or the quick model is busy, does `gemini-3.6-flash` read it too. Busy errors are retried twice first, a used-up daily allowance is recognised and not retried, and every call has a time limit after which it is cancelled. That includes the on-device model: each on-device prompt runs in its own session with an abort signal, which the SDK passes through to Chrome. The screen says which reader produced the result, how long it took, why it moved to the cloud, and what the cloud reads would cost at Google's paid rates.
4. **Never "fix" the paper.** Both readers are told to copy numbers exactly, even when the paper's arithmetic is wrong, and to list VAT, delivery and discounts only when they are written, so they count in the sum. Only the narrow charges read confirms an extra row: full reads are the same model seeing the same gap, so two of them could make up the same "discount" to close it, while the charges read is not asked to add anything up. A sum that works only with rows the charges read did not find is shown with those rows marked in orange, and what the sum would be without them: never "all clear", and nothing blamed on the paper. Each extra row counts the way its kind allows, whatever sign a reader wrote: a discount or payment comes off, VAT or delivery is added, and a deposit may be either (a crate deposit is added, "less deposit" comes off). Two reads' rows are the same row only if they are the same kind and amount, so a delivery line never vouches for a discount. Snap says an invoice does not add up only when the lines and total were found twice, and either a line's own arithmetic is wrong or no choice of the extra rows any read saw makes the total add up. When every number was found twice and they still do not add up, Snap says the invoice does not add up and asks the owner to check those numbers against the paper: if they match, it is the supplier's mistake, money the shop would otherwise lose. When the reads agree on every line but not on the total, one more narrow read of just the written total settles which one is right. Any other disagreement is shown with every disputed number marked, and the other read beside it, for the owner to check (`settle` and `resolve` in `src/flow.ts`, `addingSubset` in `src/invoice.ts`).
5. **Keep the private work on the device.** The shop's product list, selling prices and each supplier's shorthand live in the browser (IndexedDB) and are never uploaded. When plain name matching is unsure, the on-device model picks the matching product, one line at a time; a new reading cancels a pick that is still running, so reading always comes first. That step has no cloud fallback, on purpose: the code checks that Chrome's model is present before asking (without it, the SDK would answer an on-device request from the cloud) and that the answer really came from the device.

What we measured on real invoices (14 to 16 November 2026, Chrome's on-device model on a 4-core CPU):

| Invoice | On-device read | Result |
|---|---|---|
| Printed wholesale invoices (the printed sample, and a second one) | Correct, sums cross-checked, 20 to 25 s | Kept on the device, cost ₦0 |
| Handwritten sample 3, 3 lines | Misread a quantity (2 for 3); the lines did not add up | Sent to the cloud: correct in 1.6 s |
| Handwritten sample 1, written total ₦109,000 for lines making ₦109,500 | Cloud reads only | Two reads found the same numbers: flagged as an error on the invoice itself |
| Handwritten receipt, 2 lines, ₦2,365,000 | Misread prices; the lines did not add up | Sent to the cloud: correct in 1.5 to 2.7 s |
| Handwritten sales invoice, 1 line | Varied between runs; once read ₦160,000 for ₦140,000 with no total | Not trusted without a matching total; cloud read correct |
| The same receipt photographed sideways (phone) | No on-device model on the phone | Cloud read correct in 2.4 s once the prompt allowed for rotated photos |

Firebase **Remote Config** holds the cloud prices and the naira rate used by the cost counter, so they can change without a release.

## Run it yourself

You need Node 20+ and a Firebase project on the free Spark plan with:

- Firebase AI Logic turned on with the **Gemini Developer API**
- A web app registered, and App Check set up with a **reCAPTCHA Enterprise** key for your domain
- For local testing, an App Check **debug token** (App Check > Apps > Manage debug tokens)

```bash
npm install
cp .env.example .env.local      # fill in your project's web config and reCAPTCHA site key
# put VITE_APPCHECK_DEBUG_TOKEN=<your debug token> in .env.development.local (development builds only)
npm run dev                     # http://localhost:5173
npm test                        # unit tests: sum check, reconciling reads, matching, export, cost
```

To see the on-device path, use desktop Chrome on a machine that meets [Chrome's built-in AI requirements](https://developer.chrome.com/docs/ai/get-started) (16 GB RAM and 4 cores, or a GPU with more than 4 GB of memory, plus 22 GB of free disk). Snap offers a button to download the model.

## Project layout

| File | What it does |
|---|---|
| `src/reader.ts` | The hybrid reader: on-device first, sum check, cloud fallback |
| `src/invoice.ts` | Invoice schema, reading prompts, sum check, which extra rows the total includes |
| `src/flow.ts` | What happens after the first cloud read: charges, second read, total, stronger model |
| `src/devicequeue.ts` | One on-device prompt at a time, readings first |
| `src/match.ts`, `src/devicematch.ts` | Matching lines to the shop's products, by name and with the on-device model |
| `src/store.ts` | The private product list (IndexedDB) |
| `src/export.ts` | Rajista import file and WhatsApp message |
| `src/settings.ts` | Remote Config values and the cost counter |
| `public/sw.js` | Offline support |
| `public/samples/` | The sample invoices: three handwritten on Rising Technology's own receipt book to a made-up customer, and one printed demo invoice from a made-up distributor |

## Built during #BuildHybridAI

Everything in this repository was written from 15 November 2026. It reuses two things that existed before: the colours and typeface of the Rajista app, and the column headings of Rajista's product import, so Snap's file opens there directly.

## Licence

Apache License 2.0. See [LICENSE](LICENSE).
