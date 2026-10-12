import '@mantine/core/styles.css';
import '@mantine/charts/styles.css';
import './css/style.css';
import './css/satoshi.css';

import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter as Router } from 'react-router-dom';
import { MantineProvider } from '@mantine/core';
import App from './App';
import { mantineTheme, MantineTailwindSync } from './components/Theme/MantineThemeSync';

const initialColorScheme =
  typeof window !== 'undefined' && localStorage.getItem('color-theme') === 'dark'
    ? 'dark'
    : 'light';

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <MantineProvider theme={mantineTheme} defaultColorScheme={initialColorScheme}>
      <MantineTailwindSync />
      <Router>
        <App />
      </Router>
    </MantineProvider>
  </React.StrictMode>,
);
