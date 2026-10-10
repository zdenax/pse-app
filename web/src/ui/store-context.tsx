// React access to the store, the app model and the viewport. Components read state from the
// objects directly and call useStoreVersion() (or useObservable) so they re-render on changes.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { ProjectStoreAPI } from "../core/store-api";
import type { AppModel } from "./app-model";
import type { Viewport } from "./viewport";

/** Anything with a change counter and a subscription (store, viewport, app model, consoles). */
export interface Observable {
  readonly version: number;
  subscribe(listener: () => void): () => void;
}

/** Re-renders the calling component whenever `source` changes; returns its version. */
export function useObservable(source: Observable): number {
  const subscribe = useCallback((listener: () => void) => source.subscribe(listener), [source]);
  const snapshot = () => source.version;
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

function isObservable(source: unknown): source is Observable {
  return (
    typeof source === "object" &&
    source !== null &&
    typeof (source as Observable).subscribe === "function" &&
    typeof (source as Observable).version === "number"
  );
}

/** Like useObservable, for objects that may or may not be observable (e.g. a catalog). */
export function useMaybeObservable(source: unknown): number {
  const observable = isObservable(source) ? source : null;
  const subscribe = useCallback(
    (listener: () => void) => (observable ? observable.subscribe(listener) : () => {}),
    [observable],
  );
  const snapshot = () => (observable ? observable.version : 0);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** useLayoutEffect in the browser, useEffect during server rendering (tests). */
export const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

const StoreContext = createContext<ProjectStoreAPI | null>(null);
const AppModelContext = createContext<AppModel | null>(null);

export function StoreProvider({ store, children }: { store: ProjectStoreAPI; children: ReactNode }) {
  return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>;
}

export function AppModelProvider({ app, children }: { app: AppModel; children: ReactNode }) {
  return (
    <AppModelContext.Provider value={app}>
      <StoreContext.Provider value={app.store}>{children}</StoreContext.Provider>
    </AppModelContext.Provider>
  );
}

export function useStore(): ProjectStoreAPI {
  const store = useContext(StoreContext);
  if (!store) throw new Error("useStore() needs a <StoreProvider> above it.");
  return store;
}

/** Re-renders the caller after every store change. */
export function useStoreVersion(): number {
  return useObservable(useStore());
}

export function useApp(): AppModel {
  const app = useContext(AppModelContext);
  if (!app) throw new Error("useApp() needs an <AppModelProvider> above it.");
  return app;
}

/** Re-renders the caller after every change of the app model (alerts, panel visibility...). */
export function useAppVersion(): number {
  return useObservable(useApp());
}

/** The shared viewport; re-renders the caller when zoom, offset or view size change. */
export function useViewport(): Viewport {
  const viewport = useApp().viewport;
  useObservable(viewport);
  return viewport;
}
