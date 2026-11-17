// What happens after the first cloud read, kept apart from Firebase so every path can be tested (src/flow.test.ts).
//
// The rule behind it: Snap only says an invoice does not add up when the lines and total were found twice, the charges
// were read on their own, and no choice of the extra rows any read saw (VAT, delivery, deposits, discounts,
// subtotals, payments) makes it add up. Which extra rows the total includes is decided by the arithmetic, not by their
// labels. A row counts once two reads found it, or once the narrow charges read found it and it makes the sum work
// (that read is not asked to add anything up, so it cannot close a gap on purpose). A sum that works only with a row
// one read found is shown with that row marked for the owner to check, and nothing is blamed on the paper.
//
//   - A first read that adds up without extra rows is kept; one that needs them gets the charges read on their own.
//   - Otherwise the quick model reads the photo again, with the charges read on their own at the same time. Same
//     lines and total: settled. Same lines, different totals: a narrow read of the written total settles it.
//     Different lines: the stronger model reads it too. Anything still unclear is shown with the numbers marked.
import { addingSubset, chargesTotal, checkSums, disputes, linesTotal, looksLikeCharge, naira, sameLines, type Charge, type Dispute, type Invoice } from "./invoice";

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
  /** Only when the lines and total were found twice and no choice of the extra rows makes them add up. */
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

/** An extra row seen on the invoice, and which reads found it. */
type Seen = { row: Charge; fulls: number; narrow: boolean };

/** Every distinct extra row across the full reads and the narrow charges read, matched by amount (to the naira). */
export function tally(fulls: Invoice[], narrow: Charge[] | null | undefined): Seen[] {
  const seen: Seen[] = [];
  const add = (rows: Charge[], mark: (s: Seen) => void) => {
    const used = new Set<Seen>();
    for (const row of rows) {
      let s = seen.find((x) => !used.has(x) && Math.abs(x.row.amount - row.amount) <= 1);
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
  /** Counted rows that only one full read found: the owner checks them. */
  unsure: Charge[];
};

/**
 * The shown lines and total, with the extra rows the total includes, weighed across every read. Tried in turn: rows
 * found twice; then also rows only the narrow charges read found; then also rows only one full read found, which are
 * marked unsure. When no choice adds up, the rows found twice that read like charges are shown.
 */
export function resolve(shown: Invoice, fulls: Invoice[], narrow: Charge[] | null | undefined): Resolved {
  if (shown.total === null || shown.items.length === 0) return { invoice: shown, adds: true, unsure: [] };
  const seen = tally(fulls, narrow);
  const twice = seen.filter((s) => s.fulls + (s.narrow ? 1 : 0) >= 2).map((s) => s.row);
  const narrowOnly = seen.filter((s) => s.narrow && s.fulls === 0).map((s) => s.row);
  const all = seen.map((s) => s.row);
  const make = (counted: Charge[], adds: boolean, unsure: Charge[] = []): Resolved => ({
    invoice: {
      ...shown,
      charges: counted.map((r) => (unsure.includes(r) ? { ...r, unsure: true as const } : r)),
      notCounted: all.filter((r) => !counted.includes(r)),
    },
    adds,
    unsure,
  });
  const lines = linesTotal(shown);
  const first = addingSubset(lines, shown.total, twice) ?? addingSubset(lines, shown.total, [...twice, ...narrowOnly]);
  if (first) return make(first, true);
  const any = addingSubset(lines, shown.total, all);
  if (any) return make(any, true, any.filter((r) => !twice.includes(r) && !narrowOnly.includes(r)));
  return make(
    twice.filter((r) => looksLikeCharge(r.label)),
    false,
  );
}

export async function settle(first: Invoice, read: Readers, opts: SettleOptions = {}): Promise<Settled> {
  const why = opts.why ?? (() => "it failed");
  const steps: string[] = [];
  const fulls: Invoice[] = [first];

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

  /** The answer for the shown lines and total, with every read's extra rows weighed. */
  const finish = (shown: Invoice, how: { twice: boolean; totalAgain?: boolean; disputes?: Dispute[] }): Settled => {
    const r = resolve(shown, fulls, n);
    const check = checkSums(r.invoice);
    const out = [...(how.disputes ?? [])];
    let paperError: string | undefined;
    if (r.unsure.length) {
      const total = chargesTotal(r.invoice);
      out.push({ line: null, field: "charges", shown: total, other: total - r.unsure.reduce((t, c) => t + c.amount, 0) });
    } else if (!check.ok && how.twice && !out.length) {
      if (!r.adds && n === null) {
        // The charges could not be looked for on their own, so a VAT or delivery line both reads missed cannot be
        // ruled out: the owner checks, and the paper is not blamed.
        out.push({ line: null, field: "charges", shown: chargesTotal(r.invoice), other: null });
      } else {
        const twiceSaid = how.totalAgain
          ? `The total was read again on its own and came back as ${naira(shown.total)} again.`
          : "Snap read the photo twice and got the same numbers both times.";
        paperError = `${check.problems.join(" ")} ${twiceSaid}${PAPER_ADVICE}`;
      }
    }
    return { invoice: r.invoice, paperError, disputes: out.length ? out : undefined, steps };
  };

  const names = (x: Invoice, other: Invoice): Invoice => ({ ...x, supplier: x.supplier ?? other.supplier });
  const problems = (x: Invoice) => checkSums(resolve(x, fulls, n).invoice).problems.length;
  /** The read to show when two reads differ: fewer problems; on a tie, the later (or stronger) one. An empty read never replaces one with lines. */
  const pick = (a: Invoice, b: Invoice) => (b.items.length === 0 && a.items.length > 0 ? a : problems(b) <= problems(a) ? b : a);
  const lineDisputes = (shown: Invoice, other: Invoice) => disputes(shown, other).filter((d) => d.field !== "charges");

  // 1. The first read. If it adds up only with extra rows it alone found, the charges are read on their own.
  let r = resolve(first, fulls, n);
  if (r.unsure.length) {
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
    const shown = pick(first, second);
    return finish(shown, { twice: false, disputes: lineDisputes(shown, shown === second ? first : second) });
  }

  // Different lines: the stronger model gives a third opinion.
  steps.push("The two reads disagreed on the lines, so a stronger model read it too.");
  const better = pick(first, second);
  try {
    const third = await read.strong();
    fulls.push(third);
    if (sameLines(better, third) && better.total === third.total) return finish(names(third, better), { twice: true });
    const shown = pick(better, third);
    return finish(shown, { twice: false, disputes: lineDisputes(shown, shown === third ? better : third) });
  } catch (e) {
    steps.push(`The stronger model could not help (${why(e)}).`);
  }
  return finish(better, { twice: false, disputes: lineDisputes(better, better === second ? first : second) });
}
