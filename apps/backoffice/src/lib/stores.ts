import { OWNER_ROLE, type LocationSummary } from '@rhoyards/shared';
import { useAuth } from '../auth/AuthProvider';
import { useLocations } from '../features/users/api';

/**
 * The stores (locations) this person works in — the same rule as the API: an Owner, or someone with no store
 * assigned, works in all of them. `mine` are active stores they may act at; `all` are every active location.
 */
export function useMyStores() {
  const { session } = useAuth();
  const locations = useLocations();
  const all: LocationSummary[] = (locations.data ?? []).filter((l) => l.isActive);
  const user = session?.user;
  const scoped = Boolean(user && user.locationIds.length > 0 && !user.roles.some((r) => r.code === OWNER_ROLE));
  const mine = scoped ? all.filter((l) => user!.locationIds.includes(l.id)) : all;
  return { all, mine, scoped, isLoading: locations.isPending };
}

/**
 * Options for "which store?" on a new or draft document: the person's stores, plus the document's current store so
 * an existing document still shows it. The default is their only store, else their first till store.
 */
export function useStoreChoices(current?: string | null) {
  const stores = useMyStores();
  const mineIds = new Set(stores.mine.map((l) => l.id));
  const options = stores.all.filter((l) => mineIds.has(l.id) || l.id === current);
  const defaultId = stores.mine.length === 1 ? stores.mine[0]!.id : (stores.mine.find((l) => l.isPosEnabled)?.id ?? stores.mine[0]?.id ?? '');
  return { ...stores, options, defaultId };
}
