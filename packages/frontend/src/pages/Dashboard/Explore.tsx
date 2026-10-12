import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Box,
  Text,
  Group,
  Paper,
  Button,
  SegmentedControl,
  SimpleGrid,
  Tooltip,
  Skeleton,
  Loader,
  Alert,
} from '@mantine/core';
import {
  IconSparkles,
  IconFlame,
  IconBolt,
  IconExternalLink,
  IconRefresh,
  IconAlertCircle,
} from '@tabler/icons-react';
import { useCollectionStore } from '../../zustand/collectionStore';
import { Collection } from '../../types/collection';
import { getRegistrantNsid, getWebDomainFromNsid } from '../../logic/domain';
import CollectionFavicon from '../../components/CollectionFavicon';
import CollectionDetail from '../../components/CollectionDetail';
import PageTitle from '../../components/PageTitle';
import { calculateUserSurge, calculateRecordSurge } from '../../utils/surge';

export { calculateUserSurge, calculateRecordSurge };

export type DomainExploreItem = {
  registrantNsid: string;
  webDomain: string;
  collections: Collection[];
  collectionsCount: number;
  totalUsers: number;
  recentUsers: number;

  // 1. User Surge metrics (New User Acquisition)
  maxUserMultiplier: number;
  maxUserNetGain: number;
  maxUserRecentUsers: number;
  maxUserTotalUsers: number;
  maxUserRecentDaily: number;
  maxUserNormalDaily: number;
  topUserSurgeCollection: string;
  userSurgeCollections: string[];

  // 2. Active Buzz metrics (Record Activity Volume with Anti-bot guard)
  maxRecordMultiplier: number;
  maxRecordNetGain: number;
  maxRecordRecentRecords: number;
  maxRecordTotalRecords: number;
  maxRecordRecentDaily: number;
  maxRecordNormalDaily: number;
  maxRecordRecentUsers: number;
  topRecordSurgeCollection: string;
  recordSurgeCollections: string[];

  // 3. New Collections & general
  firstMin: string | null;
  latestMin: string | null;
  lastMax: string | null;
  hasNew: boolean;
};

const Explore: React.FC = () => {
  const { collection: collections, fetchCollection, isLoading, error } = useCollectionStore();
  const navigate = useNavigate();

  const isInitialLoading = (isLoading || collections.length === 0) && !error;
  const isRefreshing = isLoading && collections.length > 0;

  const [selectedCollection, setSelectedCollection] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<'user-surge' | 'active-buzz' | 'new'>('user-surge');
  const [newDaysRange, setNewDaysRange] = useState<'7' | '30' | '90'>('7');
  const [newSortOrder, setNewSortOrder] = useState<'newest' | 'users'>('newest');
  const [displayLimit, setDisplayLimit] = useState(36);

  useEffect(() => {
    if (collections.length === 0) {
      fetchCollection();
    }
  }, [collections.length, fetchCollection]);

  // Reset pagination limit when tab, filters, or sorting change
  useEffect(() => {
    setDisplayLimit(36);
  }, [activeTab, newDaysRange, newSortOrder]);

  const handleOpenDetail = (nsid: string) => {
    setSelectedCollection(nsid);
    setModalOpen(true);
  };

  // Group collections by PSL-aware registrant domain (1 card per domain).
  // Metrics are computed strictly on pre-deduplicated per-collection metrics from the API.
  const allDomainItems = useMemo<DomainExploreItem[]>(() => {
    type DomainAccumulator = {
      registrantNsid: string;
      webDomain: string;
      collections: Collection[];
      collectionsCount: number;
      firstMin: string | null;
      latestMin: string | null;
      lastMax: string | null;
      hasNew: boolean;
    };

    const map = new Map<string, DomainAccumulator>();

    for (const item of collections) {
      if (!item.collection) continue;
      const registrantNsid = getRegistrantNsid(item.collection);
      let group = map.get(registrantNsid);
      if (!group) {
        group = {
          registrantNsid,
          webDomain: getWebDomainFromNsid(item.collection),
          collections: [],
          collectionsCount: 0,
          firstMin: item.min,
          latestMin: item.min,
          lastMax: item.max,
          hasNew: false,
        };
        map.set(registrantNsid, group);
      }

      group.collections.push(item);
      group.collectionsCount += 1;

      if (item.isNew) group.hasNew = true;

      if (item.min && (!group.firstMin || new Date(item.min) < new Date(group.firstMin))) {
        group.firstMin = item.min;
      }
      if (item.min && (!group.latestMin || new Date(item.min) > new Date(group.latestMin))) {
        group.latestMin = item.min;
      }
      if (item.max && (!group.lastMax || new Date(item.max) > new Date(group.lastMax))) {
        group.lastMax = item.max;
      }
    }

    const nowMs = Date.now();
    return Array.from(map.values()).map((group) => {
      let maxTotalUsers = 0;
      let maxRecentUsers = 0;

      // User Surge
      let maxUserMultiplier = 0;
      let maxUserNetGain = 0;
      let maxUserRecentUsers = 0;
      let maxUserTotalUsers = 0;
      let maxUserRecentDaily = 0;
      let maxUserNormalDaily = 0;
      let topUserSurgeCollection = '';
      const userSurgeCollections: string[] = [];

      // Record Activity Surge (Active Buzz)
      let maxRecordMultiplier = 0;
      let maxRecordNetGain = 0;
      let maxRecordRecentRecords = 0;
      let maxRecordTotalRecords = 0;
      let maxRecordRecentDaily = 0;
      let maxRecordNormalDaily = 0;
      let maxRecordRecentUsers = 0;
      let topRecordSurgeCollection = '';
      const recordSurgeCollections: string[] = [];

      for (const col of group.collections) {
        const totalU = col.unique_did || 0;
        const recentU = col.recent_unique_did || 0;
        if (totalU > maxTotalUsers) maxTotalUsers = totalU;
        if (recentU > maxRecentUsers) maxRecentUsers = recentU;

        // 1. User Surge
        const uSurge = calculateUserSurge(col.unique_did, col.recent_unique_did, col.min, nowMs);
        if (uSurge) {
          userSurgeCollections.push(col.collection);
          if (
            uSurge.multiplier > maxUserMultiplier + 0.001 ||
            (Math.abs(uSurge.multiplier - maxUserMultiplier) <= 0.001 && uSurge.netGain > maxUserNetGain)
          ) {
            maxUserMultiplier = uSurge.multiplier;
            maxUserNetGain = uSurge.netGain;
            maxUserRecentUsers = recentU;
            maxUserTotalUsers = totalU;
            maxUserRecentDaily = uSurge.recentDaily;
            maxUserNormalDaily = uSurge.normalDaily;
            topUserSurgeCollection = col.collection;
          }
        }

        // 2. Record Activity Surge (Active Buzz)
        const rSurge = calculateRecordSurge(
          col.count,
          col.recent_count,
          col.unique_did,
          col.recent_unique_did,
          col.min,
          nowMs
        );
        if (rSurge) {
          recordSurgeCollections.push(col.collection);
          if (
            rSurge.multiplier > maxRecordMultiplier + 0.001 ||
            (Math.abs(rSurge.multiplier - maxRecordMultiplier) <= 0.001 && rSurge.netGainRecords > maxRecordNetGain)
          ) {
            maxRecordMultiplier = rSurge.multiplier;
            maxRecordNetGain = rSurge.netGainRecords;
            maxRecordRecentRecords = rSurge.recentRecords;
            maxRecordTotalRecords = rSurge.totalRecords;
            maxRecordRecentDaily = rSurge.recentDailyRecords;
            maxRecordNormalDaily = rSurge.normalDailyRecords;
            maxRecordRecentUsers = rSurge.recentUsers;
            topRecordSurgeCollection = col.collection;
          }
        }
      }

      return {
        registrantNsid: group.registrantNsid,
        webDomain: group.webDomain,
        collections: group.collections,
        collectionsCount: group.collectionsCount,
        totalUsers: maxTotalUsers,
        recentUsers: maxRecentUsers,
        maxUserMultiplier,
        maxUserNetGain,
        maxUserRecentUsers,
        maxUserTotalUsers,
        maxUserRecentDaily,
        maxUserNormalDaily,
        topUserSurgeCollection,
        userSurgeCollections,
        maxRecordMultiplier,
        maxRecordNetGain,
        maxRecordRecentRecords,
        maxRecordTotalRecords,
        maxRecordRecentDaily,
        maxRecordNormalDaily,
        maxRecordRecentUsers,
        topRecordSurgeCollection,
        recordSurgeCollections,
        firstMin: group.firstMin,
        latestMin: group.latestMin,
        lastMax: group.lastMax,
        hasNew: group.hasNew,
      };
    });
  }, [collections]);

  // Tab 1: User Surge (New Users Gained)
  const userSurgeItems = useMemo(() => {
    return allDomainItems
      .filter((item) => item.userSurgeCollections.length > 0)
      .sort((a, b) => b.maxUserMultiplier - a.maxUserMultiplier || b.maxUserNetGain - a.maxUserNetGain || b.maxUserRecentUsers - a.maxUserRecentUsers);
  }, [allDomainItems]);

  // Tab 2: Active Buzz (Record Activity Surge)
  const activeBuzzItems = useMemo(() => {
    return allDomainItems
      .filter((item) => item.recordSurgeCollections.length > 0)
      .sort((a, b) => b.maxRecordMultiplier - a.maxRecordMultiplier || b.maxRecordNetGain - a.maxRecordNetGain || b.maxRecordRecentRecords - a.maxRecordRecentRecords);
  }, [allDomainItems]);

  // Tab 3: New Arrivals (Domains with any collection created within cutoff)
  const newItems = useMemo(() => {
    const days = parseInt(newDaysRange, 10);
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

    const filtered = allDomainItems.filter((item) => {
      if (!item.latestMin || item.latestMin.startsWith('1900-01-01')) return false;
      const time = new Date(item.latestMin.endsWith('Z') ? item.latestMin : `${item.latestMin}Z`).getTime();
      return !isNaN(time) && time >= cutoff;
    });

    if (newSortOrder === 'users') {
      return filtered.sort((a, b) => b.totalUsers - a.totalUsers || b.recentUsers - a.recentUsers);
    }

    return filtered.sort((a, b) => {
      const timeA = new Date(a.latestMin!.endsWith('Z') ? a.latestMin! : `${a.latestMin!}Z`).getTime();
      const timeB = new Date(b.latestMin!.endsWith('Z') ? b.latestMin! : `${b.latestMin!}Z`).getTime();
      return timeB - timeA;
    });
  }, [allDomainItems, newDaysRange, newSortOrder]);

  const activeItemList = useMemo(() => {
    if (activeTab === 'user-surge') return userSurgeItems;
    if (activeTab === 'active-buzz') return activeBuzzItems;
    return newItems;
  }, [activeTab, userSurgeItems, activeBuzzItems, newItems]);

  const displayedItems = useMemo(() => {
    return activeItemList.slice(0, displayLimit);
  }, [activeItemList, displayLimit]);

  const sentinelRef = useRef<HTMLDivElement | null>(null);

  // Infinite scroll observer across all tabs
  useEffect(() => {
    const target = sentinelRef.current;
    if (!target) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          setDisplayLimit((prev) => {
            if (prev < activeItemList.length) {
              return prev + 36;
            }
            return prev;
          });
        }
      },
      { rootMargin: '300px' }
    );

    observer.observe(target);
    return () => {
      observer.disconnect();
    };
  }, [activeItemList.length]);

  return (
    <>
      <PageTitle title="Explore | atproto Dashboard" />

      {selectedCollection && (
        <CollectionDetail
          open={modalOpen}
          collection={selectedCollection}
          onClose={() => {
            setModalOpen(false);
            setSelectedCollection(null);
          }}
          onOk={() => {
            setModalOpen(false);
            setSelectedCollection(null);
          }}
          onCancel={() => {
            setModalOpen(false);
            setSelectedCollection(null);
          }}
        />
      )}

      <Box className="space-y-6">
        {/* Controls Bar: 3 Tabs (User Surge / Active Buzz / New Collections) + Filters */}
        <Group justify="space-between" align="center" wrap="wrap" gap="md">
          <Group gap="sm" align="center" wrap="wrap">
            <SegmentedControl
              value={activeTab}
              onChange={(val) => setActiveTab(val as 'user-surge' | 'active-buzz' | 'new')}
              radius="md"
              size="sm"
              data={[
                {
                  value: 'user-surge',
                  label: (
                    <Group gap={6} wrap="nowrap">
                      <IconFlame size={16} className="text-orange-500" />
                      <span className="font-semibold">User Surge</span>
                      <span className="text-xs font-mono opacity-60">
                        {isInitialLoading ? '—' : userSurgeItems.length.toLocaleString()}
                      </span>
                    </Group>
                  ),
                },
                {
                  value: 'active-buzz',
                  label: (
                    <Group gap={6} wrap="nowrap">
                      <IconBolt size={16} className="text-amber-500" />
                      <span className="font-semibold">Active Buzz</span>
                      <span className="text-xs font-mono opacity-60">
                        {isInitialLoading ? '—' : activeBuzzItems.length.toLocaleString()}
                      </span>
                    </Group>
                  ),
                },
                {
                  value: 'new',
                  label: (
                    <Group gap={6} wrap="nowrap">
                      <IconSparkles size={16} className="text-teal-500" />
                      <span className="font-semibold">New Collections</span>
                      <span className="text-xs font-mono opacity-60">
                        {isInitialLoading ? '—' : newItems.length.toLocaleString()}
                      </span>
                    </Group>
                  ),
                },
              ]}
            />

            {activeTab === 'new' && (
              <Group gap="xs" wrap="wrap">
                <SegmentedControl
                  size="xs"
                  radius="md"
                  value={newDaysRange}
                  onChange={(val) => setNewDaysRange(val as '7' | '30' | '90')}
                  data={[
                    { label: 'Past 7 Days', value: '7' },
                    { label: 'Past 30 Days', value: '30' },
                    { label: 'Past 90 Days', value: '90' },
                  ]}
                />
                <SegmentedControl
                  size="xs"
                  radius="md"
                  value={newSortOrder}
                  onChange={(val) => setNewSortOrder(val as 'newest' | 'users')}
                  data={[
                    { label: 'Newest First', value: 'newest' },
                    { label: 'Most Users', value: 'users' },
                  ]}
                />
              </Group>
            )}
          </Group>

          <Tooltip label="Fetch latest collections and analytics" withArrow position="bottom-end">
            <Button
              variant="default"
              size="xs"
              radius="md"
              leftSection={<IconRefresh size={14} />}
              loading={isLoading}
              onClick={() => fetchCollection()}
            >
              Reload
            </Button>
          </Tooltip>
        </Group>

        {error && (
          <Alert icon={<IconAlertCircle size={16} />} title="Error" color="red" variant="light" radius="md">
            <Group justify="space-between" align="center">
              <Text size="sm">{error}</Text>
              <Button size="xs" variant="light" color="red" onClick={() => fetchCollection()}>
                Retry
              </Button>
            </Group>
          </Alert>
        )}

        {isRefreshing && (
          <Paper
            withBorder
            radius="md"
            p="xs"
            className="bg-blue-50/50 dark:bg-blue-950/20 border-blue-200 dark:border-blue-900"
          >
            <Group justify="center" align="center" gap="xs">
              <Loader size="xs" color="blue" />
              <Text size="xs" c="blue.7" fw={500}>
                Updating atproto collections and recalculating surge metrics...
              </Text>
            </Group>
          </Paper>
        )}

        {isInitialLoading ? (
          <>
            <Paper
              withBorder
              radius="md"
              p="md"
              className="bg-white dark:bg-[#182234] border-gray-200 dark:border-gray-800"
            >
              <Group justify="center" align="center" gap="sm" py="xs">
                <Loader size="sm" color="blue" />
                <Box>
                  <Text size="sm" fw={600} className="text-gray-900 dark:text-gray-100">
                    Loading atproto collections & surge metrics
                  </Text>
                  <Text size="xs" c="dimmed">
                    Fetching live data from ClickHouse analytics API and processing trend anomalies...
                  </Text>
                </Box>
              </Group>
            </Paper>

            <SimpleGrid cols={{ base: 1, sm: 2, lg: 3, xl: 4 }} spacing="md">
              {Array.from({ length: 8 }).map((_, index) => (
                <Paper
                  key={index}
                  withBorder
                  p="md"
                  radius="lg"
                  className="bg-white dark:bg-[#182234] border-gray-200 dark:border-gray-800 space-y-3"
                >
                  <Group justify="space-between" align="center">
                    <Group gap="xs">
                      <Skeleton height={28} width={28} circle />
                      <Box>
                        <Skeleton height={14} width={100} radius="sm" mb={4} />
                        <Skeleton height={10} width={65} radius="sm" />
                      </Box>
                    </Group>
                    <Skeleton height={22} width={45} radius="md" />
                  </Group>

                  <Skeleton height={12} width={75} radius="sm" />

                  <Group gap={6}>
                    <Skeleton height={22} width={120} radius="sm" />
                    <Skeleton height={22} width={90} radius="sm" />
                  </Group>

                  <Skeleton height={11} width="70%" radius="sm" mt="xs" />
                </Paper>
              ))}
            </SimpleGrid>
          </>
        ) : displayedItems.length === 0 ? (
          <Paper
            withBorder
            radius="md"
            p="xl"
            ta="center"
            className="bg-white dark:bg-[#182234] border-gray-200 dark:border-gray-800 text-gray-400"
          >
            <Text size="sm">No collections found matching this filter.</Text>
          </Paper>
        ) : (
          <SimpleGrid cols={{ base: 1, sm: 2, lg: 3, xl: 4 }} spacing="md">
          {displayedItems.map((item) => {
            const days = parseInt(newDaysRange, 10);
            const newCutoff = Date.now() - days * 24 * 60 * 60 * 1000;
            const nowMs = Date.now();

            const checkIsNew = (col: Collection) => {
              if (!col.min || col.min.startsWith('1900-01-01')) return false;
              const time = new Date(col.min.endsWith('Z') ? col.min : `${col.min}Z`).getTime();
              return !isNaN(time) && time >= newCutoff;
            };

            const newCollectionsCount = item.collections.filter(checkIsNew).length;

            const checkIsUserSurge = (col: Collection) => {
              return item.userSurgeCollections.includes(col.collection);
            };

            const checkIsRecordSurge = (col: Collection) => {
              return item.recordSurgeCollections.includes(col.collection);
            };

            const displayedCollections = (
              activeTab === 'new'
                ? [...item.collections].sort((a, b) => {
                    const isNewA = checkIsNew(a) ? 1 : 0;
                    const isNewB = checkIsNew(b) ? 1 : 0;
                    if (isNewB !== isNewA) return isNewB - isNewA;
                    const timeA = a.min ? new Date(a.min.endsWith('Z') ? a.min : `${a.min}Z`).getTime() : 0;
                    const timeB = b.min ? new Date(b.min.endsWith('Z') ? b.min : `${b.min}Z`).getTime() : 0;
                    return timeB - timeA;
                  })
                : activeTab === 'active-buzz'
                ? [...item.collections].sort((a, b) => {
                    const rA = checkIsRecordSurge(a) ? 1 : 0;
                    const rB = checkIsRecordSurge(b) ? 1 : 0;
                    if (rB !== rA) return rB - rA;
                    const sA = calculateRecordSurge(a.count, a.recent_count, a.unique_did, a.recent_unique_did, a.min, nowMs);
                    const sB = calculateRecordSurge(b.count, b.recent_count, b.unique_did, b.recent_unique_did, b.min, nowMs);
                    const mA = sA ? sA.multiplier : 0;
                    const mB = sB ? sB.multiplier : 0;
                    return mB - mA || (b.recent_count || 0) - (a.recent_count || 0);
                  })
                : [...item.collections].sort((a, b) => {
                    const uA = checkIsUserSurge(a) ? 1 : 0;
                    const uB = checkIsUserSurge(b) ? 1 : 0;
                    if (uB !== uA) return uB - uA;
                    const sA = calculateUserSurge(a.unique_did, a.recent_unique_did, a.min, nowMs);
                    const sB = calculateUserSurge(b.unique_did, b.recent_unique_did, b.min, nowMs);
                    const mA = sA ? sA.multiplier : 0;
                    const mB = sB ? sB.multiplier : 0;
                    const gA = sA ? sA.netGain : 0;
                    const gB = sB ? sB.netGain : 0;
                    return mB - mA || gB - gA || (b.recent_unique_did || 0) - (a.recent_unique_did || 0);
                  })
            ).slice(0, 3);

            return (
              <Paper
                key={item.registrantNsid}
                withBorder
                p="md"
                radius="lg"
                onClick={() => navigate(`/collections?search=${encodeURIComponent(item.registrantNsid)}`)}
                className="group cursor-pointer bg-white dark:bg-[#182234] hover:bg-gray-50/70 dark:hover:bg-[#1f2c42] border-gray-200 dark:border-gray-800 transition-all hover:shadow-md flex flex-col justify-between"
              >
                <Box>
                  {/* Top Row: Favicon, Registrant NSID, Web domain, Badge, and Visit link */}
                  <Group justify="space-between" align="flex-start" wrap="nowrap" mb="xs">
                    <Group gap="xs" wrap="nowrap" className="min-w-0">
                      <CollectionFavicon domain={item.webDomain} size={28} />
                      <Box className="min-w-0">
                        <Text fw={700} size="sm" className="font-mono text-gray-900 dark:text-gray-100 truncate">
                          {item.registrantNsid}
                        </Text>
                        <Text size="11px" c="dimmed" className="font-mono truncate">
                          {item.webDomain}
                        </Text>
                      </Box>
                    </Group>

                    <Group gap="xs" align="center" wrap="nowrap">
                      {activeTab === 'user-surge' ? (
                        <Tooltip
                          label={
                            <Box className="text-xs space-y-0.5">
                              <Text size="xs" fw={700} c="orange.4">
                                🔥 {item.maxUserMultiplier >= 10 ? Math.round(item.maxUserMultiplier) : item.maxUserMultiplier.toFixed(1)}x User Surge · 72h
                              </Text>
                              <Text size="11px" className="font-mono text-gray-200">
                                {item.topUserSurgeCollection}
                              </Text>
                              <Text size="11px" c="dimmed">
                                Recent: {item.maxUserRecentDaily.toFixed(1)} users/day vs Normal: {item.maxUserNormalDaily.toFixed(1)} users/day
                              </Text>
                              <Text size="11px" c="orange.3" fw={500}>
                                +{Math.round(item.maxUserNetGain)} net surge users above baseline
                              </Text>
                              <Text size="11px" c="dimmed">
                                +{item.maxUserRecentUsers} new in 72h · {item.maxUserTotalUsers} total users
                              </Text>
                            </Box>
                          }
                          withArrow
                          position="top"
                        >
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-orange-100 text-orange-700 dark:bg-orange-950/70 dark:text-orange-300 border border-orange-200 dark:border-orange-800/60 cursor-help">
                            🔥 {item.maxUserMultiplier >= 10 ? Math.round(item.maxUserMultiplier) : item.maxUserMultiplier.toFixed(1)}x
                          </span>
                        </Tooltip>
                      ) : activeTab === 'active-buzz' ? (
                        <Tooltip
                          label={
                            <Box className="text-xs space-y-0.5">
                              <Text size="xs" fw={700} className="text-amber-400">
                                ⚡️ {item.maxRecordMultiplier >= 10 ? Math.round(item.maxRecordMultiplier) : item.maxRecordMultiplier.toFixed(1)}x Record Buzz · 72h
                              </Text>
                              <Text size="11px" className="font-mono text-gray-200">
                                {item.topRecordSurgeCollection}
                              </Text>
                              <Text size="11px" c="dimmed">
                                Recent: {Math.round(item.maxRecordRecentDaily).toLocaleString()} records/day vs Normal: {Math.round(item.maxRecordNormalDaily).toLocaleString()} records/day
                              </Text>
                              <Text size="11px" className="text-amber-300" fw={500}>
                                +{Math.round(item.maxRecordNetGain).toLocaleString()} records above baseline
                              </Text>
                              <Text size="11px" c="dimmed">
                                {item.maxRecordRecentRecords.toLocaleString()} records across {item.maxRecordRecentUsers} active users
                              </Text>
                            </Box>
                          }
                          withArrow
                          position="top"
                        >
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-amber-100 text-amber-700 dark:bg-amber-950/70 dark:text-amber-300 border border-amber-200 dark:border-amber-800/60 cursor-help">
                            ⚡️ {item.maxRecordMultiplier >= 10 ? Math.round(item.maxRecordMultiplier) : item.maxRecordMultiplier.toFixed(1)}x
                          </span>
                        </Tooltip>
                      ) : (
                        <Tooltip
                          label={
                            item.latestMin && !item.latestMin.startsWith('1900-01-01')
                              ? `${newCollectionsCount} new ${newCollectionsCount === 1 ? 'schema' : 'schemas'} · Latest on ${new Date(item.latestMin.endsWith('Z') ? item.latestMin : `${item.latestMin}Z`).toLocaleDateString()}`
                              : 'Recently discovered collection'
                          }
                          withArrow
                          position="top"
                        >
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-teal-100 text-teal-700 dark:bg-teal-950/70 dark:text-teal-300 border border-teal-200 dark:border-teal-800/60 cursor-help">
                            <IconSparkles size={12} />
                            New
                          </span>
                        </Tooltip>
                      )}

                      <a
                        href={`https://${item.webDomain}/`}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        className="text-gray-400 hover:text-blue-500 transition-colors p-1"
                        title={`Visit https://${item.webDomain}`}
                      >
                        <IconExternalLink size={15} />
                      </a>
                    </Group>
                  </Group>


                  {/* Bottom Section: Collections Count & Full NSIDs list */}
                  <Box pt="xs" mt="xs" className="border-t border-gray-100 dark:border-gray-800/80">
                    <Text size="xs" fw={600} c="dimmed" mb={4}>
                      {activeTab === 'new' ? (
                        item.collectionsCount === 1 ? (
                          <>
                            <span className="text-teal-600 dark:text-teal-400 font-bold">1 new</span>
                            <span> collection</span>
                          </>
                        ) : (
                          <>
                            <span className="text-teal-600 dark:text-teal-400 font-bold">
                              {newCollectionsCount} new
                            </span>
                            <span> out of {item.collectionsCount} collections</span>
                          </>
                        )
                      ) : (
                        `${item.collectionsCount} ${item.collectionsCount === 1 ? 'collection' : 'collections'}`
                      )}
                    </Text>

                    {/* Full NSID strings list */}
                    <div className="space-y-1">
                      {displayedCollections.map((col) => {
                        const isUserSurge = activeTab === 'user-surge' && checkIsUserSurge(col);
                        const isRecordSurge = activeTab === 'active-buzz' && checkIsRecordSurge(col);
                        const isNewCollection = activeTab === 'new' && checkIsNew(col);

                        let colorClass = 'font-mono text-gray-600 dark:text-gray-400 truncate hover:text-blue-600 dark:hover:text-blue-400 transition-colors';
                        if (isUserSurge) {
                          colorClass = 'font-mono text-orange-600 dark:text-orange-400 font-semibold truncate hover:text-orange-700 dark:hover:text-orange-300 transition-colors cursor-help';
                        } else if (isRecordSurge) {
                          colorClass = 'font-mono text-amber-600 dark:text-amber-400 font-semibold truncate hover:text-amber-700 dark:hover:text-amber-300 transition-colors cursor-help';
                        } else if (isNewCollection) {
                          colorClass = 'font-mono text-teal-600 dark:text-teal-400 font-semibold truncate hover:text-teal-700 dark:hover:text-teal-300 transition-colors cursor-help';
                        }

                        const recentU = col.recent_unique_did || 0;
                        const totalU = col.unique_did || 0;
                        const recentR = col.recent_count || 0;

                        let tooltipLabel: React.ReactNode = null;
                        if (isUserSurge) {
                          const uSurge = calculateUserSurge(col.unique_did, col.recent_unique_did, col.min, nowMs);
                          if (uSurge) {
                            const multStr = uSurge.multiplier >= 10 ? `${Math.round(uSurge.multiplier)}x` : `${uSurge.multiplier.toFixed(1)}x`;
                            const netStr = Math.round(uSurge.netGain);
                            tooltipLabel = `🔥 ${multStr} user surge · +${netStr} above baseline · Recent: ${uSurge.recentDaily.toFixed(1)}/day vs Normal: ${uSurge.normalDaily.toFixed(1)}/day · +${recentU} new in 72h · ${totalU} total`;
                          }
                        } else if (isRecordSurge) {
                          const rSurge = calculateRecordSurge(col.count, col.recent_count, col.unique_did, col.recent_unique_did, col.min, nowMs);
                          if (rSurge) {
                            const multStr = rSurge.multiplier >= 10 ? `${Math.round(rSurge.multiplier)}x` : `${rSurge.multiplier.toFixed(1)}x`;
                            const netStr = Math.round(rSurge.netGainRecords).toLocaleString();
                            tooltipLabel = `⚡️ ${multStr} record buzz · +${netStr} records above baseline · Recent: ${Math.round(rSurge.recentDailyRecords).toLocaleString()}/day vs Normal: ${Math.round(rSurge.normalDailyRecords).toLocaleString()}/day · ${recentR.toLocaleString()} records across ${rSurge.recentUsers} users`;
                          }
                        } else if (isNewCollection && col.min && !col.min.startsWith('1900-01-01')) {
                          const createdDate = new Date(col.min.endsWith('Z') ? col.min : `${col.min}Z`).toLocaleDateString();
                          tooltipLabel = `Created: ${createdDate} · ${totalU} users`;
                        }

                        const textNode = (
                          <Text
                            key={col.collection}
                            size="xs"
                            className={colorClass}
                            onClick={(e) => {
                              e.stopPropagation();
                              handleOpenDetail(col.collection);
                            }}
                          >
                            {col.collection}
                          </Text>
                        );

                        if (tooltipLabel) {
                          return (
                            <Tooltip key={col.collection} label={tooltipLabel} withArrow position="top">
                              {textNode}
                            </Tooltip>
                          );
                        }

                        return textNode;
                      })}
                      {item.collectionsCount > 3 && (
                        <Text size="11px" c="dimmed" className="font-mono pt-0.5">
                          +{item.collectionsCount - 3} more
                        </Text>
                      )}
                    </div>
                  </Box>
                </Box>
              </Paper>
            );
          })}
          </SimpleGrid>
        )}

        {/* Infinite Scroll Sentinel & Count Indicator */}
        {!isInitialLoading && displayedItems.length > 0 && (
          <Box mt="xl" className="text-center py-4">
            <Text size="xs" c="dimmed">
              Showing {displayedItems.length} of {activeItemList.length.toLocaleString()}{' '}
              {activeTab === 'user-surge'
                ? 'user-surge collections'
                : activeTab === 'active-buzz'
                ? 'active-buzz collections'
                : `new collections in the past ${newDaysRange} days`}
            </Text>

            {/* Sentinel element observed for infinite scroll across all tabs */}
            {displayedItems.length < activeItemList.length && (
              <div ref={sentinelRef} className="h-12 flex items-center justify-center mt-2">
                <Text size="xs" c="dimmed" className="animate-pulse">
                  Loading more...
                </Text>
              </div>
            )}
          </Box>
        )}
      </Box>
    </>
  );
};

export default Explore;
