// IndexedDB mínimo. Todo queda en el origen de la app, en este navegador.
const DB_NAME = 'mnemo';
const VERSION = 1;
export const STORES = ['keys', 'identities', 'audit', 'encounters', 'counters', 'settings'] as const;
export type StoreName = (typeof STORES)[number];

let dbp: Promise<IDBDatabase> | null = null;

export function db(): Promise<IDBDatabase> {
  dbp ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      for (const s of STORES) if (!d.objectStoreNames.contains(s)) d.createObjectStore(s);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

function wrap<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((res, rej) => {
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}

export async function get<T>(store: StoreName, key: IDBValidKey): Promise<T | undefined> {
  return wrap((await db()).transaction(store).objectStore(store).get(key));
}

export async function put(store: StoreName, key: IDBValidKey, value: unknown): Promise<void> {
  await wrap((await db()).transaction(store, 'readwrite').objectStore(store).put(value, key));
}

export async function del(store: StoreName, key: IDBValidKey): Promise<void> {
  await wrap((await db()).transaction(store, 'readwrite').objectStore(store).delete(key));
}

export async function all<T>(store: StoreName): Promise<[IDBValidKey, T][]> {
  const s = (await db()).transaction(store).objectStore(store);
  const [keys, values] = await Promise.all([wrap(s.getAllKeys()), wrap(s.getAll())]);
  return keys.map((k, i) => [k, values[i] as T]);
}

export async function clear(store: StoreName): Promise<void> {
  await wrap((await db()).transaction(store, 'readwrite').objectStore(store).clear());
}
