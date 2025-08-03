import { create } from 'zustand';
import { persist } from 'zustand/middleware';

type Preference = {
  exceptCollectionWithTransaction: boolean;
  exceptInvalidTLDs: boolean;
};

type Action = {
  setExceptCollectionWithTransaction: (exceptCollectionWithTransaction: boolean) => void;
  setExceptInvalidTLDs: (exceptInvalidTLDs: boolean) => void;
};

export const useModeStore = create<Preference & Action>()(
    persist(
      (set) => ({
        exceptCollectionWithTransaction: false,
        exceptInvalidTLDs:true,
        setExceptCollectionWithTransaction: (exceptCollectionWithTransaction) => {
          set({ exceptCollectionWithTransaction });
        },
        setExceptInvalidTLDs: (exceptInvalidTLDs) => {
          set({ exceptInvalidTLDs });
        },
      }),
      {
        name: 'zustand.preference', // ローカルストレージに保存されるキー名
        partialize: (state) => ({ 
          exceptCollectionWithTransaction: state.exceptCollectionWithTransaction,
          exceptInvalidTLDs: state.exceptInvalidTLDs,
         }), // 保存するプロパティを制限
      }
    )
  );