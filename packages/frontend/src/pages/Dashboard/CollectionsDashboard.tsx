import React, { useEffect, useState, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Box,
  Text,
  Badge,
  Group,
  Paper,
  Button,
  SegmentedControl,
  Tooltip,
  Alert,
  SimpleGrid,
  ThemeIcon,
} from '@mantine/core';
import {
  IconRefresh,
  IconAlertCircle,
  IconTable,
  IconChartLine,
  IconFolders,
  IconUsers,
  IconClock,
  IconWorldWww,
} from '@tabler/icons-react';
import { useModeStore } from '../../zustand/preference';
import { useCollectionStore } from '../../zustand/collectionStore';
import { Collection } from '../../types/collection';
import CollectionList from '../../components/CollectionList';
import MantineDailyChart from '../../components/Charts/MantineDailyChart';
import PageTitle from '../../components/PageTitle';
import { validTldSet, getRegistrantNsid } from '../../logic/domain';

function epochUsToMinutesAgo(cursor: number): number {
  if (!cursor || cursor <= 0) return 0;
  const cursorDate = new Date(cursor / 1000);
  const now = new Date();
  const diffInMs = now.getTime() - cursorDate.getTime();
  const diffInMinutes = Math.floor(diffInMs / (1000 * 60));
  return Math.max(0, diffInMinutes);
}

const CollectionsDashboard: React.FC = () => {
  const {
    collection: rawCollections,
    fetchCollection,
    isLoading: isGlobalLoading,
  } = useCollectionStore();

  const [searchParams] = useSearchParams();
  const hasSearchParam = Boolean(searchParams.get('search')?.trim());

  const [viewMode, setViewMode] = useState<'table' | 'charts'>('table');
  const [didCount, setDidCount] = useState<number>(0);
  const [cursor, setCursor] = useState<number>(0);
  const [nsidLv2Count, setNsidLv2Count] = useState<number>(0);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const exceptCollectionWithTransaction = useModeStore((state) => state.exceptCollectionWithTransaction);
  const exceptInvalidTLDs = useModeStore((state) => state.exceptInvalidTLDs);

  // Compute filtered collections and count metrics
  const { filteredCollections, newCount } = useMemo(() => {
    const list: Collection[] = [];
    let newColCount = 0;
    const now = Date.now();
    const threeDaysAgo = now - 72 * 60 * 60 * 1000;

    for (const item of rawCollections) {
      if (exceptCollectionWithTransaction && item.collection.startsWith('ge.shadowcaster')) {
        continue;
      }
      if (exceptInvalidTLDs) {
        const tld = item.collection.split('.')[0].toLowerCase();
        if (!validTldSet.has(tld)) {
          continue;
        }
      }

      const itemMinTime = item.min ? new Date(item.min.endsWith('Z') ? item.min : `${item.min}Z`).getTime() : 0;
      const isNew = itemMinTime > threeDaysAgo;
      if (isNew) {
        newColCount++;
      }

      list.push({
        ...item,
        isNew,
      });
    }

    return { filteredCollections: list, newCount: newColCount };
  }, [rawCollections, exceptCollectionWithTransaction, exceptInvalidTLDs]);

  // Compute distinct registrant namespaces
  useEffect(() => {
    const distinctNsidLv2 = new Set<string>();
    for (const item of filteredCollections) {
      if (item.collection) {
        const nsid = getRegistrantNsid(item.collection);
        if (exceptCollectionWithTransaction && nsid.startsWith('ge.shadowcaster')) {
          continue;
        }
        if (exceptInvalidTLDs) {
          const tld = nsid.split('.')[0].toLowerCase();
          if (!validTldSet.has(tld)) {
            continue;
          }
        }
        distinctNsidLv2.add(nsid);
      }
    }
    setNsidLv2Count(distinctNsidLv2.size);
  }, [filteredCollections, exceptCollectionWithTransaction, exceptInvalidTLDs]);

  // Load ancillary metadata (total DIDs, cursor sync delay)
  const loadMetadata = async () => {
    setIsLoading(true);
    setError(null);
    try {
      await fetchCollection();

      const [cursorRes, didRes] = await Promise.allSettled([
        fetch('https://collectiondata.usounds.work/cursor?service=eq.collection&select=service,cursor'),
        fetch('https://collectiondata.usounds.work/unique_did_count_view'),
      ]);

      if (cursorRes.status === 'fulfilled' && cursorRes.value.ok) {
        const cursorData = await cursorRes.value.json();
        if (cursorData[0]?.cursor) {
          setCursor(cursorData[0].cursor);
        }
      }

      if (didRes.status === 'fulfilled' && didRes.value.ok) {
        const didData = await didRes.value.json();
        if (didData[0]?.unique_did_count) {
          setDidCount(didData[0].unique_did_count);
        }
      }
    } catch (err: any) {
      setError(err.message || 'Failed to refresh metadata');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadMetadata();
  }, []);

  const cursorDelayMinutes = epochUsToMinutesAgo(cursor);

  return (
    <>
      <PageTitle title="Collections | atproto Dashboard" />

      {error && (
        <Alert
          icon={<IconAlertCircle size={16} />}
          title="Error"
          color="red"
          variant="light"
          radius="md"
          className="mb-4"
        >
          {error}
        </Alert>
      )}

      {/* 4 KPI Summary Cards (Network-wide overall metrics - hidden when filtering by search parameter) */}
      {!hasSearchParam && (
        <Box className="w-full mb-6">
          <Group justify="space-between" align="center" wrap="wrap" gap="xs" mb="sm">
            <Group gap="xs" align="center">
              <ThemeIcon size={24} radius="sm" variant="light" color="blue">
                <IconWorldWww size={14} />
              </ThemeIcon>
              <Text size="xs" fw={700} c="dimmed" className="uppercase tracking-wider">
                Network Overall Overview (All Collections)
              </Text>
            </Group>
          </Group>

          <SimpleGrid cols={{ base: 1, sm: 2, lg: 4 }} spacing="md">
            <Paper withBorder p="md" radius="lg" className="bg-white dark:bg-[#182234]">
              <Group justify="space-between" align="flex-start">
                <Box>
                  <Text size="xs" c="dimmed" fw={600} className="uppercase tracking-wider">
                    Network Collections
                  </Text>
                  <Text fw={700} size="xl" className="font-mono mt-1 text-gray-900 dark:text-gray-100">
                    {filteredCollections.length > 0 ? filteredCollections.length.toLocaleString() : 'Loading...'}
                  </Text>
                  {newCount > 0 && (
                    <Badge size="xs" color="teal" variant="light" radius="sm" className="mt-2 font-bold">
                      +{newCount.toLocaleString()} New (72h)
                    </Badge>
                  )}
                </Box>
                <ThemeIcon size={38} radius="md" variant="light" color="blue">
                  <IconFolders size={20} />
                </ThemeIcon>
              </Group>
            </Paper>

            <Paper withBorder p="md" radius="lg" className="bg-white dark:bg-[#182234]">
              <Group justify="space-between" align="flex-start">
                <Box>
                  <Text size="xs" c="dimmed" fw={600} className="uppercase tracking-wider">
                    Network Namespaces
                  </Text>
                  <Text fw={700} size="xl" className="font-mono mt-1 text-gray-900 dark:text-gray-100">
                    {nsidLv2Count > 0 ? nsidLv2Count.toLocaleString() : 'Loading...'}
                  </Text>
                  <Text size="11px" c="dimmed" className="mt-2">
                    Distinct apex domains (overall)
                  </Text>
                </Box>
                <ThemeIcon size={38} radius="md" variant="light" color="cyan">
                  <IconWorldWww size={20} />
                </ThemeIcon>
              </Group>
            </Paper>

            <Paper withBorder p="md" radius="lg" className="bg-white dark:bg-[#182234]">
              <Group justify="space-between" align="flex-start">
                <Box>
                  <Text size="xs" c="dimmed" fw={600} className="uppercase tracking-wider">
                    Network Users (DIDs)
                  </Text>
                  <Text fw={700} size="xl" className="font-mono mt-1 text-gray-900 dark:text-gray-100">
                    {didCount > 0 ? didCount.toLocaleString() : 'Loading...'}
                  </Text>
                  <Text size="11px" c="dimmed" className="mt-2">
                    Observed record creators (overall)
                  </Text>
                </Box>
                <ThemeIcon size={38} radius="md" variant="light" color="indigo">
                  <IconUsers size={20} />
                </ThemeIcon>
              </Group>
            </Paper>

            <Paper withBorder p="md" radius="lg" className="bg-white dark:bg-[#182234]">
              <Group justify="space-between" align="flex-start">
                <Box>
                  <Text size="xs" c="dimmed" fw={600} className="uppercase tracking-wider">
                    Firehose Sync Lag
                  </Text>
                  <Text fw={700} size="xl" className="font-mono mt-1 text-gray-900 dark:text-gray-100">
                    {cursorDelayMinutes === 0 ? '0 min' : `${cursorDelayMinutes.toLocaleString()} min`}
                  </Text>
                  <Badge
                    size="xs"
                    color={cursorDelayMinutes <= 5 ? 'teal' : cursorDelayMinutes <= 30 ? 'yellow' : 'red'}
                    variant="light"
                    radius="sm"
                    className="mt-2 font-bold"
                  >
                    {cursorDelayMinutes <= 5 ? 'Healthy' : 'Delayed'}
                  </Badge>
                </Box>
                <ThemeIcon
                  size={38}
                  radius="md"
                  variant="light"
                  color={cursorDelayMinutes <= 5 ? 'teal' : 'yellow'}
                >
                  <IconClock size={20} />
                </ThemeIcon>
              </Group>
            </Paper>
          </SimpleGrid>
        </Box>
      )}

      {/* View Switcher: Collections Table | Activity Charts + Reload Action */}
      <Box className="w-full mb-6">
        <Group justify="space-between" align="center" mb="md" wrap="wrap" gap="sm">
          <SegmentedControl
            value={viewMode}
            onChange={(val) => setViewMode(val as 'table' | 'charts')}
            radius="md"
            size="sm"
            data={[
              {
                value: 'table',
                label: (
                  <Group gap={6} wrap="nowrap">
                    <IconTable size={16} />
                    <span className="font-semibold">Collections Table</span>
                  </Group>
                ),
              },
              {
                value: 'charts',
                label: (
                  <Group gap={6} wrap="nowrap">
                    <IconChartLine size={16} />
                    <span className="font-semibold">Activity Charts</span>
                  </Group>
                ),
              },
            ]}
          />

          <Tooltip label="Fetch latest collections and analytics" withArrow position="bottom-end">
            <Button
              onClick={() => loadMetadata()}
              loading={isLoading || isGlobalLoading}
              leftSection={<IconRefresh size={14} />}
              variant="default"
              size="xs"
              radius="md"
            >
              Reload
            </Button>
          </Tooltip>
        </Group>

        {/* View Content */}
        {viewMode === 'table' && (
          <Box className="w-full">
            <CollectionList collections={filteredCollections} />
          </Box>
        )}

        {viewMode === 'charts' && (
          <Box className="w-full">
            <div className="grid grid-cols-12 gap-4 md:gap-6">
              <MantineDailyChart metric="collections" newTitle="New" activeTitle="Active" title="Daily Collections" />
              <MantineDailyChart metric="users" newTitle="New" activeTitle="Active" title="Daily Users" />
            </div>
          </Box>
        )}
      </Box>
    </>
  );
};

export default CollectionsDashboard;
