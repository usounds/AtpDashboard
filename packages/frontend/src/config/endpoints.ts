export const DEFAULT_COLLECTION_COUNT_ENDPOINT = 'https://dashboardapi.usounds.work/api/analytics/collection_count_view';
export const DEFAULT_ANALYTICS_API_BASE = 'https://collectiondata.usounds.work';

export type FrontendEndpointEnv = {
    readonly VITE_COLLECTION_COUNT_ENDPOINT?: string;
    readonly VITE_ANALYTICS_API_BASE?: string;
};

export function resolveCollectionCountEndpoint(env: FrontendEndpointEnv = import.meta.env): string {
    const configuredEndpoint = env.VITE_COLLECTION_COUNT_ENDPOINT?.trim();
    return configuredEndpoint || DEFAULT_COLLECTION_COUNT_ENDPOINT;
}

export function resolveAnalyticsApiBase(env: FrontendEndpointEnv = import.meta.env): string {
    void env;
    return DEFAULT_ANALYTICS_API_BASE;
}

export function resolveAnalyticsEndpoint(path: string, env: FrontendEndpointEnv = import.meta.env): string {
    return `${resolveAnalyticsApiBase(env)}/${path.replace(/^\/+/, '')}`;
}
