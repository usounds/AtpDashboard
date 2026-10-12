import { useEffect } from 'react';
import { Route, Routes, useLocation, Navigate } from 'react-router-dom';
import PageTitle from './components/PageTitle';
import TopNavLayout from './layout/TopNavLayout';
import CollectionsDashboard from './pages/Dashboard/CollectionsDashboard';
import CustomFeedDashboard from './pages/Dashboard/CustomFeedDashboard';
import Explore from './pages/Dashboard/Explore';
import About from './pages/About/About';
import { useCollectionStore } from './zustand/collectionStore';

function App() {
  const { pathname } = useLocation();

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);

  // Eagerly prefetch collections on startup
  useEffect(() => {
    useCollectionStore.getState().fetchCollection();
  }, []);

  return (
    <TopNavLayout>
      <Routes>
        <Route
          index
          element={
            <>
              <PageTitle title="Explore | atproto Dashboard" />
              <Explore />
            </>
          }
        />

        <Route
          path="/collections"
          element={
            <>
              <PageTitle title="Collections | atproto Dashboard" />
              <CollectionsDashboard />
            </>
          }
        />

        {/* Redirect aliases for backward compatibility */}
        <Route path="/overview" element={<Navigate to="/collections" replace />} />
        <Route path="/collection/browser" element={<Navigate to="/collections" replace />} />
        <Route path="/explore" element={<Navigate to="/" replace />} />

        <Route
          path="/customfeed/dashboard"
          element={
            <>
              <PageTitle title="Custom Feed | atproto Dashboard" />
              <CustomFeedDashboard />
            </>
          }
        />

        <Route
          path="/about"
          element={
            <>
              <PageTitle title="About & Guide | atproto Dashboard" />
              <About />
            </>
          }
        />
        <Route path="/guide" element={<Navigate to="/about" replace />} />
        <Route path="/help" element={<Navigate to="/about" replace />} />
      </Routes>
    </TopNavLayout>
  );
}

export default App;
