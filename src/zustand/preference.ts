import { create } from 'zustand';
import { persist } from 'zustand/middleware';

type Preference = {
  exceptCollectionWithTransaction: boolean;
};

type Action = {
  setExceptCollectionWithTransaction: (exceptCollectionWithTransaction: boolean) => void;
};

export const useModeStore = create<Preference & Action>()(
    persist(
      (set) => ({
        exceptCollectionWithTransaction: false,
        setExceptCollectionWithTransaction: (exceptCollectionWithTransaction) => {
          set({ exceptCollectionWithTransaction });
        },
      }),
      {
        name: 'zustand.preference', // ローカルストレージに保存されるキー名
        partialize: (state) => ({ exceptCollectionWithTransaction: state.exceptCollectionWithTransaction }), // 保存するプロパティを制限
      }
    )
  );