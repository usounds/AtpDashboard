export const DEFAULT_COLLECTION_COUNT_ENDPOINT = 'https://collectiondata.usounds.work/collection_count_view';

export type FrontendEndpointEnv = {
    readonly VITE_COLLECTION_COUNT_ENDPOINT?: string;
};

export function resolveCollectionCountEndpoint(env: FrontendEndpointEnv = import.meta.env): string {
    const configuredEndpoint = env.VITE_COLLECTION_COUNT_ENDPOINT?.trim();
    return configuredEndpoint || DEFAULT_COLLECTION_COUNT_ENDPOINT;
}
