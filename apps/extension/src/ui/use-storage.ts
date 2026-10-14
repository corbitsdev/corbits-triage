import type { WxtStorageItem } from "@wxt-dev/storage";
import { useEffect, useState } from "react";

export function useStorageItem<T>(item: WxtStorageItem<T, Record<string, unknown>>): T | undefined {
  const [value, setValue] = useState<T>();
  useEffect(function watchItem() {
    let live = true;
    // A change watched while the first read is out is newer than what that read returns.
    let changed = false;
    async function load() {
      const read = await item.getValue();
      if (live && !changed) setValue(read);
    }
    load();
    const unwatch = item.watch(function onChange(next) {
      changed = true;
      setValue(next);
    });
    return function stop() {
      live = false;
      unwatch();
    };
  }, [item]);
  return value;
}
