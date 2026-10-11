// State of the running network that is not configuration and is not saved: NAT translations,
// ARP caches, DHCP leases in progress, counters. Like on real devices it is lost when the page is
// reloaded. Features keep their state here, keyed by device id.

const stores = new Map<string, Map<string, unknown>>();

export const NetworkRuntime = {
  /** The state `key` of a device; created with `initial` the first time. */
  state<T>(key: string, deviceID: string, initial: () => T): T {
    let store = stores.get(key);
    if (!store) {
      store = new Map();
      stores.set(key, store);
    }
    if (!store.has(deviceID)) store.set(deviceID, initial());
    return store.get(deviceID) as T;
  },

  /** Forgets the state `key` of a device (e.g. `clear ip nat translation *`). */
  clear(key: string, deviceID?: string): void {
    if (deviceID === undefined) stores.delete(key);
    else stores.get(key)?.delete(deviceID);
  },

  /** Forgets everything (tests, a newly opened project). */
  reset(): void {
    stores.clear();
  },
};
