// What happens after the first cloud read, kept apart from Firebase so every path can be tested (src/flow.test.ts).
//
// The rule behind it: Snap only says an invoice does not add up when every number in the sum was found twice. Lines
// and total come from two full reads. Charges (VAT, delivery, discounts) are the one kind of number a full read could
// make up to close a gap, so they are checked against a narrow read of the charges alone, which is not asked to add
// anything up. When the two disagree, nothing is blamed on the paper: the charges are marked for the owner to check.
//
//   - A first read that adds up is kept (its charges, if any, confirmed by the narrow read).
//   - Otherwise the quick model reads the photo again, with the charges read on their own at the same time. The same
//     numbers twice: the paper itself does not add up. Same lines but a different total: a narrow read of the
//     written total settles it. Different lines: the stronger model reads it too. Anything still unclear is shown
//     with the disputed numbers marked.
import { chargesTotal, checkSums, cleanCharges, reconcile, sameLines, settleTotal, totalOnlyDispute, type Charge, type Dispute, type Invoice } from "./invoice";

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
  /** Only when every number in the sum was found twice and they do not add up. */
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

/** How a full read's charges stand against the narrow read of the charges alone. */
export type ChargeState = "none" | "confirmed" | "disputed" | "unchecked";
export type Judged = { inv: Invoice; state: ChargeState };

/**
 * A full read's charges against the narrow read `n` (undefined: not read; null: that read failed).
 * - The narrow read's charges make this read add up: they are used. That read did not know the gap, so a made-up
 *   figure would not close it exactly.
 * - Both found the same charges, or both found none: confirmed.
 * - Otherwise disputed: the full read's own charges stay on screen for the owner to check.
 * - With no narrow read, charges the full read lists are unchecked.
 */
export function judgeCharges(r: Invoice, n: Charge[] | null | undefined): Judged {
  const own = r.charges ?? [];
  if (!n) return { inv: r, state: own.length ? "unchecked" : "none" };
  const nc = cleanCharges(r, n);
  const narrow: Invoice = { ...r, charges: nc };
  if (checkSums(narrow).ok) return { inv: narrow, state: nc.length ? "confirmed" : "none" };
  if (Math.abs(chargesTotal(r) - chargesTotal(narrow)) <= 1) return own.length ? { inv: r, state: "confirmed" } : { inv: narrow, state: "none" };
  return { inv: r, state: "disputed" };
}

const settledCharges = (j: Judged) => j.state === "none" || j.state === "confirmed";

export async function settle(first: Invoice, read: Readers, opts: SettleOptions = {}): Promise<Settled> {
  const why = opts.why ?? (() => "it failed");
  const steps: string[] = [];
  const listed = (first.charges ?? []).length > 0;

  // The charges read on their own, once per photo: undefined until read, null if that read failed.
  let n: Charge[] | null | undefined;
  let nFailed = "";
  let nRun: Promise<void> | undefined;
  const readCharges = () =>
    (nRun ??= read.charges().then(
      (c) => {
        n = c;
      },
      (e) => {
        n = null;
        nFailed = why(e);
      },
    ));

  /** The result. Unless every read's charges are settled, the paper is not blamed and the charges are marked. */
  const done = (invoice: Invoice, found: { paperError?: string; disputes?: Dispute[] }, reads: Judged[]): Settled => {
    const disputes = [...(found.disputes ?? [])];
    let paperError = found.paperError;
    if (!reads.every(settledCharges)) {
      paperError = undefined;
      if (!disputes.some((d) => d.field === "charges")) {
        const other = n ? chargesTotal({ ...invoice, charges: cleanCharges(invoice, n) }) : null;
        disputes.push({ line: null, field: "charges", shown: chargesTotal(invoice), other });
      }
    }
    return { invoice, paperError, disputes: disputes.length ? disputes : undefined, steps };
  };

  // 1. The first read. Charges it lists are checked against a read of the charges alone.
  if (listed) {
    await readCharges();
    steps.push(
      n === null
        ? `The read listed charges (VAT, delivery or a discount), but reading them on their own failed (${nFailed}).`
        : "The read listed charges (VAT, delivery or a discount), so the charges were read again on their own.",
    );
  }
  let a = judgeCharges(first, n);
  const firstCheck = checkSums(a.inv);
  if (opts.secondRead === false || (firstCheck.ok && a.state !== "disputed" && !opts.forceSecond)) return done(a.inv, {}, [a]);

  // 2. The quick model reads the photo again. Unless already done, the charges are read on their own at the same
  //    time, so a VAT or delivery line that both full reads missed is not taken for the supplier's mistake.
  steps.push(
    !firstCheck.ok
      ? `The first cloud read did not add up (${firstCheck.problems[0]}), so it was read a second time.`
      : a.state === "disputed"
        ? "Read on their own, the charges came out different, so it was read a second time."
        : "It was read a second time (test mode).",
  );
  const chargesNow = n === undefined;
  const [again] = await Promise.all([
    read.again().then(
      (inv) => ({ inv, failed: "" }),
      (e) => ({ inv: null, failed: why(e) }),
    ),
    readCharges(),
  ]);
  if (chargesNow) {
    steps.push(n === null ? `Reading VAT, delivery and discounts on their own failed (${nFailed}).` : "VAT, delivery and discounts were also read on their own.");
  }
  a = judgeCharges(first, n);
  if (!again.inv) {
    steps.push(`The second read failed (${again.failed}), so the first read is shown: please check it against the paper.`);
    return done(a.inv, {}, [a]);
  }
  let b = judgeCharges(again.inv, n);
  // When one full read agrees with the charges read on their own, the other full read's charges were the odd ones out.
  if (a.state === "disputed" && settledCharges(b)) a = { inv: { ...a.inv, charges: b.inv.charges }, state: b.state };
  else if (b.state === "disputed" && settledCharges(a)) b = { inv: { ...b.inv, charges: a.inv.charges }, state: a.state };

  if (totalOnlyDispute(a.inv, b.inv)) {
    // Same lines and charges, different totals, one of them adds up: read just the written total once more.
    try {
      const s = settleTotal(a.inv, b.inv, await read.total());
      return done(s.invoice, s, [a, b]);
    } catch {
      /* the narrow read failed: fall through, and the owner checks the disputed total */
    }
  }

  if (!sameLines(a.inv, b.inv)) {
    // The two quick reads disagree on the lines themselves: the stronger model gives a third opinion.
    steps.push("The two reads disagreed on the lines, so a stronger model read it too.");
    try {
      const c = judgeCharges(await read.strong(), n);
      const better = checkSums(b.inv).problems.length < checkSums(a.inv).problems.length ? b : a;
      const r = reconcile(better.inv, c.inv);
      return done(r.invoice, r, [better, c]);
    } catch (e) {
      steps.push(`The stronger model could not help (${why(e)}).`);
    }
  }
  const r = reconcile(a.inv, b.inv);
  return done(r.invoice, r, [a, b]);
}
