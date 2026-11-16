# Rajista Snap

Photograph a supplier invoice and get a clean product list, ready for your shop's records.

Built for Nigerian shops, where most supplier invoices are handwritten in carbon-copy books, with shorthand like `2 ctn GP Sugar @ 30,000`. Snap reads the photo, checks the arithmetic, matches each line to the shop's own products, and sends the result to [Rajista](https://www.rajista.com) or WhatsApp.

**Try it:** https://snap.rajista.com (Chrome on a desktop or laptop shows the on-device path; any phone browser uses the cloud path).

## For judges: try it in two minutes

No account, no login, nothing to install. Open **https://snap.rajista.com** in any browser, on a phone or a computer.

1. Tap **Invoice 1 · 3 Nov**. It is a handwritten invoice from a wholesaler (the supplier name is made up; the handwriting and receipt book are real). Snap reads it and warns that **the invoice itself does not add up**: the lines make ₦109,500, but the trader wrote ₦109,000.
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
2. **Check the sums.** Every line must satisfy quantity × unit price = line total, and the lines must add up to the invoice total. A price is only trusted when another number on the page agrees with it (`src/invoice.ts`).
3. **Send to the cloud only when needed.** If the device's read does not add up, or the device cannot read at all, the same photo goes to `gemini-3.5-flash-lite` (`InferenceMode.ONLY_IN_CLOUD`). If that read does not add up either, or the quick model is busy, `gemini-3.6-flash` reads it again; busy errors are retried twice first, and every call has a time limit after which it is cancelled. The screen says which reader produced the result, how long it took, why it moved to the cloud, and what the cloud reads would cost at Google's paid rates.
4. **Never "fix" the paper.** Both readers are told to copy numbers exactly, even when the paper's arithmetic is wrong. When two reads find the same numbers and they still do not add up, the mistake is on the invoice itself, and Snap says so: a supplier's adding error is money the shop would otherwise lose. When the two reads disagree, Snap shows the read that adds up and marks every disputed number, with the other read beside it, for the owner to check against the paper (`reconcile` in `src/invoice.ts`).
5. **Keep the private work on the device.** The shop's product list, selling prices and each supplier's shorthand live in the browser (IndexedDB) and are never uploaded. When plain name matching is unsure, the on-device model picks the matching product. That step has no cloud fallback, on purpose.

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
# put VITE_APPCHECK_DEBUG_TOKEN=<your debug token> in .env.development.local
npm run dev                     # http://localhost:5173
npm test                        # unit tests: sum check, reconciling reads, matching, export, cost
```

To see the on-device path, use desktop Chrome on a machine that meets [Chrome's built-in AI requirements](https://developer.chrome.com/docs/ai/get-started) (16 GB RAM and 4 cores, or a GPU with more than 4 GB of memory, plus 22 GB of free disk). Snap offers a button to download the model.

## Project layout

| File | What it does |
|---|---|
| `src/reader.ts` | The hybrid reader: on-device first, sum check, cloud fallback |
| `src/invoice.ts` | Invoice schema, reading prompt, sum check, reconciling two reads |
| `src/match.ts`, `src/devicematch.ts` | Matching lines to the shop's products, by name and with the on-device model |
| `src/store.ts` | The private product list (IndexedDB) |
| `src/export.ts` | Rajista import file and WhatsApp message |
| `src/settings.ts` | Remote Config values and the cost counter |
| `public/sw.js` | Offline support |
| `public/samples/` | The sample invoices: three handwritten by the shop owner on his own receipt book (the supplier name is made up) and one printed demo invoice |

## Built during #BuildHybridAI

Everything in this repository was written from 15 November 2026. It reuses two things that existed before: the colours and typeface of the Rajista app, and the column headings of Rajista's product import, so Snap's file opens there directly.

## Licence

Apache License 2.0. See [LICENSE](LICENSE).
