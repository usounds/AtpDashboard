import React, { ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { AppShell, Box, Group } from '@mantine/core';
import { IconCoffee, IconBrandGithub } from '@tabler/icons-react';
import TopNavHeader from '../components/Header/TopNavHeader';

interface TopNavLayoutProps {
  children: ReactNode;
}

const TopNavLayout: React.FC<TopNavLayoutProps> = ({ children }) => {
  return (
    <AppShell
      header={{ height: 60 }}
      className="min-h-screen bg-[#F1F5F9] dark:bg-[#0F172A] text-slate-900 dark:text-slate-100 transition-colors flex flex-col"
    >
      <AppShell.Header className="bg-white dark:bg-[#182234] border-b border-gray-200 dark:border-gray-800 z-50">
        <TopNavHeader />
      </AppShell.Header>

      <AppShell.Main pt={60} className="flex-1 flex flex-col justify-between">
        <Box className="mx-auto max-w-screen-2xl p-4 md:p-6 2xl:p-8 w-full flex-1">
          {children}
        </Box>

        <Box component="footer" className="py-6 border-t border-gray-200 dark:border-gray-800 bg-white/50 dark:bg-[#182234]/50 text-xs text-gray-500 dark:text-gray-400">
          <Group justify="center" gap="md" wrap="wrap" className="px-4">
            <span className="font-semibold text-gray-700 dark:text-gray-300">atproto Dashboard</span>
            <span>·</span>
            <NavLink to="/about" className="hover:text-blue-500 dark:hover:text-blue-400 transition-colors no-underline text-inherit">
              Guide & About
            </NavLink>
            <span>·</span>
            <a
              href="https://github.com/usounds/AtpDashboard"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-blue-500 dark:hover:text-blue-400 transition-colors no-underline text-inherit inline-flex items-center gap-1"
            >
              <IconBrandGithub size={13} /> GitHub
            </a>
            <span>·</span>
            <a
              href="https://www.buymeacoffee.com/usounds"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-400 font-semibold hover:underline"
            >
              <IconCoffee size={14} /> Buy Me a Coffee
            </a>
          </Group>
        </Box>
      </AppShell.Main>
    </AppShell>
  );
};

export default TopNavLayout;
