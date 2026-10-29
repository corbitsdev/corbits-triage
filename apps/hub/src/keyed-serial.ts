import { settled } from "@corbits/common";

async function runAfter<T>(previous: Promise<void> | undefined, work: () => Promise<T>): Promise<T> {
  await previous;
  return work();
}

/** Runs each piece of work after the earlier work for its key has settled, so work for one key never interleaves. */
export function createKeyedSerial() {
  const tails = new Map<string, Promise<void>>();
  return async function serialized<T>(key: string, work: () => Promise<T>): Promise<T> {
    const current = runAfter(tails.get(key), work);
    const tail = settled(current);
    tails.set(key, tail);
    try {
      return await current;
    } finally {
      if (tails.get(key) === tail) tails.delete(key);
    }
  };
}
