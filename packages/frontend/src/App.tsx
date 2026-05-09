import { useEffect, useState } from 'react';
import { Route, Routes, useLocation } from 'react-router-dom';
import Loader from './common/Loader';
import PageTitle from './components/PageTitle';
import DefaultLayout from './layout/DefaultLayout';
import ATmosphere from './pages/Dashboard/ATmosphere';
import CollectonBrowser from './pages/Dashboard/CollectonBrowser';
import CustomFeedDashboard from './pages/Dashboard/CustomFeedDashboard';
import ChartBoard from './pages/Dashboard/ChartBoard';

function App() {
  const [loading, setLoading] = useState<boolean>(true);
  const { pathname } = useLocation();

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);

  useEffect(() => {
    setTimeout(() => setLoading(false), 1000);
  }, []);

  return loading ? (
    <Loader />
  ) : (
    <DefaultLayout>
      <Routes>
        <Route
          index
          element={
            <>
              <PageTitle title="3rd Party Collection | ATProto Dashboard" />
              <ATmosphere />
            </>
          }
        />

        <Route
          path="/collection/browser"
          element={
            <>
              <PageTitle title="3rd Party Collection Browser | ATProto Dashboard" />
              <CollectonBrowser />
            </>
          }
        />

        <Route
          path="/customfeed/dashboard"
          element={
            <>
              <PageTitle title="Custom Feed | ATProto Dashboard" />
              <CustomFeedDashboard />
            </>
          }
        />

        <Route
          path="/collectionChart"
          element={
            <>
              <PageTitle title="Calendar | TailAdmin - Tailwind CSS Admin Dashboard Template" />
              <ChartBoard />
            </>
          }
        />
      </Routes>
    </DefaultLayout>
  );
}

export default App;
