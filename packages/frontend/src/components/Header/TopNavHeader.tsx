import React from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import {
  Group,
  Burger,
  Drawer,
  ActionIcon,
  useMantineColorScheme,
  useComputedColorScheme,
  Box,
  Text,
  Stack,
  Divider,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import {
  IconSun,
  IconMoon,
  IconBrandGithub,
  IconDatabase,
  IconRss,
  IconCompass,
  IconInfoCircle,
} from '@tabler/icons-react';
import LogoIcon from '../../images/logo/logo-icon.svg';

interface NavItem {
  to: string;
  label: string;
  icon: React.ComponentType<{ size?: number; stroke?: number }>;
  exact?: boolean;
}

const navItems: NavItem[] = [
  {
    to: '/',
    label: 'Explore',
    icon: IconCompass,
    exact: true,
  },
  {
    to: '/collections',
    label: 'Collections',
    icon: IconDatabase,
  },
  {
    to: '/customfeed/dashboard',
    label: 'Custom Feed',
    icon: IconRss,
  },
  {
    to: '/about',
    label: 'Guide',
    icon: IconInfoCircle,
  },
];

export const TopNavHeader: React.FC = () => {
  const [opened, { toggle, close }] = useDisclosure(false);
  const { toggleColorScheme } = useMantineColorScheme();
  const computedColorScheme = useComputedColorScheme('light', { getInitialValueInEffect: true });
  const location = useLocation();

  const isNavActive = (item: NavItem) => {
    if (item.exact) {
      return location.pathname === item.to;
    }
    return location.pathname.startsWith(item.to);
  };

  return (
    <Box className="w-full h-full px-4 md:px-8 border-b border-gray-200 dark:border-gray-800 bg-white dark:bg-[#182234]">
      <Group justify="space-between" h="100%" wrap="nowrap">
        {/* Brand & Desktop Navigation */}
        <Group gap="xl" wrap="nowrap">
          <NavLink to="/" className="flex items-center gap-2.5 no-underline">
            <img src={LogoIcon} alt="Logo" className="w-7 h-7" />
            <Text fw={700} size="md" className="tracking-tight text-gray-900 dark:text-white">
              atproto <span className="text-[#3C50E0]">Dashboard</span>
            </Text>
          </NavLink>

          {/* Desktop Navigation Links */}
          <Group gap={6} className="hidden md:flex">
            {navItems.map((item) => {
              const active = isNavActive(item);
              const Icon = item.icon;
              return (
                <NavLink
                  key={item.to}
                  to={item.to}
                  className={`flex items-center gap-2 px-3.5 py-1.5 rounded-lg text-sm font-medium transition-all no-underline ${
                    active
                      ? 'bg-[#3C50E0] text-white shadow-sm'
                      : 'text-gray-600 hover:text-gray-900 hover:bg-gray-100 dark:text-gray-300 dark:hover:text-white dark:hover:bg-gray-800'
                  }`}
                >
                  <Icon size={16} stroke={2} />
                  <span>{item.label}</span>
                </NavLink>
              );
            })}
          </Group>
        </Group>

        {/* Right Actions */}
        <Group gap="xs" wrap="nowrap">
          {/* GitHub link */}
          <ActionIcon
            component="a"
            href="https://github.com/usounds/AtpDashboard"
            target="_blank"
            rel="noopener noreferrer"
            variant="default"
            size="lg"
            radius="md"
            aria-label="GitHub Repository"
            className="border-gray-200 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-800"
          >
            <IconBrandGithub size={18} stroke={1.5} />
          </ActionIcon>

          {/* Dark / Light Mode Toggler */}
          <ActionIcon
            onClick={() => toggleColorScheme()}
            variant="default"
            size="lg"
            radius="md"
            aria-label="Toggle color scheme"
            className="border-gray-200 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-700 dark:text-gray-200"
          >
            {computedColorScheme === 'dark' ? (
              <IconSun size={18} stroke={1.8} className="text-amber-400" />
            ) : (
              <IconMoon size={18} stroke={1.8} className="text-indigo-600" />
            )}
          </ActionIcon>

          {/* Mobile Drawer Hamburger */}
          <Burger
            opened={opened}
            onClick={toggle}
            className="md:hidden"
            size="sm"
            aria-label="Toggle navigation"
          />
        </Group>
      </Group>

      {/* Mobile Navigation Drawer */}
      <Drawer
        opened={opened}
        onClose={close}
        title={
          <Group gap="xs">
            <img src={LogoIcon} alt="Logo" className="w-6 h-6" />
            <Text fw={700} size="sm">
              atproto Dashboard
            </Text>
          </Group>
        }
        padding="md"
        size="xs"
      >
        <Stack gap="xs" mt="md">
          {navItems.map((item) => {
            const active = isNavActive(item);
            const Icon = item.icon;
            return (
              <NavLink
                key={item.to}
                to={item.to}
                onClick={close}
                className={`flex items-center gap-3 px-4 py-2.5 rounded-lg text-sm font-medium transition-colors no-underline ${
                  active
                    ? 'bg-[#3C50E0] text-white'
                    : 'text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-800'
                }`}
              >
                <Icon size={18} stroke={1.8} />
                <span>{item.label}</span>
              </NavLink>
            );
          })}
        </Stack>

        <Divider my="md" />

        <Stack gap="xs" px="xs">
          <Group justify="space-between">
            <Text size="xs" c="dimmed">
              Theme
            </Text>
            <ActionIcon
              onClick={() => toggleColorScheme()}
              variant="default"
              size="md"
              radius="md"
              aria-label="Toggle color scheme"
            >
              {computedColorScheme === 'dark' ? (
                <IconSun size={16} stroke={1.8} className="text-amber-400" />
              ) : (
                <IconMoon size={16} stroke={1.8} className="text-indigo-600" />
              )}
            </ActionIcon>
          </Group>
        </Stack>
      </Drawer>
    </Box>
  );
};

export default TopNavHeader;
