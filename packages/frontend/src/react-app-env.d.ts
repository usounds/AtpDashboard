declare module '*.png';
declare module '*.svg';
declare module '*.jpeg';
declare module '*.jpg';

interface ImportMetaEnv {
    readonly VITE_COLLECTION_COUNT_ENDPOINT?: string;
}

interface ImportMeta {
    readonly env: ImportMetaEnv;
}
