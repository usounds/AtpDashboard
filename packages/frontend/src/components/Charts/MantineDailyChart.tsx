import React, { useState, useEffect, useRef } from 'react';
import { Paper, SegmentedControl, LoadingOverlay, Text, Group, Box } from '@mantine/core';
import { AreaChart } from '@mantine/charts';
import {
  buildDailyChartUrl,
  type DailyChartMetric,
  type DailyChartRange,
  type DailyChartResponse,
  type DailyChartRow,
} from './dailyChart';
import { formatRelativeDayOffsetLabel } from './chartLabels';

interface MantineDailyChartProps {
  metric: DailyChartMetric;
  title: string;
  activeTitle?: string;
  newTitle?: string;
}

export const MantineDailyChart: React.FC<MantineDailyChartProps> = ({
  metric,
  title,
  activeTitle = 'Active',
  newTitle = 'New',
}) => {
  const [data, setData] = useState<DailyChartRow[]>([]);
  const [range, setRange] = useState<DailyChartRange>('30 Days');
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const requestIdRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;

    const fetchData = async () => {
      setIsLoading(true);
      try {
        const response = await fetch(buildDailyChartUrl(metric, range));
        if (!response.ok) {
          throw new Error(`Error: ${response.statusText}`);
        }
        const result = (await response.json()) as DailyChartResponse;
        if (!cancelled && requestId === requestIdRef.current) {
          // Format date for chart labels
          const isMonthly = range === '365 Days';
          const formatted = result.rows.map((row) => ({
            ...row,
            displayDate: formatRelativeDayOffsetLabel(row.day_offset, isMonthly),
          }));
          setData(formatted);
        }
      } catch (err: any) {
        console.error('Failed to fetch daily chart data:', err);
      } finally {
        if (!cancelled && requestId === requestIdRef.current) {
          setIsLoading(false);
        }
      }
    };

    fetchData();
    return () => {
      cancelled = true;
    };
  }, [metric, range]);

  return (
    <Paper
      withBorder
      shadow="xs"
      radius="lg"
      p="lg"
      className="col-span-12 xl:col-span-6 bg-white dark:bg-[#182234] border-gray-200 dark:border-gray-800"
    >
      <Group justify="space-between" align="center" mb="md" wrap="wrap" gap="sm">
        <Box>
          <Text fw={700} size="md" className="text-gray-900 dark:text-white">
            {title}
          </Text>
          <Text size="xs" c="dimmed" mt={1}>
            {metric === 'collections'
              ? 'Active and newly discovered collections over time'
              : 'Active and newly registered users over time'}
          </Text>
        </Box>

        <SegmentedControl
          size="xs"
          radius="md"
          value={range}
          onChange={(val) => setRange(val as DailyChartRange)}
          data={[
            { label: 'This Week', value: '7 Days' },
            { label: 'This Month', value: '30 Days' },
            { label: 'This Year', value: '365 Days' },
          ]}
        />
      </Group>

      <Box pos="relative" h={340}>
        <LoadingOverlay
          visible={isLoading}
          overlayProps={{ radius: 'md', blur: 1, opacity: 0.35 }}
          loaderProps={{ size: 'sm', color: 'blue' }}
        />
        {data.length > 0 ? (
          <AreaChart
            h={330}
            data={data}
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
              { name: 'active', label: activeTitle, color: 'blue.6' },
              { name: 'new', label: newTitle, color: 'cyan.5' },
            ]}
          />
        ) : (
          <Box className="h-full flex items-center justify-center text-gray-400">
            {isLoading ? '' : 'No data available'}
          </Box>
        )}
      </Box>
    </Paper>
  );
};

export default MantineDailyChart;
