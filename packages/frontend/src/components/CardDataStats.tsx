import React, { ReactNode } from 'react';
import { Paper, Group, Text, ThemeIcon, Badge } from '@mantine/core';
import { IconArrowUpRight, IconArrowDownRight } from '@tabler/icons-react';

interface CardDataStatsProps {
  title: string;
  total: string;
  rate: string;
  levelUp?: boolean;
  levelDown?: boolean;
  children: ReactNode;
}

const CardDataStats: React.FC<CardDataStatsProps> = ({
  title,
  total,
  rate,
  levelUp,
  levelDown,
  children,
}) => {
  return (
    <Paper
      withBorder
      shadow="xs"
      radius="lg"
      p="lg"
      className="bg-white dark:bg-[#182234] border-gray-200 dark:border-gray-800 transition-all hover:shadow-md"
    >
      <Group justify="space-between" align="flex-start">
        <ThemeIcon
          size={46}
          radius="md"
          variant="light"
          color="blue"
          className="bg-blue-50 dark:bg-blue-950/40 text-[#3C50E0] dark:text-blue-400"
        >
          {children}
        </ThemeIcon>

        {rate && (
          <Badge
            variant="light"
            color={levelUp ? 'teal' : levelDown ? 'red' : 'gray'}
            leftSection={
              levelUp ? (
                <IconArrowUpRight size={13} stroke={2.5} />
              ) : levelDown ? (
                <IconArrowDownRight size={13} stroke={2.5} />
              ) : undefined
            }
            radius="sm"
            size="sm"
          >
            {rate}
          </Badge>
        )}
      </Group>

      <div className="mt-4">
        <Text fw={700} className="text-2xl font-bold tracking-tight text-gray-900 dark:text-white">
          {total}
        </Text>
        <Text size="sm" c="dimmed" mt={2} fw={500}>
          {title}
        </Text>
      </div>
    </Paper>
  );
};

export default CardDataStats;
