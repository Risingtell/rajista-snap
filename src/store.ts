// The shop's product list, kept in this browser (IndexedDB). It is never sent anywhere: selling prices and
// the shorthand Snap learns from each supplier are commercially sensitive, so they stay on the device.
import type { Product } from "./match";

const DB = "rajista-snap";
const STORE = "products";

function open(): Promise<IDBDatabase> {
  return new Promise((ok, no) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: "id" });
    r.onsuccess = () => ok(r.result);
    r.onerror = () => no(r.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  const db = await open();
  return new Promise((ok, no) => {
    const t = db.transaction(STORE, mode);
    const req = run(t.objectStore(STORE));
    t.oncomplete = () => ok(req ? req.result : undefined);
    t.onerror = () => no(t.error);
  });
}

export const listProducts = async () => ((await tx("readonly", (s) => s.getAll())) as Product[] | undefined ?? []).sort((a, b) => a.name.localeCompare(b.name));
export const saveProducts = (ps: Product[]) => tx("readwrite", (s) => void ps.forEach((p) => s.put(p)));
export const deleteProduct = (id: string) => tx("readwrite", (s) => s.delete(id));
export const newId = () => crypto.randomUUID();
