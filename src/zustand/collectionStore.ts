import { create } from 'zustand';
import { Collection } from '../types/collection';

type CollectionState = {
    collection: Collection[];
    isLoading: boolean;
    error: string | null;
    lastFetched: number | null;
};

type CollectionActions = {
    fetchCollection: (force?: boolean) => Promise<void>;
    setCollection: (collection: Collection[]) => void;
};

const CACHE_THRESHOLD = 5 * 60 * 1000; // 5 minutes

export const useCollectionStore = create<CollectionState & CollectionActions>((set, get) => ({
    collection: [],
    isLoading: false,
    error: null,
    lastFetched: null,

    fetchCollection: async (force = false) => {
        const { lastFetched, isLoading } = get();
        const now = Date.now();

        // Skip if already loading
        if (isLoading) return;

        // Skip if cache is still valid and not forced
        if (!force && lastFetched && now - lastFetched < CACHE_THRESHOLD) {
            return;
        }

        set({ isLoading: true, error: null });

        try {
            const response = await fetch('https://collectiondata.usounds.work/collection_count_view');
            if (!response.ok) {
                throw new Error(`Error: ${response.statusText}`);
            }
            const data = (await response.json()) as Collection[];
            set({
                collection: data,
                isLoading: false,
                lastFetched: now
            });
        } catch (err: any) {
            set({
                error: err.message,
                isLoading: false
            });
        }
    },

    setCollection: (collection) => set({ collection }),
}));
