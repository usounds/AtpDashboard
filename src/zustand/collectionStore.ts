import { create } from 'zustand';
import { Collection } from '../types/collection';

type CollectionState = {
    collection: Collection[];
    isLoading: boolean;
    error: string | null;
};

type CollectionActions = {
    fetchCollection: () => Promise<void>;
    setCollection: (collection: Collection[]) => void;
};

export const useCollectionStore = create<CollectionState & CollectionActions>((set, get) => ({
    collection: [],
    isLoading: false,
    error: null,

    fetchCollection: async () => {
        const { isLoading } = get();

        // Skip if already loading
        if (isLoading) return;

        set({ isLoading: true, error: null });

        try {
            const response = await fetch('https://collectiondata.usounds.work/collection_count_view');
            if (!response.ok) {
                throw new Error(`Error: ${response.statusText}`);
            }
            const data = (await response.json()) as Collection[];
            set({
                collection: data,
                isLoading: false
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
