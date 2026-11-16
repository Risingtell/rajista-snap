// Matching invoice lines to the shop's own products. Pure functions, run on the device: the product list
// (with the shop's selling prices) never leaves it.

export type Product = {
  id: string;
  name: string;
  sellPrice: number | null; // the shop's own price, private
  lastCost: number | null; // the last cost price seen on an invoice
  aliases: string[]; // how suppliers have written this product, learned from the owner's choices ("supplier|text")
};

/** Lower case, words only, common shop shorthand expanded, so "2 ctn Milo 400G" and "Milo 400g carton" compare well. */
export function words(s: string): string[] {
  const expand: Record<string, string> = { ctn: "carton", ctns: "carton", pcs: "piece", pc: "piece", pkt: "packet", btl: "bottle", gb: "gb", ram: "ram" };
  return s
    .toLowerCase()
    .replace(/(\d)\s*(g|kg|ml|l|cl|gb|tb|mah)\b/g, "$1$2")
    .split(/[^a-z0-9.]+/)
    .map((w) => w.replace(/^\.+|\.+$/g, "")) // "Ctn." is "ctn"; a decimal like "1.5kg" keeps its point
    .filter((w) => w && w.length > 1 && !["the", "and", "with", "of", "for"].includes(w))
    .map((w) => expand[w] ?? w);
}

const bigrams = (w: string) => {
  const s = new Set<string>();
  for (let i = 0; i < w.length - 1; i++) s.add(w.slice(i, i + 2));
  return s;
};
/** How alike two words look, 0 to 1 (Dice coefficient on letter pairs), so "stabila" still resembles "standing". */
function wordLike(a: string, b: string): number {
  if (a === b) return 1;
  if (/\d/.test(a) || /\d/.test(b)) return 0; // sizes and model numbers must match exactly
  const A = bigrams(a), B = bigrams(b);
  if (!A.size || !B.size) return 0;
  let both = 0;
  for (const x of A) if (B.has(x)) both++;
  return (2 * both) / (A.size + B.size);
}

/** 0 to 1: how much of the product's name appears in the invoice line. */
export function similarity(line: string, product: string): number {
  const L = words(line), P = words(product);
  if (!L.length || !P.length) return 0;
  let score = 0;
  for (const p of P) score += Math.max(0, ...L.map((l) => wordLike(l, p)));
  return score / P.length;
}

export const aliasKey = (supplier: string | null, text: string) => `${(supplier ?? "").trim().toLowerCase()}|${words(text).join(" ")}`;

export type Match = { product: Product; score: number; how: "learned" | "name" } | null;
export type Candidates = { best: Match; others: Product[] };

/**
 * The learned alias wins outright. Otherwise the closest name, if it is clearly close.
 * Also returns the next few candidates for the owner (or the on-device model) to choose from.
 */
export function matchLine(supplier: string | null, text: string, products: Product[]): Candidates {
  const key = aliasKey(supplier, text);
  const learned = products.find((p) => p.aliases.includes(key));
  const ranked = products.map((p) => ({ p, s: similarity(text, p.name) })).sort((a, b) => b.s - a.s);
  if (learned) return { best: { product: learned, score: 1, how: "learned" }, others: ranked.filter((r) => r.p !== learned).slice(0, 4).map((r) => r.p) };
  const top = ranked[0];
  const clear = top && top.s >= 0.75 && (ranked.length < 2 || top.s - ranked[1].s >= 0.15);
  return {
    best: clear ? { product: top.p, score: top.s, how: "name" } : null,
    others: ranked.filter((r) => r.s > 0.2 && (!clear || r.p !== top.p)).slice(0, 4).map((r) => r.p),
  };
}
