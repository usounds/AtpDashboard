import React, { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Paper,
  Table,
  TextInput,
  Text,
  Group,
  Badge,
  UnstyledButton,
  Box,
  Pagination,
  Select,
  SegmentedControl,
  Tooltip,
  CopyButton,
  ActionIcon,
  CloseButton,
  Button,
  Checkbox,
} from '@mantine/core';
import {
  IconSearch,
  IconChevronUp,
  IconChevronDown,
  IconSelector,
  IconCopy,
  IconCheck,
  IconChevronRight,
  IconFilterOff,
  IconExternalLink,
  IconInfoCircle,
  IconCornerDownRight,
} from '@tabler/icons-react';
import { Collection } from '../types/collection';
import CollectionDetail from './CollectionDetail';
import CollectionFavicon from './CollectionFavicon';
import { getRegistrantNsid, getWebDomainFromNsid } from '../logic/domain';
import DatePickerRange from './Forms/DatePicker/DatePickerRange';
import { useModeStore } from '../zustand/preference';

interface CollectionListProps {
  collections: Collection[];
}

type SortKey = 'collection' | 'count' | 'recent_count' | 'momentum' | 'min' | 'max';
type TableMode = 'grouped' | 'flat';

export type DomainGroup = {
  registrantNsid: string;
  webDomain: string;
  items: Collection[];
  recentCount: number;
  count: number;
  uniqueDid: number;
  firstMin: string | null;
  lastMax: string | null;
  hasNew: boolean;
};

function splitNsid(collection: string): { namespace: string; name: string } {
  const lastDot = collection.lastIndexOf('.');
  if (lastDot === -1) {
    return { namespace: '', name: collection };
  }
  return {
    namespace: collection.slice(0, lastDot + 1),
    name: collection.slice(lastDot + 1),
  };
}

function getMomentumRatio(recent: number, total: number): number {
  if (total <= 0 || recent <= 0) return 0;
  return Math.min(recent / total, 1);
}

function isTrending(recent: number, total: number): boolean {
  return recent >= 30 && getMomentumRatio(recent, total) >= 0.2;
}

function formatDate(dateStr: string | null): { display: string; full: string; isBackfill: boolean } {
  if (!dateStr || dateStr.startsWith('1900-01-01')) {
    return { display: 'Backfilled', full: 'Backfilled historical records', isBackfill: true };
  }
  const isoStr = dateStr.endsWith('Z') ? dateStr : `${dateStr}Z`;
  const d = new Date(isoStr);
  if (isNaN(d.getTime())) {
    return { display: dateStr, full: dateStr, isBackfill: false };
  }
  const pad = (n: number) => n.toString().padStart(2, '0');
  const yyyy = d.getFullYear();
  const mm = pad(d.getMonth() + 1);
  const dd = pad(d.getDate());
  const hh = pad(d.getHours());
  const min = pad(d.getMinutes());
  return {
    display: `${yyyy}-${mm}-${dd}`,
    full: `${yyyy}-${mm}-${dd} ${hh}:${min} UTC`,
    isBackfill: false,
  };
}

const toIsoDateString = (dateStr: string) => dateStr.replace(/\//g, '-');

const CollectionList: React.FC<CollectionListProps> = ({ collections }) => {
  const [tableMode, setTableMode] = useState<TableMode>('grouped');
  // Default sort order: alphabetical (collection A-Z)
  const [sortKey, setSortKey] = useState<SortKey>('collection');
  const [sortDirection, setSortDirection] = useState<'ascending' | 'descending'>('ascending');

  // Search & Filter conditions from original Collection page
  const [searchParams, setSearchParams] = useSearchParams();
  const [searchQuery, setSearchQuery] = useState<string>(() => searchParams.get('search') || '');
  const [firstRange, setFirstRange] = useState<[string, string]>(['', '']);
  const [lastRange, setLastRange] = useState<[string, string]>(['', '']);

  useEffect(() => {
    const q = searchParams.get('search');
    if (q !== null) {
      setSearchQuery(q);
      setPage(1);
    }
  }, [searchParams]);
  const [hasLexiconCheck, setHasLexiconCheck] = useState<boolean>(false);
  const [lexiconKeys, setLexiconKeys] = useState<Set<string>>(new Set());

  const [page, setPage] = useState<number>(1);
  const [pageSize, setPageSize] = useState<string>('50');
  const [isOpen, setIsOpen] = useState(false);
  const [selectedCollection, setSelectedCollection] = useState<string | null>('');
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());

  // Global preferences
  const exceptInvalidTLDs = useModeStore((state) => state.exceptInvalidTLDs);
  const setExceptInvalidTLDs = useModeStore((state) => state.setExceptInvalidTLDs);

  // Fetch published Lexicon schema keys
  useEffect(() => {
    let isMounted = true;
    fetch('https://collectiondata.usounds.work/distinct_schema_rkeys')
      .then((res) => (res.ok ? res.json() : []))
      .then((data: { rkey: string }[]) => {
        if (isMounted && Array.isArray(data)) {
          setLexiconKeys(new Set(data.map((d) => d.rkey)));
        }
      })
      .catch((err) => console.error('Failed to fetch lexicon schema keys:', err));

    return () => {
      isMounted = false;
    };
  }, []);

  const handleSortToggle = (key: SortKey) => {
    if (sortKey === key) {
      setSortDirection((prev) => (prev === 'ascending' ? 'descending' : 'ascending'));
    } else {
      setSortKey(key);
      setSortDirection(key === 'collection' ? 'ascending' : 'descending');
    }
    setPage(1);
  };

  const handleSearchChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const val = event.target.value;
    setSearchQuery(val);
    setPage(1);
    if (!val.trim() && searchParams.has('search')) {
      const nextParams = new URLSearchParams(searchParams);
      nextParams.delete('search');
      setSearchParams(nextParams, { replace: true });
    }
  };

  const handleSelectedCollection = (collection: string) => {
    setSelectedCollection(collection);
    setIsOpen(true);
  };

  const handleUnselect = () => {
    setSelectedCollection('');
    setIsOpen(false);
  };

  const toggleGroup = (registrantNsid: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(registrantNsid)) {
        next.delete(registrantNsid);
      } else {
        next.add(registrantNsid);
      }
      return next;
    });
  };

  const hasActiveFilters = Boolean(
    searchQuery.trim() ||
    firstRange[0] ||
    lastRange[0] ||
    hasLexiconCheck
  );

  const handleClearFilters = () => {
    setSearchQuery('');
    setFirstRange(['', '']);
    setLastRange(['', '']);
    setHasLexiconCheck(false);
    setPage(1);
    setExpandedGroups(new Set());
    if (searchParams.has('search')) {
      const nextParams = new URLSearchParams(searchParams);
      nextParams.delete('search');
      setSearchParams(nextParams, { replace: true });
    }
  };

  // Filter and sort individual collections
  const filteredAndSortedCollections = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();

    const filtered = collections.filter((item) => {
      // Text query (collection NSID or webDomain)
      if (query) {
        const matchesNsid = item.collection.toLowerCase().includes(query);
        const matchesDomain = getWebDomainFromNsid(item.collection).toLowerCase().includes(query);
        if (!matchesNsid && !matchesDomain) return false;
      }

      // First Indexed Date Range
      if (firstRange[0]) {
        const fromDate = new Date(toIsoDateString(firstRange[0]));
        const itemMin = item.min ? new Date(item.min.endsWith('Z') ? item.min : `${item.min}Z`) : new Date(0);
        if (isNaN(itemMin.getTime()) || itemMin < fromDate) return false;
        if (firstRange[1]) {
          const toDate = new Date(toIsoDateString(firstRange[1]));
          toDate.setHours(23, 59, 59, 999);
          if (itemMin > toDate) return false;
        }
      }

      // Last Indexed Date Range
      if (lastRange[0]) {
        const fromDate = new Date(toIsoDateString(lastRange[0]));
        const itemMax = item.max ? new Date(item.max.endsWith('Z') ? item.max : `${item.max}Z`) : new Date(0);
        if (isNaN(itemMax.getTime()) || itemMax < fromDate) return false;
        if (lastRange[1]) {
          const toDate = new Date(toIsoDateString(lastRange[1]));
          toDate.setHours(23, 59, 59, 999);
          if (itemMax > toDate) return false;
        }
      }

      // Has Lexicon Schema
      if (hasLexiconCheck) {
        if (!lexiconKeys.has(item.collection)) return false;
      }

      return true;
    });

    const dirMultiplier = sortDirection === 'ascending' ? 1 : -1;

    return [...filtered].sort((a, b) => {
      if (sortKey === 'collection') {
        return a.collection.localeCompare(b.collection) * dirMultiplier;
      }
      if (sortKey === 'count') {
        return (a.count - b.count) * dirMultiplier;
      }
      if (sortKey === 'recent_count') {
        return (a.recent_count - b.recent_count) * dirMultiplier;
      }
      if (sortKey === 'momentum') {
        const ratioA = getMomentumRatio(a.recent_count, a.count);
        const ratioB = getMomentumRatio(b.recent_count, b.count);
        return (ratioA - ratioB) * dirMultiplier || (a.recent_count - b.recent_count) * dirMultiplier;
      }
      if (sortKey === 'min' || sortKey === 'max') {
        const valA = a[sortKey];
        const valB = b[sortKey];
        const dateA = typeof valA === 'string' ? new Date(valA).getTime() : 0;
        const dateB = typeof valB === 'string' ? new Date(valB).getTime() : 0;
        return (dateA - dateB) * dirMultiplier;
      }
      return 0;
    });
  }, [collections, searchQuery, firstRange, lastRange, hasLexiconCheck, lexiconKeys, sortKey, sortDirection]);

  // Group collections by PSL-aware registrant domain (Lv2 for standard domains, Lv3 for co.uk)
  const domainGroups = useMemo(() => {
    const map = new Map<string, DomainGroup>();

    for (const item of filteredAndSortedCollections) {
      const registrantNsid = getRegistrantNsid(item.collection);
      let group = map.get(registrantNsid);
      if (!group) {
        group = {
          registrantNsid,
          webDomain: getWebDomainFromNsid(item.collection),
          items: [],
          recentCount: 0,
          count: 0,
          uniqueDid: 0,
          firstMin: item.min,
          lastMax: item.max,
          hasNew: false,
        };
        map.set(registrantNsid, group);
      }
      group.items.push(item);
      group.recentCount += item.recent_count;
      group.count += item.count;
      group.uniqueDid += item.unique_did ?? 0;
      if (item.isNew) group.hasNew = true;

      if (item.min && (!group.firstMin || new Date(item.min) < new Date(group.firstMin))) {
        group.firstMin = item.min;
      }
      if (item.max && (!group.lastMax || new Date(item.max) > new Date(group.lastMax))) {
        group.lastMax = item.max;
      }
    }

    const dirMultiplier = sortDirection === 'ascending' ? 1 : -1;

    return Array.from(map.values()).sort((a, b) => {
      if (sortKey === 'collection') {
        return a.webDomain.localeCompare(b.webDomain) * dirMultiplier;
      }
      if (sortKey === 'count') {
        return (a.count - b.count) * dirMultiplier;
      }
      if (sortKey === 'recent_count' || sortKey === 'momentum') {
        return (a.recentCount - b.recentCount) * dirMultiplier;
      }
      if (sortKey === 'min') {
        const dateA = a.firstMin ? new Date(a.firstMin).getTime() : 0;
        const dateB = b.firstMin ? new Date(b.firstMin).getTime() : 0;
        return (dateA - dateB) * dirMultiplier;
      }
      if (sortKey === 'max') {
        const dateA = a.lastMax ? new Date(a.lastMax).getTime() : 0;
        const dateB = b.lastMax ? new Date(b.lastMax).getTime() : 0;
        return (dateA - dateB) * dirMultiplier;
      }
      return 0;
    });
  }, [filteredAndSortedCollections, sortKey, sortDirection]);

  // Auto-expand matching groups when search filters are active
  useEffect(() => {
    if (searchQuery.trim() || hasLexiconCheck || firstRange[0] || lastRange[0]) {
      const matching = new Set<string>();
      for (const group of domainGroups) {
        matching.add(group.registrantNsid);
      }
      setExpandedGroups(matching);
    }
  }, [searchQuery, hasLexiconCheck, firstRange, lastRange, domainGroups]);

  const numericPageSize = parseInt(pageSize, 10) || 50;

  // Pagination for grouped mode vs flat mode
  const totalItemCount = tableMode === 'grouped' ? domainGroups.length : filteredAndSortedCollections.length;
  const totalPages = Math.max(1, Math.ceil(totalItemCount / numericPageSize));
  const currentPage = Math.min(page, totalPages);
  const pageStart = (currentPage - 1) * numericPageSize;

  const paginatedGroups = useMemo(() => {
    return domainGroups.slice(pageStart, pageStart + numericPageSize);
  }, [domainGroups, pageStart, numericPageSize]);

  const paginatedFlatCollections = useMemo(() => {
    return filteredAndSortedCollections.slice(pageStart, pageStart + numericPageSize);
  }, [filteredAndSortedCollections, pageStart, numericPageSize]);

  // Expand all / collapse all groups on the current page
  const toggleAllCurrentGroups = () => {
    if (expandedGroups.size > 0) {
      setExpandedGroups(new Set());
    } else {
      setExpandedGroups(new Set(paginatedGroups.map((g) => g.registrantNsid)));
    }
  };

  const renderSortIcon = (key: SortKey) => {
    if (sortKey !== key) {
      return <IconSelector size={14} className="opacity-40" />;
    }
    return sortDirection === 'ascending' ? (
      <IconChevronUp size={14} className="text-blue-500 font-bold" />
    ) : (
      <IconChevronDown size={14} className="text-blue-500 font-bold" />
    );
  };

  return (
    <Paper withBorder p="md" radius="lg" className="bg-white dark:bg-[#182234] shadow-sm">
      {/* Title & Stats */}
      <Box className="mb-4">
        <Group justify="space-between" align="center" wrap="wrap" gap="sm">
          <Group gap="xs" align="center">
            <Text fw={700} size="lg" className="text-gray-900 dark:text-gray-100">
              Collections
            </Text>
            <Badge size="sm" variant="light" color="blue" radius="md">
              {domainGroups.length.toLocaleString()} Domains ({filteredAndSortedCollections.length.toLocaleString()} Collections)
            </Badge>
          </Group>
          <Text size="xs" c="dimmed">
            Alphabetical by default. Click headers to sort by events or dates.
          </Text>
        </Group>
      </Box>

      {/* Search & Filter Conditions Panel (from original Collection page) */}
      <Paper withBorder p="md" radius="md" className="bg-gray-50/70 dark:bg-gray-800/40 border-gray-200 dark:border-gray-700/60 mb-5">
        {/* Upper Row: Search input & Date Pickers */}
        <div className="flex flex-col lg:flex-row gap-4 mb-4">
          <div className="flex-1 min-w-[220px]">
            <Text size="xs" fw={600} mb={6} c="dimmed" className="uppercase tracking-wider">
              Search Collections
            </Text>
            <TextInput
              placeholder="Enter collection name or domain (e.g. bsky.app, post)..."
              leftSection={<IconSearch size={16} className="text-gray-400" />}
              rightSection={
                searchQuery ? (
                  <CloseButton
                    size="sm"
                    onClick={() => {
                      setSearchQuery('');
                      setPage(1);
                      if (searchParams.has('search')) {
                        const nextParams = new URLSearchParams(searchParams);
                        nextParams.delete('search');
                        setSearchParams(nextParams, { replace: true });
                      }
                    }}
                  />
                ) : null
              }
              value={searchQuery}
              onChange={handleSearchChange}
              size="sm"
              radius="md"
            />
          </div>

          <div className="w-full lg:w-64">
            <Text size="xs" fw={600} mb={6} c="dimmed" className="uppercase tracking-wider">
              First Indexed
            </Text>
            <DatePickerRange
              value={firstRange}
              onChange={(dates) => {
                setFirstRange(dates);
                setPage(1);
              }}
              placeholder="From - To"
              className="w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-[#182234] px-3 py-1.5 text-xs outline-none transition focus:border-blue-500 text-gray-900 dark:text-gray-100 h-[36px]"
            />
          </div>

          <div className="w-full lg:w-64">
            <Text size="xs" fw={600} mb={6} c="dimmed" className="uppercase tracking-wider">
              Last Indexed
            </Text>
            <DatePickerRange
              value={lastRange}
              onChange={(dates) => {
                setLastRange(dates);
                setPage(1);
              }}
              placeholder="From - To"
              className="w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-[#182234] px-3 py-1.5 text-xs outline-none transition focus:border-blue-500 text-gray-900 dark:text-gray-100 h-[36px]"
            />
          </div>
        </div>

        {/* Lower Row: Checkboxes, Quick Filter, Mode & Action Buttons */}
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center pt-3 border-t border-gray-200 dark:border-gray-700/60 gap-3">
          <Group gap="md" wrap="wrap" align="center">
            <Checkbox
              checked={hasLexiconCheck}
              onChange={(e) => {
                setHasLexiconCheck(e.currentTarget.checked);
                setPage(1);
              }}
              label={
                <Group gap={4} wrap="nowrap">
                  <span>Has lexicon</span>
                  {lexiconKeys.size > 0 && (
                    <Badge size="xs" variant="light" color="blue" radius="sm">
                      {lexiconKeys.size}
                    </Badge>
                  )}
                </Group>
              }
              size="xs"
            />

            <Checkbox
              checked={exceptInvalidTLDs}
              onChange={(e) => {
                setExceptInvalidTLDs(e.currentTarget.checked);
                setPage(1);
              }}
              label="Exclude invalid TLDs"
              size="xs"
            />
          </Group>

          <Group gap="xs" wrap="wrap" align="center">
            <SegmentedControl
              value={tableMode}
              onChange={(val) => {
                setTableMode(val as TableMode);
                setPage(1);
              }}
              size="xs"
              radius="md"
              data={[
                { value: 'grouped', label: 'Domain Tree (Lv2/3)' },
                { value: 'flat', label: 'Flat List' },
              ]}
            />

            {hasActiveFilters && (
              <Button
                variant="light"
                color="red"
                size="xs"
                radius="md"
                leftSection={<IconFilterOff size={13} />}
                onClick={handleClearFilters}
              >
                Clear
              </Button>
            )}

            <Select
              value={pageSize}
              onChange={(val) => {
                setPageSize(val || '50');
                setPage(1);
              }}
              data={[
                { value: '25', label: '25 / page' },
                { value: '50', label: '50 / page' },
                { value: '100', label: '100 / page' },
                { value: '250', label: '250 / page' },
              ]}
              size="xs"
              radius="md"
              w={110}
              comboboxProps={{ withinPortal: false }}
            />
          </Group>
        </div>
      </Paper>

      {/* Modal Detail View */}
      {isOpen && selectedCollection && (
        <CollectionDetail
          open={isOpen}
          onCancel={handleUnselect}
          onOk={handleUnselect}
          collection={selectedCollection}
        />
      )}

      {/* Main Table */}
      <Box className="overflow-x-auto rounded-lg border border-gray-100 dark:border-gray-800">
        <Table highlightOnHover verticalSpacing="md" horizontalSpacing="md" className="w-full">
          <Table.Thead className="bg-gray-50/80 dark:bg-gray-800/60 border-b border-gray-200 dark:border-gray-700/60">
            <Table.Tr>
              <Table.Th className="w-[45%] min-w-[280px]">
                <Group gap="xs" wrap="nowrap" align="center">
                  {tableMode === 'grouped' && (
                    <Tooltip
                      label={expandedGroups.size > 0 ? 'Collapse all domain groups' : 'Expand all domain groups'}
                      withArrow
                      position="top"
                    >
                      <ActionIcon
                        variant="subtle"
                        size="sm"
                        color="gray"
                        className="shrink-0"
                        onClick={toggleAllCurrentGroups}
                        aria-label={expandedGroups.size > 0 ? 'Collapse all' : 'Expand all'}
                      >
                        {expandedGroups.size > 0 ? <IconChevronDown size={15} /> : <IconChevronRight size={15} />}
                      </ActionIcon>
                    </Tooltip>
                  )}

                  <UnstyledButton
                    onClick={() => handleSortToggle('collection')}
                    className="flex items-center gap-1.5 font-semibold text-xs tracking-wider uppercase text-gray-600 dark:text-gray-300 hover:text-blue-600 transition-colors"
                  >
                    <span>{tableMode === 'grouped' ? 'Domain / NSID' : 'NSID'}</span>
                    {renderSortIcon('collection')}
                  </UnstyledButton>
                </Group>
              </Table.Th>

              <Table.Th className="text-right min-w-[130px]">
                <UnstyledButton
                  onClick={() => handleSortToggle('recent_count')}
                  className="flex items-center justify-end gap-1.5 w-full font-semibold text-xs tracking-wider uppercase text-gray-600 dark:text-gray-300 hover:text-blue-600 transition-colors"
                >
                  <Tooltip
                    label="Events in the last 72 hours. The 🔥 badge shows surge momentum."
                    withArrow
                    multiline
                    w={240}
                  >
                    <span className="inline-flex items-center gap-1">
                      <span>72h Events</span>
                      <IconInfoCircle size={13} className="text-gray-400 opacity-70" />
                    </span>
                  </Tooltip>
                  {renderSortIcon('recent_count')}
                </UnstyledButton>
              </Table.Th>

              <Table.Th className="hidden sm:table-cell text-right min-w-[110px]">
                <UnstyledButton
                  onClick={() => handleSortToggle('count')}
                  className="flex items-center justify-end gap-1.5 w-full font-semibold text-xs tracking-wider uppercase text-gray-600 dark:text-gray-300 hover:text-blue-600 transition-colors"
                >
                  <span>Total Events</span>
                  {renderSortIcon('count')}
                </UnstyledButton>
              </Table.Th>

              <Table.Th className="hidden md:table-cell text-right min-w-[120px]">
                <UnstyledButton
                  onClick={() => handleSortToggle('min')}
                  className="flex items-center justify-end gap-1.5 w-full font-semibold text-xs tracking-wider uppercase text-gray-600 dark:text-gray-300 hover:text-blue-600 transition-colors"
                >
                  <span>First Indexed</span>
                  {renderSortIcon('min')}
                </UnstyledButton>
              </Table.Th>

              <Table.Th className="hidden lg:table-cell text-right min-w-[120px]">
                <UnstyledButton
                  onClick={() => handleSortToggle('max')}
                  className="flex items-center justify-end gap-1.5 w-full font-semibold text-xs tracking-wider uppercase text-gray-600 dark:text-gray-300 hover:text-blue-600 transition-colors"
                >
                  <span>Last Indexed</span>
                  {renderSortIcon('max')}
                </UnstyledButton>
              </Table.Th>

              <Table.Th className="w-[50px] text-center">
                <span className="sr-only">Actions</span>
              </Table.Th>
            </Table.Tr>
          </Table.Thead>

          <Table.Tbody>
            {tableMode === 'grouped' ? (
              // GROUPED ACCORDION VIEW
              paginatedGroups.length === 0 ? (
                <Table.Tr>
                  <Table.Td colSpan={6} className="text-center py-12 text-gray-400">
                    No domains or collections match your filters.
                  </Table.Td>
                </Table.Tr>
              ) : (
                paginatedGroups.map((group) => {
                  const isExpanded = expandedGroups.has(group.registrantNsid);
                  const firstDate = formatDate(group.firstMin);
                  const lastDate = formatDate(group.lastMax);
                  const lexiconCount = group.items.filter((it) => lexiconKeys.has(it.collection)).length;

                  return (
                    <React.Fragment key={group.registrantNsid}>
                      {/* Domain Header Row */}
                      <Table.Tr
                        className={`cursor-pointer transition-colors border-b border-gray-100 dark:border-gray-800 ${
                          isExpanded
                            ? 'bg-blue-50/50 dark:bg-blue-950/20'
                            : 'hover:bg-gray-50/70 dark:hover:bg-gray-800/40'
                        }`}
                        onClick={() => toggleGroup(group.registrantNsid)}
                      >
                        <Table.Td>
                          <Group gap="sm" wrap="nowrap" align="center">
                            <ActionIcon
                              variant="subtle"
                              size="sm"
                              color="gray"
                              className="shrink-0"
                              onClick={(e) => {
                                e.stopPropagation();
                                toggleGroup(group.registrantNsid);
                              }}
                            >
                              {isExpanded ? <IconChevronDown size={15} /> : <IconChevronRight size={15} />}
                            </ActionIcon>

                            <CollectionFavicon domain={group.webDomain} size={20} className="shrink-0" />

                            <Box className="min-w-0">
                              <Group gap={6} wrap="nowrap">
                                <Text fw={700} size="sm" className="font-mono text-gray-900 dark:text-gray-100 truncate">
                                  {group.webDomain}
                                </Text>
                                <Text size="xs" c="dimmed" className="font-mono truncate hidden sm:inline">
                                  ({group.registrantNsid})
                                </Text>
                                {group.hasNew && (
                                  <Badge size="xs" color="teal" variant="light" radius="sm">
                                    NEW
                                  </Badge>
                                )}
                                {lexiconCount > 0 && (
                                  <Badge size="xs" color="blue" variant="light" radius="sm">
                                    {lexiconCount} Lexicon{lexiconCount > 1 ? 's' : ''}
                                  </Badge>
                                )}
                                <Badge size="xs" variant="light" color="gray" radius="sm">
                                  {group.items.length} {group.items.length === 1 ? 'record' : 'records'}
                                </Badge>
                              </Group>
                            </Box>
                          </Group>
                        </Table.Td>

                        <Table.Td className="text-right">
                          <Text size="xs" fw={700} className="font-mono text-gray-900 dark:text-gray-100">
                            {group.recentCount.toLocaleString()}
                          </Text>
                        </Table.Td>

                        <Table.Td className="hidden sm:table-cell text-right">
                          <Text size="xs" fw={600} c="dimmed" className="font-mono">
                            {group.count.toLocaleString()}
                          </Text>
                        </Table.Td>

                        <Table.Td className="hidden md:table-cell text-right">
                          <Text size="xs" c="dimmed">
                            {firstDate.display}
                          </Text>
                        </Table.Td>

                        <Table.Td className="hidden lg:table-cell text-right">
                          <Text size="xs" c="dimmed">
                            {lastDate.display}
                          </Text>
                        </Table.Td>

                        <Table.Td className="text-center" onClick={(e) => e.stopPropagation()}>
                          <a
                            href={`https://${group.webDomain}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 transition-colors inline-flex"
                            title={`Visit ${group.webDomain}`}
                          >
                            <IconExternalLink size={14} />
                          </a>
                        </Table.Td>
                      </Table.Tr>

                      {/* Expanded Child Rows */}
                      {isExpanded &&
                        group.items.map((item) => {
                          const { namespace, name } = splitNsid(item.collection);
                          const momentumRatio = getMomentumRatio(item.recent_count, item.count);
                          const itemFirst = formatDate(item.min);
                          const itemLast = formatDate(item.max);
                          const hasLex = lexiconKeys.has(item.collection);

                          return (
                            <Table.Tr
                              key={item.collection}
                              className="bg-gray-50/40 dark:bg-gray-900/40 hover:bg-blue-50/70 dark:hover:bg-blue-900/30 cursor-pointer transition-colors border-b border-gray-100/70 dark:border-gray-800/70 group"
                              onClick={() => handleSelectedCollection(item.collection)}
                            >
                              <Table.Td className="pl-9 sm:pl-12">
                                <Group gap={6} wrap="nowrap" align="center">
                                  <IconCornerDownRight size={13} className="text-gray-400 shrink-0" />
                                  <Box className="min-w-0">
                                    <Group gap={6} wrap="nowrap" align="center">
                                      <div className="flex items-center min-w-0 font-mono text-xs truncate">
                                        <span className="text-gray-400 dark:text-gray-500 truncate">{namespace}</span>
                                        <span className="font-bold text-blue-600 dark:text-blue-400 shrink-0">{name}</span>
                                      </div>

                                      {item.isNew && (
                                        <Badge
                                          size="xs"
                                          variant="gradient"
                                          gradient={{ from: 'teal', to: 'green', deg: 90 }}
                                          radius="sm"
                                          className="font-bold shrink-0"
                                        >
                                          NEW
                                        </Badge>
                                      )}

                                      {hasLex && (
                                        <Tooltip label="Published Lexicon schema available" withArrow position="top">
                                          <Badge size="xs" color="blue" variant="light" radius="sm" className="font-mono text-[10px]">
                                            Lexicon
                                          </Badge>
                                        </Tooltip>
                                      )}

                                      <Box
                                        onClick={(e) => e.stopPropagation()}
                                        className="opacity-0 group-hover:opacity-100 transition-opacity ml-1"
                                      >
                                        <CopyButton value={item.collection} timeout={2000}>
                                          {({ copied, copy }) => (
                                            <Tooltip label={copied ? 'Copied NSID!' : 'Copy NSID'} withArrow position="top">
                                              <ActionIcon
                                                color={copied ? 'teal' : 'gray'}
                                                variant="subtle"
                                                size="xs"
                                                onClick={copy}
                                                radius="sm"
                                              >
                                                {copied ? <IconCheck size={12} /> : <IconCopy size={12} />}
                                              </ActionIcon>
                                            </Tooltip>
                                          )}
                                        </CopyButton>
                                      </Box>
                                    </Group>
                                  </Box>
                                </Group>
                              </Table.Td>

                              <Table.Td className="text-right">
                                <Group justify="flex-end" gap={6} wrap="nowrap">
                                  {momentumRatio >= 0.2 && item.recent_count >= 30 && (
                                    <Badge
                                      size="xs"
                                      variant="gradient"
                                      gradient={{ from: 'orange', to: 'red', deg: 90 }}
                                      radius="sm"
                                      className="font-bold"
                                    >
                                      🔥 {Math.round(momentumRatio * 100)}%
                                    </Badge>
                                  )}
                                  <Text size="xs" fw={700} className="font-mono text-gray-900 dark:text-gray-100">
                                    {item.recent_count.toLocaleString()}
                                  </Text>
                                </Group>
                              </Table.Td>

                              <Table.Td className="hidden sm:table-cell text-right">
                                <Text size="xs" className="font-mono text-gray-600 dark:text-gray-400">
                                  {item.count.toLocaleString()}
                                </Text>
                              </Table.Td>

                              <Table.Td className="hidden md:table-cell text-right">
                                <Text size="xs" c={itemFirst.isBackfill ? 'dimmed' : undefined}>
                                  {itemFirst.display}
                                </Text>
                              </Table.Td>

                              <Table.Td className="hidden lg:table-cell text-right">
                                <Text size="xs" c={itemLast.isBackfill ? 'dimmed' : undefined}>
                                  {itemLast.display}
                                </Text>
                              </Table.Td>

                              <Table.Td className="text-center">
                                <IconChevronRight
                                  size={14}
                                  className="text-gray-400 group-hover:text-blue-500 transition-colors inline-block"
                                />
                              </Table.Td>
                            </Table.Tr>
                          );
                        })}
                    </React.Fragment>
                  );
                })
              )
            ) : (
              // FLAT LIST VIEW
              paginatedFlatCollections.length === 0 ? (
                <Table.Tr>
                  <Table.Td colSpan={6} className="text-center py-12 text-gray-400">
                    No collections match your filters.
                  </Table.Td>
                </Table.Tr>
              ) : (
                paginatedFlatCollections.map((item) => {
                  const { namespace, name } = splitNsid(item.collection);
                  const momentumRatio = getMomentumRatio(item.recent_count, item.count);
                  const firstDate = formatDate(item.min);
                  const lastDate = formatDate(item.max);
                  const hasLex = lexiconKeys.has(item.collection);

                  return (
                    <Table.Tr
                      key={item.collection}
                      className="cursor-pointer hover:bg-gray-50/70 dark:hover:bg-gray-800/40 transition-colors border-b border-gray-100 dark:border-gray-800 group"
                      onClick={() => handleSelectedCollection(item.collection)}
                    >
                      <Table.Td>
                        <div className="flex items-center gap-3">
                          <CollectionFavicon nsid={item.collection} size={20} className="shrink-0" />

                          <div className="flex flex-col min-w-0">
                            <div className="flex items-center gap-1.5 min-w-0">
                              {item.isNew && (
                                <Badge
                                  size="xs"
                                  variant="gradient"
                                  gradient={{ from: 'teal', to: 'green', deg: 90 }}
                                  radius="sm"
                                  className="shrink-0 font-bold"
                                >
                                  NEW
                                </Badge>
                              )}

                              {hasLex && (
                                <Tooltip label="Published Lexicon schema available" withArrow position="top">
                                  <Badge size="xs" color="blue" variant="light" radius="sm" className="font-mono text-[10px]">
                                    Lexicon
                                  </Badge>
                                </Tooltip>
                              )}

                              <div className="flex items-center min-w-0 truncate font-mono text-xs sm:text-sm">
                                {namespace && (
                                  <span className="text-gray-400 dark:text-gray-500 truncate">
                                    {namespace}
                                  </span>
                                )}
                                <span className="font-semibold text-gray-900 dark:text-gray-100 shrink-0">
                                  {name}
                                </span>
                              </div>

                              <Box
                                onClick={(e) => e.stopPropagation()}
                                className="opacity-0 group-hover:opacity-100 transition-opacity ml-1"
                              >
                                <CopyButton value={item.collection} timeout={2000}>
                                  {({ copied, copy }) => (
                                    <Tooltip label={copied ? 'Copied NSID!' : 'Copy NSID'} withArrow position="top">
                                      <ActionIcon
                                        color={copied ? 'teal' : 'gray'}
                                        variant="subtle"
                                        size="xs"
                                        onClick={copy}
                                        radius="sm"
                                      >
                                        {copied ? <IconCheck size={12} /> : <IconCopy size={12} />}
                                      </ActionIcon>
                                    </Tooltip>
                                  )}
                                </CopyButton>
                              </Box>
                            </div>
                          </div>
                        </div>
                      </Table.Td>

                      <Table.Td className="text-right">
                        <Group justify="flex-end" gap={6} wrap="nowrap">
                          {momentumRatio >= 0.2 && item.recent_count >= 30 && (
                            <Badge
                              size="xs"
                              variant="gradient"
                              gradient={{ from: 'orange', to: 'red', deg: 90 }}
                              radius="sm"
                              className="font-bold"
                            >
                              🔥 {Math.round(momentumRatio * 100)}%
                            </Badge>
                          )}
                          <Text size="xs" fw={700} className="font-mono text-gray-900 dark:text-gray-100">
                            {item.recent_count.toLocaleString()}
                          </Text>
                        </Group>
                      </Table.Td>

                      <Table.Td className="hidden sm:table-cell text-right">
                        <Text size="xs" className="font-mono text-gray-600 dark:text-gray-400">
                          {item.count.toLocaleString()}
                        </Text>
                      </Table.Td>

                      <Table.Td className="hidden md:table-cell text-right">
                        <Text size="xs" c={firstDate.isBackfill ? 'dimmed' : undefined}>
                          {firstDate.display}
                        </Text>
                      </Table.Td>

                      <Table.Td className="hidden lg:table-cell text-right">
                        <Text size="xs" c={lastDate.isBackfill ? 'dimmed' : undefined}>
                          {lastDate.display}
                        </Text>
                      </Table.Td>

                      <Table.Td className="text-center">
                        <IconChevronRight
                          size={14}
                          className="text-gray-400 group-hover:text-blue-500 transition-colors inline-block"
                        />
                      </Table.Td>
                    </Table.Tr>
                  );
                })
              )
            )}
          </Table.Tbody>
        </Table>
      </Box>

      {/* Pagination Footer */}
      {totalPages > 1 && (
        <Group justify="space-between" align="center" mt="lg" wrap="wrap" gap="md">
          <Text size="xs" c="dimmed">
            Showing {pageStart + 1} to {Math.min(pageStart + numericPageSize, totalItemCount)} of{' '}
            {totalItemCount.toLocaleString()} {tableMode === 'grouped' ? 'domains' : 'collections'}
          </Text>

          <Pagination
            value={currentPage}
            onChange={setPage}
            total={totalPages}
            size="sm"
            radius="md"
            withEdges
          />
        </Group>
      )}
    </Paper>
  );
};

export default CollectionList;
