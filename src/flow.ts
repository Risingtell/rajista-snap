// What happens after the first cloud read, kept apart from Firebase so every path can be tested (src/flow.test.ts).
//
// Two rules decide what Snap says.
//
// 1. Only the charges read confirms an extra row (VAT, delivery, a deposit, a discount). Full reads are made by the
//    same model with the same instructions, and both see the gap between the lines and the total, so two of them can
//    make up the same "discount" to close it. The charges read is not asked to add anything up, so it has no gap to
//    close. A sum that works only with rows it did not find is shown with those rows marked in orange, and the sum
//    without them, for the owner to check: never "all clear", and nothing blamed on the paper.
// 2. Snap says an invoice does not add up only when the lines and total were found twice, and either a line's own
//    arithmetic is wrong, or the charges were read on their own and no choice of the extra rows any read saw (each
//    counted, left out, or taken off) makes the total add up. Which rows the total includes is worked out from the
//    arithmetic, not from their labels.
//
//   - A first read that adds up without extra rows is kept; one that needs them gets the charges read on their own.
//   - Otherwise the quick model reads the photo again, with the charges read on their own at the same time. Same
//     lines and total: settled. Same lines, different totals: a narrow read of the written total settles it.
//     Different lines: the stronger model reads it too. Anything still unclear is shown with the numbers marked.
import {
  addingSubset,
  allPriced,
  chargesTotal,
  checkSums,
  disputes,
  linesTotal,
  looksLikeCharge,
  MAX_ROWS,
  naira,
  rowAmounts,
  rowKind,
  sameLines,
  sameRow,
  type Charge,
  type Dispute,
  type Invoice,
} from "./invoice";

export type Readers = {
  /** The whole invoice again, quick model. */
  again: () => Promise<Invoice>;
  /** The whole invoice, stronger model. */
  strong: () => Promise<Invoice>;
  /** Only the written total. */
  total: () => Promise<number | null>;
  /** Only the written extra amounts. */
  charges: () => Promise<Charge[]>;
};

export type Settled = {
  invoice: Invoice;
  /** Only when the numbers were found twice and they do not add up (see rule 2 above). */
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

const PAPER_ADVICE =
  " Check these numbers against the paper: if they match, the invoice itself does not add up, so check it with the supplier before you pay. (If the total includes VAT, delivery, a discount or an old balance that is not listed above, it may not be a mistake.)";
const LINE_ADVICE = " Check these numbers against the paper: if they match, the supplier's arithmetic on that line is wrong, so check it with them before you pay.";

/** An extra row seen on the invoice, and which reads found it. */
type Seen = { row: Charge; fulls: number; narrow: boolean };

/**
 * Every distinct extra row across the full reads and the charges read. Two reads' rows are the same row when they are
 * the same kind (VAT, a discount, a deposit, a payment...) and the same amount to the naira, whatever sign was written:
 * so a delivery line the charges read found never vouches for a discount a full read made up.
 */
export function tally(fulls: Invoice[], narrow: Charge[] | null | undefined): Seen[] {
  const seen: Seen[] = [];
  const add = (rows: Charge[], mark: (s: Seen) => void) => {
    const used = new Set<Seen>();
    for (const row of rows) {
      let s = seen.find(
        (x) => !used.has(x) && rowKind(x.row.label) === rowKind(row.label) && Math.abs(Math.abs(x.row.amount) - Math.abs(row.amount)) <= 1,
      );
      if (!s) seen.push((s = { row: { label: row.label, amount: row.amount }, fulls: 0, narrow: false }));
      used.add(s);
      mark(s);
    }
  };
  for (const f of fulls) add([...(f.charges ?? []), ...(f.notCounted ?? [])], (s) => s.fulls++);
  add(narrow ?? [], (s) => (s.narrow = true));
  return seen;
}

export type Resolved = {
  invoice: Invoice;
  /** Some choice of the extra rows seen makes the total add up. */
  adds: boolean;
  /** Counted rows the charges read did not find: the owner checks them. */
  unsure: Charge[];
  /** More extra rows than can all be tried: the paper is never blamed then. */
  capped: boolean;
};

/**
 * The shown lines and total, with the extra rows the total includes, weighed across every read: first only rows the
 * charges read found; then also rows only full reads found, which are marked unsure. When no choice adds up, every row
 * any read saw that reads like a charge is shown (as its kind counts it), the ones the charges read did not find marked
 * unsure, so the gap on screen is the real one.
 */
export function resolve(shown: Invoice, fulls: Invoice[], narrow: Charge[] | null | undefined): Resolved {
  if (shown.total === null || shown.items.length === 0 || !allPriced(shown)) return { invoice: shown, adds: true, unsure: [], capped: false };
  const seen = tally(fulls, narrow);
  const witnessed = seen.filter((s) => s.narrow).map((s) => s.row);
  const all = [...witnessed, ...seen.filter((s) => !s.narrow).map((s) => s.row)];
  const capped = all.length > MAX_ROWS;
  const make = (counted: Charge[], adds: boolean, unsure: Charge[] = []): Resolved => ({
    invoice: {
      ...shown,
      charges: counted.map((c) => (unsure.some((u) => sameRow(u, c)) ? { ...c, unsure: true as const } : c)),
      notCounted: all.filter((r) => !counted.some((c) => sameRow(c, r))),
    },
    adds,
    unsure,
    capped,
  });
  const lines = linesTotal(shown);
  const confirmed = addingSubset(lines, shown.total, witnessed);
  if (confirmed) return make(confirmed, true);
  const any = addingSubset(lines, shown.total, all);
  if (any) return make(any, true, any.filter((c) => !witnessed.some((w) => sameRow(w, c))));
  const shownRows = all.filter((r) => looksLikeCharge(r.label)).map((r) => ({ ...r, amount: rowAmounts(r)[0] }));
  return make(
    shownRows,
    false,
    shownRows.filter((c) => !witnessed.some((w) => sameRow(w, c))),
  );
}

export async function settle(first: Invoice, read: Readers, opts: SettleOptions = {}): Promise<Settled> {
  const why = opts.why ?? (() => "it failed");
  const steps: string[] = [];
  const fulls: Invoice[] = [first];

  // The extra amounts read on their own, once per photo: undefined until read, null if that read failed.
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

  /** The charges dispute for rows the charges read did not confirm, with the sentence the screen shows. */
  const unsureDispute = (r: Resolved): Dispute => {
    const total = chargesTotal(r.invoice);
    const without = total - r.unsure.reduce((t, c) => t + c.amount, 0);
    const one = r.unsure.length === 1;
    const list = r.unsure.map((c) => `${c.label} ${naira(c.amount)}`).join(" and ");
    const why = n === null ? "could not be checked (reading the charges on their own failed)" : `${one ? "was" : "were"} not found when the charges were read on their own`;
    const after = r.adds
      ? `With ${one ? "it" : "them"}, the total adds up; without, the lines and other charges come to ${naira(linesTotal(r.invoice) + without)} and the total says ${naira(r.invoice.total)}.`
      : `Even with ${one ? "it" : "them"}, the total does not add up.`;
    const note = `${list} ${why}, so ${one ? "it is" : "they are"} marked in orange. ${after}`;
    return { line: null, field: "charges", shown: total, other: without, note };
  };

  /** The answer for the shown lines and total, with every read's extra rows weighed. */
  const finish = (shown: Invoice, how: { twice: boolean; totalAgain?: boolean; strongAgreed?: boolean; disputes?: Dispute[] }): Settled => {
    const r = resolve(shown, fulls, n);
    const out = [...(how.disputes ?? [])];
    let paperError: string | undefined;
    // Without a charges read, a total that does not add up gets one plain note below instead of row-by-row notes.
    if (r.unsure.length && !(!r.adds && n === null)) out.push(unsureDispute(r));
    if (how.twice) {
      const twiceSaid = how.totalAgain
        ? `The total was read again on its own and came back as ${naira(shown.total)} again.`
        : how.strongAgreed
          ? "Two of three reads, one by a stronger model, found the same numbers."
          : "Snap read the photo twice and got the same numbers both times.";
      const lineErrors = checkSums({ ...r.invoice, total: null }).problems.filter((p) => p.startsWith("Line "));
      if (!r.adds && n && !r.capped) paperError = `${checkSums(r.invoice).problems.join(" ")} ${twiceSaid}${PAPER_ADVICE}`;
      else if (lineErrors.length) paperError = `${lineErrors.join(" ")} ${twiceSaid}${LINE_ADVICE}`;
      else if (!r.adds) {
        out.push({
          line: null,
          field: "charges",
          shown: chargesTotal(r.invoice),
          other: null,
          note: "Snap could not check every VAT, delivery or discount line on its own, so check the paper for any that is not listed here.",
        });
      }
    }
    return { invoice: r.invoice, paperError, disputes: out.length ? out : undefined, steps };
  };

  const names = (x: Invoice, other: Invoice): Invoice => ({ ...x, supplier: x.supplier ?? other.supplier });
  const problems = (x: Invoice) => checkSums(resolve(x, fulls, n).invoice).problems.length;
  /** The read to show when two reads differ: fewer problems; on a tie, the later (or stronger) one. An empty read never replaces one with lines. */
  const pick = (a: Invoice, b: Invoice) => (b.items.length === 0 && a.items.length > 0 ? a : problems(b) <= problems(a) ? b : a);
  /** Shows one of two reads that differ, with the supplier from either, and the numbers they disagree on marked. */
  const showOne = (a: Invoice, b: Invoice) => {
    const shown = pick(a, b);
    const other = shown === b ? a : b;
    return finish(names(shown, other), { twice: false, disputes: disputes(shown, other).filter((d) => d.field !== "charges") });
  };

  // 1. The first read. If it adds up only with extra rows, the charges are read on their own.
  let r = resolve(first, fulls, n);
  if (r.adds && r.unsure.length) {
    await readCharges();
    steps.push(
      n === null
        ? `The read listed charges (VAT, delivery or a discount), but reading them on their own failed (${nFailed}).`
        : "The read listed charges (VAT, delivery or a discount), so the charges were read again on their own.",
    );
    r = resolve(first, fulls, n);
  }
  const firstCheck = checkSums(r.invoice);
  if (opts.secondRead === false || (firstCheck.ok && !r.unsure.length && !opts.forceSecond)) return finish(first, { twice: false });

  // 2. The quick model reads the photo again; the charges are read on their own at the same time (unless done), so a
  //    VAT or delivery line that both full reads missed is not taken for the supplier's mistake.
  steps.push(
    !firstCheck.ok
      ? `The first cloud read did not add up (${firstCheck.problems[0]}), so it was read a second time.`
      : r.unsure.length
        ? "Its charges could not be confirmed, so it was read a second time."
        : "It was read a second time (test mode).",
  );
  const chargesNow = n === undefined;
  const [again] = await Promise.all([
    read.again().then(
      (inv) => ({ inv: inv as Invoice | null, failed: "" }),
      (e) => ({ inv: null as Invoice | null, failed: why(e) }),
    ),
    readCharges(),
  ]);
  if (chargesNow) {
    steps.push(n === null ? `Reading VAT, delivery and discounts on their own failed (${nFailed}).` : "VAT, delivery and discounts were also read on their own.");
  }
  if (!again.inv) {
    steps.push(`The second read failed (${again.failed}), so the first read is shown: please check it against the paper.`);
    return finish(first, { twice: false });
  }
  const second = again.inv;
  fulls.push(second);

  // Same lines and total twice: settled (the extra rows are weighed in finish).
  if (sameLines(first, second) && first.total === second.total) return finish(names(second, first), { twice: true });

  if (sameLines(first, second)) {
    // Same lines, different totals: read just the written total once more.
    try {
      const written = await read.total();
      if (written !== null && (written === first.total || written === second.total)) {
        return finish({ ...names(second, first), total: written }, { twice: true, totalAgain: true });
      }
    } catch {
      /* the narrow read failed: the owner checks the disputed total */
    }
    return showOne(first, second);
  }

  // Different lines: the stronger model gives a third opinion. If it agrees with either quick read, those numbers
  // were found twice.
  steps.push("The two reads disagreed on the lines, so a stronger model read it too.");
  try {
    const third = await read.strong();
    fulls.push(third);
    const agrees = [second, first].find((x) => sameLines(x, third) && x.total === third.total);
    if (agrees) return finish(names(third, agrees), { twice: true, strongAgreed: true });
    return showOne(pick(first, second), third);
  } catch (e) {
    steps.push(`The stronger model could not help (${why(e)}).`);
  }
  return showOne(first, second);
}
