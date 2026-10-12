import React from 'react';
import {
  Box,
  Text,
  Title,
  Paper,
  Group,
  Stack,
  SimpleGrid,
  ThemeIcon,
  Badge,
  Divider,
} from '@mantine/core';
import {
  IconCompass,
  IconFlame,
  IconBolt,
  IconSparkles,
  IconDatabase,
  IconRss,
  IconCoffee,
} from '@tabler/icons-react';
import PageTitle from '../../components/PageTitle';

const About: React.FC = () => {
  return (
    <>
      <PageTitle title="About & Guide | atproto Dashboard" />

      <Box className="max-w-4xl mx-auto space-y-8 py-2">
        {/* Header Hero */}
        <Box className="space-y-3">
          <Badge size="lg" variant="light" color="blue" radius="md">
            Guide & About
          </Badge>
          <Title order={1} className="text-2xl sm:text-3xl font-extrabold text-gray-900 dark:text-white">
            atproto Dashboard User Guide
          </Title>
          <Text size="sm" c="dimmed" className="leading-relaxed">
            atproto Dashboard is an open-source analytics and discovery platform for the atproto ecosystem.
            It provides comprehensive insights into custom Lexicons, record schemas, user growth, and decentralized activity.
          </Text>
        </Box>

        {/* Feature Guides */}
        <Stack gap="xl">
          {/* Section: Explore */}
          <Box className="space-y-4">
            <Group gap="xs" align="center">
              <ThemeIcon size={28} radius="md" color="blue" variant="light">
                <IconCompass size={18} />
              </ThemeIcon>
              <Title order={2} size="h3" className="text-gray-900 dark:text-white">
                1. Explore: Trending & Emerging Apps
              </Title>
            </Group>
            <Text size="sm" c="dimmed">
              Explore surfaces breakout apps and emerging schemas grouped by registrant domain. It is organized into three distinct views:
            </Text>

            <SimpleGrid cols={{ base: 1, md: 3 }} spacing="md">
              {/* Tab 1: User Surge */}
              <Paper withBorder p="md" radius="md" className="bg-white dark:bg-[#182234] border-gray-200 dark:border-gray-800 flex flex-col justify-between">
                <Box className="space-y-2">
                  <Group justify="space-between" align="center">
                    <Badge color="orange" variant="light" size="sm" leftSection={<IconFlame size={12} />}>
                      User Surge
                    </Badge>
                  </Group>
                  <Text fw={700} size="sm" className="text-gray-900 dark:text-gray-100">
                    New User Adoption
                  </Text>
                  <Text size="xs" c="dimmed" className="leading-relaxed">
                    Detects schemas experiencing a significant spike in new daily users over the past 72 hours compared to their historical baseline.
                  </Text>
                </Box>
                <Box mt="sm" pt="sm" className="border-t border-gray-100 dark:border-gray-800 text-[11px] text-gray-500">
                  💡 <strong>Best for:</strong> Discovering viral apps and breakout new features gaining rapid adoption.
                </Box>
              </Paper>

              {/* Tab 2: Active Buzz */}
              <Paper withBorder p="md" radius="md" className="bg-white dark:bg-[#182234] border-gray-200 dark:border-gray-800 flex flex-col justify-between">
                <Box className="space-y-2">
                  <Group justify="space-between" align="center">
                    <Badge color="yellow" variant="light" size="sm" leftSection={<IconBolt size={12} />}>
                      Active Buzz
                    </Badge>
                  </Group>
                  <Text fw={700} size="sm" className="text-gray-900 dark:text-gray-100">
                    Record Activity Spike
                  </Text>
                  <Text size="xs" c="dimmed" className="leading-relaxed">
                    Measures abnormal surges in record creation such as posts, votes, reactions, and saves over the past 72 hours.
                  </Text>
                </Box>
                <Box mt="sm" pt="sm" className="border-t border-gray-100 dark:border-gray-800 text-[11px] text-gray-500">
                  ⚡ <strong>Best for:</strong> Spotting trending content, active discussions, or rapid record creation.
                </Box>
              </Paper>

              {/* Tab 3: New Collections */}
              <Paper withBorder p="md" radius="md" className="bg-white dark:bg-[#182234] border-gray-200 dark:border-gray-800 flex flex-col justify-between">
                <Box className="space-y-2">
                  <Group justify="space-between" align="center">
                    <Badge color="teal" variant="light" size="sm" leftSection={<IconSparkles size={12} />}>
                      New Collections
                    </Badge>
                  </Group>
                  <Text fw={700} size="sm" className="text-gray-900 dark:text-gray-100">
                    Newly Created Schemas
                  </Text>
                  <Text size="xs" c="dimmed" className="leading-relaxed">
                    Lists Lexicon schemas first detected within the past 7, 30, or 90 days. Can be sorted by newest first or total user count.
                  </Text>
                </Box>
                <Box mt="sm" pt="sm" className="border-t border-gray-100 dark:border-gray-800 text-[11px] text-gray-500">
                  ✨ <strong>Best for:</strong> Tracking new protocol experiments, developer tools, and early schemas.
                </Box>
              </Paper>
            </SimpleGrid>
          </Box>

          <Divider />

          {/* Section: Collections & Custom Feeds */}
          <SimpleGrid cols={{ base: 1, md: 2 }} spacing="lg">
            {/* Collections Guide */}
            <Box className="space-y-3">
              <Group gap="xs" align="center">
                <ThemeIcon size={28} radius="md" color="indigo" variant="light">
                  <IconDatabase size={18} />
                </ThemeIcon>
                <Title order={2} size="h4" className="text-gray-900 dark:text-white">
                  2. Collections: Schema Browser
                </Title>
              </Group>
              <Text size="xs" c="dimmed" className="leading-relaxed">
                Browse and search all indexed atproto collections. Click any row to view interactive time-series charts showing daily/monthly record counts and cumulative unique user growth over time.
              </Text>
            </Box>

            {/* Custom Feed Guide */}
            <Box className="space-y-3">
              <Group gap="xs" align="center">
                <ThemeIcon size={28} radius="md" color="cyan" variant="light">
                  <IconRss size={18} />
                </ThemeIcon>
                <Title order={2} size="h4" className="text-gray-900 dark:text-white">
                  3. Custom Feed: Feed Generators
                </Title>
              </Group>
              <Text size="xs" c="dimmed" className="leading-relaxed">
                Explore Bluesky custom feed algorithms, generator usage stats, and community feed adoption across the network.
              </Text>
            </Box>
          </SimpleGrid>

          <Divider />

          {/* Support: Buy Me a Coffee Banner */}
          <Paper
            withBorder
            p="lg"
            radius="lg"
            className="bg-gradient-to-r from-amber-50/60 to-orange-50/60 dark:from-amber-950/20 dark:to-orange-950/20 border-amber-200 dark:border-amber-800/60"
          >
            <Group justify="space-between" align="center" wrap="wrap" gap="md">
              <Group gap="md" wrap="nowrap">
                <ThemeIcon size={44} radius="md" color="yellow" variant="light">
                  <IconCoffee size={24} className="text-amber-600 dark:text-amber-400" />
                </ThemeIcon>
                <Box>
                  <Text fw={700} size="sm" className="text-gray-900 dark:text-white">
                    Support the Project
                  </Text>
                  <Text size="xs" c="dimmed" className="mt-0.5">
                    atproto Dashboard is independently developed and hosted by @usounds.work. If you find this dashboard helpful, buying a coffee is greatly appreciated to support server costs and ongoing development!
                  </Text>
                </Box>
              </Group>

              <a
                href="https://www.buymeacoffee.com/usounds"
                target="_blank"
                rel="noopener noreferrer"
                className="transition duration-150 hover:opacity-90 active:scale-95 flex-shrink-0"
              >
                <img
                  src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png"
                  alt="Buy Me A Coffee"
                  style={{ height: '42px', width: 'auto' }}
                />
              </a>
            </Group>
          </Paper>
        </Stack>
      </Box>
    </>
  );
};

export default About;
