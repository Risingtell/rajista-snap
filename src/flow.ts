// What happens after the first cloud read, kept apart from Firebase so every path can be tested (src/flow.test.ts).
//
// What Snap says, and when:
//
// - "This invoice does not add up" (the supplier's mistake) only when the lines and total were found twice and either
//   a line's own arithmetic is wrong (with its quantity written), or no read found anything on the paper but the lines
//   and a total (both full reads and the charges read on their own, which must have worked; a row that only repeats
//   the total, such as "Amount paid" equal to it, does not count), every line's amount is written, and they do not
//   match. Sample invoice 1 is this case, as are most handwritten receipts.
// - When any read found other amounts, Snap tries every way of counting them (as written, with the sign turned, or
//   left out). "Everything adds up" only if a way works using rows the charges read also found, none of them counted
//   against its label (a discount or a payment added, VAT or delivery taken off, a subtotal counted). Otherwise the
//   rows are marked in orange for the owner to check, or, when no way works, the owner is asked to check the total.
//   The supplier is never blamed then: which rows a total includes cannot be told for sure, so a guess is never
//   turned into an accusation. A subtotal equal to the lines is such an amount: it shows the total adds something.
// - Two full reads are the same model seeing the same gap, so they could make up the same "discount"; the charges read
//   is not asked to add anything up, so only it confirms an extra row.
//
//   The first read is kept if it adds up with nothing unconfirmed. If it adds up only with extra rows, the charges are
//   read on their own first. Otherwise the quick model reads the photo again, with the charges read on their own at
//   the same time: a second read cannot confirm a row, but it may show a misread line that a made-up row was covering,
//   and it finds the lines and total a second time. Same lines and total: settled. Same lines, different totals: a
//   narrow read of the written total settles it. Different lines: the stronger model reads it too. Anything still
//   unclear is shown with the numbers marked.
import {
  addingSubset,
  allPriced,
  chargesTotal,
  checkSums,
  disputes,
  kindOf,
  labelDoubt,
  linesTotal,
  looksLikeCharge,
  naira,
  sameKind,
  sameLines,
  withoutEchoes,
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
  /** Only in the two cases described above. */
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
  " Check these numbers against the paper: if they match, the invoice itself does not add up, so check it with the supplier before you pay. (If the total includes VAT, delivery, a discount or an old balance that is not written on the paper, it may not be a mistake.)";
const LINE_ADVICE = " Check these numbers against the paper: if they match, the supplier's arithmetic on that line is wrong, so check it with them before you pay.";
const NO_WAY =
  "This invoice lists other amounts (such as VAT, delivery, a discount, a deposit or a payment), and no way of counting them makes the total. Check the total against the paper.";

/** An extra row seen on the invoice, and which reads found it. */
type Seen = { row: Charge; fulls: number; narrow: boolean };

/**
 * Every distinct extra row across the full reads and the charges read, matched by amount to the naira (either sign,
 * since readers differ on minus signs) when their labels could name the same kind of row: one read's payment never
 * vouches for another read's discount. A read that lists the same amount twice gives two rows.
 */
export function tally(fulls: Invoice[], narrow: Charge[] | null | undefined): Seen[] {
  const seen: Seen[] = [];
  const add = (rows: Charge[], mark: (s: Seen) => void) => {
    const used = new Set<Seen>();
    for (const row of rows) {
      let s = seen.find(
        (x) => !used.has(x) && Math.abs(Math.abs(x.row.amount) - Math.abs(row.amount)) <= 1 && sameKind(x.row.label, row.label),
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

/**
 * - adds: the total adds up (with no extra rows, or with rows the charges read confirmed).
 * - adds-if: it adds up only with rows the owner should check (unconfirmed, or counted against their label).
 * - no-way: there are extra rows and no way of counting them makes the total.
 * - clean-mismatch: nothing but lines and a total, and they do not match.
 * - unchecked: no total, or a line whose amount is not written, so the total cannot be checked.
 */
export type Verdict = "adds" | "adds-if" | "no-way" | "clean-mismatch" | "unchecked";
export type Resolved = {
  invoice: Invoice;
  verdict: Verdict;
  /**
   * Counted rows the owner checks: not found by the charges read, or counted against their label (`doubt` says how).
   * `found` is how many full reads listed the row.
   */
  unsure: { row: Charge; why: "unconfirmed" | "label"; doubt?: string; found: number }[];
  /** With no-way: a subtotal on the paper equal to the lines, so the total adds something to them. */
  subtotal?: Charge;
};

/** The shown lines and total, with the extra rows weighed across every read (see the rules at the top). */
export function resolve(shown: Invoice, fulls: Invoice[], narrow: Charge[] | null | undefined): Resolved {
  if (shown.total === null || shown.items.length === 0 || !allPriced(shown)) return { invoice: shown, verdict: "unchecked", unsure: [] };
  const lines = linesTotal(shown);
  const total = shown.total;
  const seen = withoutEchoes(
    tally(fulls, narrow).map((s) => ({ ...s.row, s })),
    total,
  ).map((x) => x.s);
  if (!seen.length) {
    const verdict = Math.abs(lines - total) <= 1 ? "adds" : "clean-mismatch";
    return { invoice: { ...shown, charges: [], notCounted: [] }, verdict, unsure: [] };
  }
  // On a tie, a row the charges read found wins over one it did not.
  const chosen = addingSubset(
    lines,
    total,
    seen.map((s, i) => ({ ...s.row, i })),
    (x) => (seen[x.i].narrow ? 1 : 0),
  );
  if (!chosen) {
    return {
      invoice: { ...shown, charges: seen.filter((s) => looksLikeCharge(s.row.label)).map((s) => s.row), notCounted: seen.filter((s) => !looksLikeCharge(s.row.label)).map((s) => s.row) },
      verdict: "no-way",
      unsure: [],
      subtotal: seen.find((s) => kindOf(s.row.label) === "sum" && Math.abs(Math.abs(s.row.amount) - lines) <= 1)?.row,
    };
  }
  const unsure: Resolved["unsure"] = [];
  const charges = chosen.map(({ i, ...row }) => {
    const doubt = labelDoubt(row) ?? undefined;
    const why = !seen[i].narrow ? "unconfirmed" : doubt ? "label" : null;
    if (!why) return row;
    unsure.push({ row, why, doubt, found: seen[i].fulls });
    return { ...row, unsure: true as const };
  });
  const notCounted = seen.filter((_, i) => !chosen.some((c) => c.i === i)).map((s) => s.row);
  return { invoice: { ...shown, charges, notCounted }, verdict: unsure.length ? "adds-if" : "adds", unsure };
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

  // resolve() tries every way of counting the extra rows, so each read is resolved once for what is known so far.
  const cache = new Map<Invoice, { at: string; r: Resolved }>();
  const resolved = (x: Invoice): Resolved => {
    const at = `${fulls.length}${n === undefined ? "" : n === null ? "x" : "y"}`;
    const hit = cache.get(x);
    if (hit && hit.at === at) return hit.r;
    const r = resolve(x, fulls, n);
    cache.set(x, { at, r });
    return r;
  };

  const list = (rows: Charge[]) => rows.map((c) => `${c.label} ${naira(c.amount)}`).join(" and ");

  /** The note for rows the owner should check, written where the facts are known. */
  const rowsDispute = (r: Resolved): Dispute => {
    const unconfirmed = r.unsure.filter((u) => u.why === "unconfirmed");
    const parts: string[] = [];
    if (unconfirmed.length) {
      const one = unconfirmed.length === 1;
      const because =
        n === undefined ? "the charges were not read on their own" : n === null ? "reading the charges on their own failed" : `the charges read on their own did not find ${one ? "it" : "them"}`;
      const few = one && Array.isArray(n) && fulls.length > 1 && unconfirmed[0].found < fulls.length ? `, and only ${unconfirmed[0].found} of ${fulls.length} full reads did` : "";
      parts.push(`${list(unconfirmed.map((u) => u.row))} ${one ? "is" : "are"} counted, but ${because}${few}.`);
    }
    for (const u of r.unsure) if (u.doubt) parts.push(`${list([u.row])} ${u.doubt}.`);
    const total = chargesTotal(r.invoice);
    const without = total - r.unsure.reduce((t, u) => t + u.row.amount, 0);
    const one = r.unsure.length === 1;
    parts.push(
      `With ${one ? "it" : "them"} the total adds up; without, the lines and other charges come to ${naira(linesTotal(r.invoice) + without)} and the total says ${naira(r.invoice.total)}. ${one ? "It is" : "They are"} marked in orange: check against the paper.`,
    );
    return { line: null, field: "charges", shown: total, other: without, note: parts.join(" ") };
  };

  /** The note when no way of counting the extra rows makes the total; a subtotal equal to the lines says more. */
  const noWayNote = (r: Resolved) => {
    const s = r.subtotal;
    if (!s || r.invoice.total === null) return NO_WAY;
    const sub = Math.abs(s.amount);
    return `The paper shows ${s.label} ${naira(sub)}, the same as the lines, but the total says ${naira(r.invoice.total)}. The ${naira(Math.abs(r.invoice.total - sub))} between them may be VAT, delivery, a discount or another amount Snap could not read: check the paper. If nothing else is written there, the total is wrong.`;
  };

  /** The answer for the shown lines and total. */
  const finish = (shown: Invoice, how: { twice: boolean; totalAgain?: boolean; strongAgreed?: boolean; disputes?: Dispute[] }): Settled => {
    const r = resolved(shown);
    const out = [...(how.disputes ?? [])];
    let paperError: string | undefined;
    if (r.verdict === "adds-if") out.push(rowsDispute(r));
    if (r.verdict === "no-way") out.push({ line: null, field: "charges", shown: chargesTotal(r.invoice), other: null, note: noWayNote(r) });
    if (how.twice) {
      const said = how.totalAgain
        ? `The total was read again on its own and came back as ${naira(shown.total)} again.`
        : how.strongAgreed
          ? "Two of three reads, one by a stronger model, found the same numbers."
          : "Snap read the photo twice and got the same numbers both times.";
      const lineErrors = checkSums({ ...r.invoice, total: null }).problems.filter((p) => p.startsWith("Line "));
      const cleanBlame = r.verdict === "clean-mismatch" && Array.isArray(n);
      if (cleanBlame) paperError = `${checkSums(r.invoice).problems.join(" ")} ${said}${PAPER_ADVICE}`;
      else if (lineErrors.length) paperError = `${lineErrors.join(" ")} ${said}${LINE_ADVICE}`;
      if (r.verdict === "clean-mismatch" && !Array.isArray(n)) {
        out.push({
          line: null,
          field: "charges",
          shown: 0,
          other: null,
          note: "Reading the charges on their own failed, so Snap could not rule out a VAT, delivery or discount line that would make the total. Check the paper for one.",
        });
      }
    }
    return { invoice: r.invoice, paperError, disputes: out.length ? out : undefined, steps };
  };

  const names = (x: Invoice, other: Invoice): Invoice => ({ ...x, supplier: x.supplier ?? other.supplier });
  const problems = (x: Invoice) => checkSums(resolved(x).invoice).problems.length;
  /** The read to show when two reads differ: fewer problems; on a tie, the later (or stronger) one. An empty read never replaces one with lines. */
  const pick = (a: Invoice, b: Invoice) => (b.items.length === 0 && a.items.length > 0 ? a : problems(b) <= problems(a) ? b : a);
  /** Shows one of two reads that differ, with the supplier from either, and the numbers they disagree on marked. */
  const showOne = (a: Invoice, b: Invoice) => {
    const shown = pick(a, b);
    const other = shown === b ? a : b;
    return finish(names(shown, other), { twice: false, disputes: disputes(shown, other).filter((d) => d.field !== "charges") });
  };

  // 1. The first read. If it adds up only with extra rows nobody confirmed, the charges are read on their own.
  let r = resolved(first);
  if (r.unsure.some((u) => u.why === "unconfirmed")) {
    await readCharges();
    steps.push(
      n === null
        ? `The read listed other amounts (VAT, delivery or a discount), but reading them on their own failed (${nFailed}).`
        : "The read listed other amounts (VAT, delivery or a discount), so they were read again on their own.",
    );
    r = resolved(first);
  }
  const firstCheck = checkSums(r.invoice);
  const unconfirmed = r.unsure.filter((u) => u.why === "unconfirmed").map((u) => u.row);
  // Kept when its numbers hold together with nothing unconfirmed (a row counted against its label stays marked,
  // whatever is read next). A row that only a full read found is read again, as the rules at the top say.
  const settledFirst = firstCheck.ok && !unconfirmed.length && (r.verdict === "adds" || r.verdict === "adds-if" || r.verdict === "unchecked");
  if (opts.secondRead === false || (settledFirst && !opts.forceSecond)) return finish(first, { twice: false });

  // 2. The quick model reads the photo again; the charges are read on their own at the same time (unless done), so a
  //    VAT or delivery line that both full reads missed is not taken for the supplier's mistake.
  steps.push(
    !firstCheck.ok
      ? `The first cloud read did not add up (${firstCheck.problems[0]}), so it was read a second time.`
      : unconfirmed.length
        ? `It adds up only with ${list(unconfirmed)}, which the charges read on their own ${n === null ? "could not check" : "did not find"}, so it was read a second time.`
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

  // Same lines and total twice: settled.
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
