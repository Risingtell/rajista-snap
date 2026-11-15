// Getting a checked invoice out of Snap: a file Rajista's Import screen reads, or a WhatsApp message.
// Pure functions, so the formats are tested.
import type { Invoice } from "./invoice";
import type { Product } from "./match";

/** One invoice line, resolved against the shop's own products. */
export type Row = { name: string; quantity: number; cost: number | null; price: number | null };

export function rows(inv: Invoice, chosen: (Product | null)[]): Row[] {
  return inv.items.map((l, i) => {
    const p = chosen[i];
    const cost = l.unit_price ?? (l.line_total !== null && l.quantity > 0 ? Math.round(l.line_total / l.quantity) : null);
    return { name: p?.name ?? l.description, quantity: l.quantity, cost, price: p?.sellPrice ?? null };
  });
}

const cell = (v: string | number | null) => {
  const s = v === null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/**
 * CSV with the headings Rajista's Import Products screen recognises (name, price, cost price, qty).
 * Rajista needs a selling price for every product, so lines without one are left out and counted.
 */
export function rajistaCsv(rs: Row[]): { csv: string; skipped: number } {
  const ready = rs.filter((r) => r.price !== null);
  const lines = [["Name", "Price", "Cost price", "Qty"], ...ready.map((r) => [r.name, r.price, r.cost, r.quantity])];
  return { csv: lines.map((l) => l.map(cell).join(",")).join("\r\n") + "\r\n", skipped: rs.length - ready.length };
}

const naira = (n: number) => `₦${n.toLocaleString("en-NG")}`;

/** A plain message a shop owner can send to staff or a partner. Cost prices are only included if asked. */
export function whatsappText(supplier: string | null, rs: Row[], withCost: boolean): string {
  const head = supplier ? `New stock from ${supplier}:` : "New stock:";
  const body = rs.map((r) => {
    const parts = [`${r.quantity} × ${r.name}`];
    if (r.price !== null) parts.push(`sell ${naira(r.price)}`);
    if (withCost && r.cost !== null) parts.push(`cost ${naira(r.cost)}`);
    return `• ${parts.join(", ")}`;
  });
  return [head, ...body, "", "Sent from Rajista Snap"].join("\n");
}
