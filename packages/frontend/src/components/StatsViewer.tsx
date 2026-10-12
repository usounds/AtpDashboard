import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  SegmentedControl,
  Paper,
  Table,
  LoadingOverlay,
  Text,
  Group,
  Alert,
  Box,
  Badge,
  Stack,
  SimpleGrid,
} from '@mantine/core';
import { AreaChart } from '@mantine/charts';
import { IconAlertCircle } from '@tabler/icons-react';
import useColorMode from '../hooks/useColorMode';
import { BarLoader } from 'react-spinners';
import { resolveAnalyticsEndpoint } from '../config/endpoints';
import { useCollectionStore } from '../zustand/collectionStore';
import { calculateUserSurge, calculateRecordSurge } from '../utils/surge';
import {
  buildCollectionCumulativeUsersUrl,
  type CollectionCumulativeUsersRange,
  type CollectionCumulativeUsersResponse,
  type CollectionCumulativeUsersRow,
} from './Charts/collectionCumulativeUsers';
import { formatRelativeDayOffsetLabel } from './Charts/chartLabels';

type Stats = {
  unique_did: number;
  min_createdat: string;
  max_createdat: string;
  unique_rkey: number;
  total_count: number;
};

type Props = {
  collection: string;
};

type StatsTab = 'summary' | 'cumulative';

interface FormattedCumulativeRow extends CollectionCumulativeUsersRow {
  displayDate: string;
}

const StatsViewer: React.FC<Props> = ({ collection }) => {
  const [stats, setStats] = useState<Stats | null>(null);
  const [isLoading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<StatsTab>('summary');
  const [range, setRange] = useState<CollectionCumulativeUsersRange>('365 Days');
  const [cumulativeData, setCumulativeData] = useState<FormattedCumulativeRow[]>([]);
  const [isCumulativeLoading, setCumulativeLoading] = useState(false);
  const [cumulativeError, setCumulativeError] = useState<string | null>(null);
  const cumulativeRequestIdRef = useRef(0);
  const [colorMode] = useColorMode();
  const { collection: collections, fetchCollection } = useCollectionStore();

  useEffect(() => {
    if (collections.length === 0) {
      fetchCollection();
    }
  }, [collections.length, fetchCollection]);

  const collectionItem = useMemo(
    () => collections.find((c) => c.collection === collection),
    [collections, collection]
  );

  const { userSurge, recordSurge } = useMemo(() => {
    const nowMs = Date.now();
    const uSurge = collectionItem
      ? calculateUserSurge(
          collectionItem.unique_did,
          collectionItem.recent_unique_did,
          collectionItem.min,
          nowMs
        )
      : null;

    const rSurge = collectionItem
      ? calculateRecordSurge(
          collectionItem.count,
          collectionItem.recent_count,
          collectionItem.unique_did,
          collectionItem.recent_unique_did,
          collectionItem.min,
          nowMs
        )
      : null;

    return {
      userSurge: uSurge,
      recordSurge: rSurge,
    };
  }, [collectionItem]);

  useEffect(() => {
    let cancelled = false;
    const fetchStats = async () => {
      try {
        setLoading(true);
        setError(null);
        const url = `${resolveAnalyticsEndpoint('collection_stats')}?collection=${encodeURIComponent(collection)}`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data: Stats[] = await res.json();
        if (cancelled) return;
        setStats(data[0] || null);
      } catch (err: any) {
        if (cancelled) return;
        setError(err.message);
        setStats(null);
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };
    fetchStats();
    return () => {
      cancelled = true;
    };
  }, [collection]);

  useEffect(() => {
    if (tab !== 'cumulative') return;

    let cancelled = false;
    const requestId = cumulativeRequestIdRef.current + 1;
    cumulativeRequestIdRef.current = requestId;

    const fetchCumulativeUsers = async () => {
      setCumulativeLoading(true);
      setCumulativeError(null);
      try {
        const res = await fetch(buildCollectionCumulativeUsersUrl(collection, range));
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as CollectionCumulativeUsersResponse;
        if (cancelled || requestId !== cumulativeRequestIdRef.current) return;
        const isMonthly = range === '365 Days';
        const formatted: FormattedCumulativeRow[] = data.rows.map((row) => ({
          ...row,
          displayDate: formatRelativeDayOffsetLabel(row.day_offset, isMonthly),
        }));
        setCumulativeData(formatted);
      } catch (err: any) {
        if (cancelled || requestId !== cumulativeRequestIdRef.current) return;
        setCumulativeError(err.message);
        setCumulativeData([]);
      } finally {
        if (!cancelled && requestId === cumulativeRequestIdRef.current) {
          setCumulativeLoading(false);
        }
      }
    };
    fetchCumulativeUsers();
    return () => {
      cancelled = true;
    };
  }, [collection, range, tab]);

  return (
    <Box className="w-full">
      <Group justify="space-between" align="center" mb="md" wrap="wrap" gap="sm">
        <SegmentedControl
          value={tab}
          onChange={(val) => setTab(val as StatsTab)}
          radius="md"
          size="xs"
          data={[
            { label: 'Summary', value: 'summary' },
            { label: 'Cumulative Users', value: 'cumulative' },
          ]}
        />

        {tab === 'cumulative' && (
          <SegmentedControl
            value={range}
            onChange={(val) => setRange(val as CollectionCumulativeUsersRange)}
            radius="md"
            size="xs"
            data={[
              { label: 'This Week', value: '7 Days' },
              { label: 'This Month', value: '30 Days' },
              { label: 'This Year', value: '365 Days' },
            ]}
          />
        )}
      </Group>

      {tab === 'summary' && (
        <Stack gap="sm">
          {error && (
            <Alert icon={<IconAlertCircle size={16} />} title="Error" color="red" variant="light">
              {error}
            </Alert>
          )}

          {isLoading && (
            <BarLoader
              width="100%"
              color={colorMode === 'dark' ? '#a6a6a6' : '#3C50E0'}
            />
          )}

          {/* 1. Momentum & Status KPI Cards */}
          <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
            {/* User Surge Card */}
            <Paper
              withBorder
              p="sm"
              radius="md"
              className="bg-white dark:bg-[#182234] border-gray-200 dark:border-gray-800"
            >
              <Group justify="space-between" align="center" mb={4}>
                <Text size="xs" fw={600} c="dimmed" tt="uppercase">
                  User Surge
                </Text>
                <Badge
                  color={userSurge ? 'orange' : 'gray'}
                  variant="light"
                  size="sm"
                  tt="none"
                >
                  {userSurge
                    ? `🔥 ${userSurge.multiplier >= 10 ? Math.round(userSurge.multiplier) : userSurge.multiplier.toFixed(1)}x`
                    : 'Steady'}
                </Badge>
              </Group>
              <Text size="lg" fw={700} c={userSurge ? 'orange.6' : undefined}>
                {userSurge
                  ? `+${Math.round(userSurge.netGain).toLocaleString()} users`
                  : collectionItem
                  ? `${(collectionItem.recent_unique_did || 0).toLocaleString()} users`
                  : '-'}
              </Text>
              <Text size="xs" c="dimmed" mt={2}>
                {userSurge
                  ? `${(collectionItem?.recent_unique_did || 0).toLocaleString()} users in 72h · above baseline`
                  : 'Active in past 72h'}
              </Text>
            </Paper>

            {/* Active Buzz Card */}
            <Paper
              withBorder
              p="sm"
              radius="md"
              className="bg-white dark:bg-[#182234] border-gray-200 dark:border-gray-800"
            >
              <Group justify="space-between" align="center" mb={4}>
                <Text size="xs" fw={600} c="dimmed" tt="uppercase">
                  Active Buzz
                </Text>
                <Badge
                  color={recordSurge ? 'yellow' : 'gray'}
                  variant="light"
                  size="sm"
                  tt="none"
                >
                  {recordSurge
                    ? `⚡️ ${recordSurge.multiplier >= 10 ? Math.round(recordSurge.multiplier) : recordSurge.multiplier.toFixed(1)}x`
                    : 'Steady'}
                </Badge>
              </Group>
              <Text size="lg" fw={700} c={recordSurge ? 'yellow.7' : undefined}>
                {recordSurge
                  ? `+${Math.round(recordSurge.netGainRecords).toLocaleString()} records`
                  : collectionItem
                  ? `${(collectionItem.recent_count || 0).toLocaleString()} records`
                  : '-'}
              </Text>
              <Text size="xs" c="dimmed" mt={2}>
                {recordSurge
                  ? `${(collectionItem?.recent_count || 0).toLocaleString()} records in 72h · above baseline`
                  : 'Created in past 72h'}
              </Text>
            </Paper>
          </SimpleGrid>

          {/* 2. Core Volume & Activity Stats */}
          <Paper
            withBorder
            p="md"
            radius="md"
            className="bg-white dark:bg-[#182234] border-gray-200 dark:border-gray-800"
          >
            <SimpleGrid cols={{ base: 1, sm: 3 }} spacing="md" mb="md">
              <Box>
                <Text size="xs" fw={600} c="dimmed" tt="uppercase">
                  Total DIDs
                </Text>
                <Text size="xl" fw={700} mt={4}>
                  {stats ? stats.unique_did.toLocaleString() : '-'}
                </Text>
              </Box>
              <Box>
                <Text size="xs" fw={600} c="dimmed" tt="uppercase">
                  Records
                </Text>
                <Text size="xl" fw={700} mt={4}>
                  {stats ? stats.unique_rkey.toLocaleString() : '-'}
                </Text>
              </Box>
              <Box>
                <Text size="xs" fw={600} c="dimmed" tt="uppercase">
                  Events
                </Text>
                <Text size="xl" fw={700} mt={4}>
                  {stats ? stats.total_count.toLocaleString() : '-'}
                </Text>
              </Box>
            </SimpleGrid>

            <Box className="border-t border-gray-100 dark:border-gray-800 pt-3">
              <Group justify="space-between" wrap="wrap" gap="md">
                <Box>
                  <Text size="xs" fw={600} c="dimmed" tt="uppercase">
                    First Indexed
                  </Text>
                  <Text size="xs" mt={2}>
                    {stats && stats.min_createdat
                      ? stats.min_createdat.startsWith('1900-01-01')
                        ? 'Backfilled Data'
                        : new Date(stats.min_createdat + 'Z').toLocaleString()
                      : '-'}
                  </Text>
                </Box>
                <Box>
                  <Text size="xs" fw={600} c="dimmed" tt="uppercase">
                    Last Indexed
                  </Text>
                  <Text size="xs" mt={2}>
                    {stats && stats.max_createdat
                      ? stats.max_createdat.startsWith('1900-01-01')
                        ? 'Backfilled Data'
                        : new Date(stats.max_createdat + 'Z').toLocaleString()
                      : '-'}
                  </Text>
                </Box>
              </Group>
            </Box>
          </Paper>
        </Stack>
      )}

      {tab === 'cumulative' && (
        <Paper withBorder radius="md" p="md" className="bg-white dark:bg-[#182234] border-gray-200 dark:border-gray-800">
          {cumulativeError && (
            <Alert icon={<IconAlertCircle size={16} />} title="Error" color="red" variant="light" mb="md">
              {cumulativeError}
            </Alert>
          )}
          <Box pos="relative" h={310}>
            <LoadingOverlay
              visible={isCumulativeLoading}
              overlayProps={{ radius: 'md', blur: 1, opacity: 0.35 }}
              loaderProps={{ size: 'sm', color: 'blue' }}
            />
            {cumulativeData.length > 0 ? (
              <AreaChart
                h={300}
                data={cumulativeData}
                dataKey="displayDate"
                curveType="monotone"
                withGradient
                fillOpacity={0.2}
                strokeWidth={2}
                withLegend
                withDots={false}
                gridAxis="xy"
                valueFormatter={(val) => val.toLocaleString()}
                series={[
                  { name: 'cumulative', label: 'Cumulative Users', color: 'blue.6' },
                  { name: 'new', label: 'New Users', color: 'cyan.5' },
                ]}
              />
            ) : (
              <Box className="h-full flex items-center justify-center text-gray-400">
                {isCumulativeLoading ? '' : 'No data available'}
              </Box>
            )}
          </Box>
        </Paper>
      )}

      <Text size="xs" c="dimmed" ta="center" mt="md">
        Data may take up to 10 minutes to be reflected.
      </Text>
    </Box>
  );
};

export default StatsViewer;
