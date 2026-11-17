// What happens after the first cloud read, kept apart from Firebase so every path can be tested (src/flow.test.ts).
//
//   - Charges (VAT, delivery, discounts) are the one kind of number a reader can make up to close a gap. So when any
//     full read lists charges, one narrow read of the charges alone decides them, for every read of this photo.
//   - A read that adds up is kept.
//   - Otherwise the quick model reads the photo a second time. The same numbers twice: the paper itself does not add
//     up. Same lines but a different total: a narrow read of the written total settles it. Different lines: the
//     stronger model reads it too. Anything still unclear is shown with the disputed numbers marked.
import { chargesTotal, checkSums, linesTotal, reconcile, sameLines, settleTotal, totalOnlyDispute, type Charge, type Dispute, type Invoice } from "./invoice";

/** The written charges for one read, without any that is really that read's subtotal or total copied as a charge. */
const chargesFor = (inv: Invoice, written: Charge[]) => {
  const sum = linesTotal(inv);
  return written.filter((c) => !(sum > 0 && Math.abs(c.amount - sum) <= 1) && !(inv.total !== null && Math.abs(c.amount - inv.total) <= 1));
};

export type Readers = {
  /** The whole invoice again, quick model. */
  again: () => Promise<Invoice>;
  /** The whole invoice, stronger model. */
  strong: () => Promise<Invoice>;
  /** Only the written total. */
  total: () => Promise<number | null>;
  /** Only the written charges. */
  charges: () => Promise<Charge[]>;
};

export type Settled = {
  invoice: Invoice;
  /** Only when two reads found the same numbers and they do not add up. */
  paperError?: string;
  disputes?: Dispute[];
  /** One plain sentence per extra read, for the screen. */
  steps: string[];
};

export type SettleOptions = {
  /** False when the first read already came from the stronger model because the quick one failed. */
  secondRead?: boolean;
  /** Local testing only: read a second time even when the first read adds up. */
  forceSecond?: boolean;
  /** Why a read failed, in a few words ("it was busy"). */
  why?: (e: unknown) => string;
};

export async function settle(first: Invoice, read: Readers, opts: SettleOptions = {}): Promise<Settled> {
  const steps: string[] = [];
  const why = opts.why ?? (() => "it failed");

  // undefined: not read yet; null: the narrow read failed, so the charges shown are unconfirmed.
  let written: Charge[] | null | undefined;
  const withWrittenCharges = async (...reads: Invoice[]): Promise<Invoice[]> => {
    if (written === undefined && reads.some((r) => (r.charges ?? []).length > 0)) {
      try {
        written = await read.charges();
        steps.push("The read listed charges (VAT, delivery or a discount), so the charges were read again on their own.");
      } catch (e) {
        written = null;
        steps.push(`The read listed charges (VAT, delivery or a discount), but reading them on their own failed (${why(e)}).`);
      }
    }
    const w = written;
    return w ? reads.map((r) => ({ ...r, charges: chargesFor(r, w) })) : reads;
  };
  const done = (invoice: Invoice, found: { paperError?: string; disputes?: Dispute[] } = {}): Settled => {
    let disputes = found.disputes?.length ? found.disputes : undefined;
    if (written === null && (invoice.charges ?? []).length > 0 && !disputes?.some((d) => d.field === "charges")) {
      // The charges could not be read on their own: the owner checks them.
      disputes = [...(disputes ?? []), { line: null, field: "charges", shown: chargesTotal(invoice), other: null }];
    }
    return { invoice, paperError: found.paperError, disputes, steps };
  };

  [first] = await withWrittenCharges(first);
  const firstCheck = checkSums(first);
  if (opts.secondRead === false || (firstCheck.ok && !opts.forceSecond)) return done(first);

  steps.push(
    firstCheck.ok ? "It was read a second time (test mode)." : `The first cloud read did not add up (${firstCheck.problems[0]}), so it was read a second time.`,
  );
  let second: Invoice;
  try {
    second = await read.again();
  } catch (e) {
    steps.push(`The second read failed (${why(e)}), so the first read is shown: please check it against the paper.`);
    return done(first);
  }
  [first, second] = await withWrittenCharges(first, second);

  if (totalOnlyDispute(first, second)) {
    // Same lines and charges, different totals, one of them adds up: read just the written total once more.
    try {
      const s = settleTotal(first, second, await read.total());
      return done(s.invoice, s);
    } catch {
      /* the narrow read failed: fall through, and the owner checks the disputed total */
    }
  }

  if (!sameLines(first, second)) {
    // The two quick reads disagree on the lines themselves: the stronger model gives a third opinion.
    steps.push("The two reads disagreed on the lines, so a stronger model read it too.");
    try {
      const [third] = await withWrittenCharges(await read.strong());
      const better = checkSums(second).problems.length < checkSums(first).problems.length ? second : first;
      const r = reconcile(better, third);
      return done(r.invoice, r);
    } catch (e) {
      steps.push(`The stronger model could not help (${why(e)}).`);
    }
  }
  const r = reconcile(first, second);
  return done(r.invoice, r);
}
