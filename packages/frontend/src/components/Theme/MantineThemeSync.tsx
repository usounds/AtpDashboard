import React, { useEffect } from 'react';
import { useMantineColorScheme, createTheme, type MantineThemeOverride } from '@mantine/core';

export const mantineTheme: MantineThemeOverride = createTheme({
  fontFamily: 'Satoshi, sans-serif',
  headings: {
    fontFamily: 'Satoshi, sans-serif',
  },
  colors: {
    brand: [
      '#eef2ff',
      '#e0e7ff',
      '#c7d2fe',
      '#a5b4fc',
      '#818cf8',
      '#6366f1',
      '#4f46e5',
      '#3c50e0',
      '#3730a3',
      '#312e81',
    ],
  },
  primaryColor: 'brand',
  primaryShade: 7,
  defaultRadius: 'md',
});

export const MantineTailwindSync: React.FC = () => {
  const { colorScheme } = useMantineColorScheme();

  useEffect(() => {
    const isDark =
      colorScheme === 'dark' ||
      (colorScheme === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);

    const root = document.documentElement;
    const body = document.body;

    if (isDark) {
      root.classList.add('dark');
      body.classList.add('dark');
      localStorage.setItem('color-theme', 'dark');
    } else {
      root.classList.remove('dark');
      body.classList.remove('dark');
      localStorage.setItem('color-theme', 'light');
    }
  }, [colorScheme]);

  return null;
};
