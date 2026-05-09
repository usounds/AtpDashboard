import type { CollectionCountApiConfig, FallbackReason } from './config.ts';

export type CircuitBreakerState = {
  failures: number;
  openedAt: number | null;
};

export type RuntimeStatus = {
  circuit: CircuitBreakerState;
  lastDataSource: 'clickhouse' | 'fallback' | 'unavailable' | null;
  lastFallbackReason: FallbackReason | null;
  lastSnapshotRefreshId: string | null;
  lastSnapshotRefreshedAt: string | null;
  lastSnapshotAgeSeconds: number | null;
  lastSuccessAt: string | null;
};

export function createRuntimeStatus(): RuntimeStatus {
  return {
    circuit: {
      failures: 0,
      openedAt: null,
    },
    lastDataSource: null,
    lastFallbackReason: null,
    lastSnapshotRefreshId: null,
    lastSnapshotRefreshedAt: null,
    lastSnapshotAgeSeconds: null,
    lastSuccessAt: null,
  };
}

export function isCircuitOpen(status: RuntimeStatus, config: Pick<CollectionCountApiConfig, 'circuitBreakerOpenMs'>): boolean {
  if (status.circuit.openedAt == null) {
    return false;
  }
  if (Date.now() - status.circuit.openedAt >= config.circuitBreakerOpenMs) {
    status.circuit.openedAt = null;
    status.circuit.failures = 0;
    return false;
  }
  return true;
}

export function recordClickHouseSuccess(status: RuntimeStatus): void {
  status.circuit.failures = 0;
  status.circuit.openedAt = null;
}

export function recordClickHouseFailure(
  status: RuntimeStatus,
  config: Pick<CollectionCountApiConfig, 'circuitBreakerFailureThreshold'>,
): void {
  status.circuit.failures += 1;
  if (status.circuit.failures >= config.circuitBreakerFailureThreshold) {
    status.circuit.openedAt = Date.now();
  }
}

export function updateRuntimeStatus(
  status: RuntimeStatus,
  result: {
    dataSource: 'clickhouse' | 'fallback' | 'unavailable';
    fallbackReason: FallbackReason | null;
    snapshotRefreshId: string | null;
    snapshotRefreshedAt: string | null;
    snapshotAgeSeconds: number | null;
  },
): void {
  status.lastDataSource = result.dataSource;
  status.lastFallbackReason = result.fallbackReason;
  status.lastSnapshotRefreshId = result.snapshotRefreshId;
  status.lastSnapshotRefreshedAt = result.snapshotRefreshedAt;
  status.lastSnapshotAgeSeconds = result.snapshotAgeSeconds;
  status.lastSuccessAt = new Date().toISOString();
}
