import { ApexOptions } from 'apexcharts';
import React, { useEffect, useRef, useState } from "react";
import ReactApexChart from 'react-apexcharts';
import useColorMode from '../hooks/useColorMode';
import { BarLoader } from 'react-spinners';
import { resolveAnalyticsEndpoint } from '../config/endpoints';
import {
  buildCollectionCumulativeUsersCategories,
  buildCollectionCumulativeUsersSeries,
  buildCollectionCumulativeUsersUrl,
  type CollectionCumulativeUsersRange,
  type CollectionCumulativeUsersResponse,
} from './Charts/collectionCumulativeUsers';
import { removeApexSvgTitle } from './Charts/chartLabels';

type Stats = {
  unique_did: number;
  min_createdat: string;
  max_createdat: string;
  unique_rkey: number;
  total_count: number;
};

type Props = {
  collection: string;
};

type StatsTab = 'summary' | 'cumulative';

type CumulativeChartState = {
  series: {
    name: string;
    data: number[];
  }[];
};

const cumulativeUsersOptions: ApexOptions = {
  legend: {
    show: true,
    position: 'top',
    horizontalAlign: 'center',
    fontFamily: 'Satoshi',
    markers: {
      size: 5,
    },
  },
  colors: ['#3C50E0', '#80CAEE'],
  chart: {
    id: 'collection-cumulative-users',
    fontFamily: 'Satoshi, sans-serif',
    height: 300,
    type: 'area',
    redrawOnParentResize: true,
    redrawOnWindowResize: true,
    parentHeightOffset: 0,
    toolbar: {
      show: false,
    },
    events: {
      mounted: (chartContext) => removeApexSvgTitle(chartContext),
      updated: (chartContext) => removeApexSvgTitle(chartContext),
    },
  },
  fill: {
    gradient: {
      opacityFrom: 0.45,
      opacityTo: 0,
    },
  },
  dataLabels: {
    enabled: false,
  },
  stroke: {
    curve: 'smooth',
    width: 2,
  },
  grid: {
    xaxis: {
      lines: {
        show: true,
      },
    },
    yaxis: {
      lines: {
        show: true,
      },
    },
  },
  markers: {
    size: 3,
    strokeWidth: 2,
    hover: {
      size: 5,
    },
  },
  xaxis: {
    type: 'category',
    categories: [],
    axisBorder: {
      show: false,
    },
    axisTicks: {
      show: false,
    },
  },
  yaxis: {
    min: 0,
    labels: {
      formatter: (val) => val.toFixed(0),
    },
  },
};

const StatsViewer: React.FC<Props> = ({ collection }) => {
  const [stats, setStats] = useState<Stats | null>(null);
  const [isLoading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<StatsTab>('summary');
  const [range, setRange] = useState<CollectionCumulativeUsersRange>('365 Days');
  const [cumulativeState, setCumulativeState] = useState<CumulativeChartState>({ series: [] });
  const [cumulativeOptions, setCumulativeOptions] = useState<ApexOptions>(cumulativeUsersOptions);
  const [isCumulativeLoading, setCumulativeLoading] = useState(false);
  const [cumulativeError, setCumulativeError] = useState<string | null>(null);
  const [cumulativeChartKey, setCumulativeChartKey] = useState(0);
  const cumulativeRequestIdRef = useRef(0);
  const [colorMode,] = useColorMode();

  useEffect(() => {
    let cancelled = false;
    const fetchStats = async () => {
      try {
        setLoading(true);
        setError(null);
        const url = `${resolveAnalyticsEndpoint('collection_stats')}?collection=${encodeURIComponent(collection)}`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data: Stats[] = await res.json();
        if (cancelled) return;
        setStats(data[0] || null);
      } catch (err: any) {
        if (cancelled) return;
        setError(err.message);
        setStats(null);
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };
    fetchStats();
    return () => {
      cancelled = true;
    };
  }, [collection]);

  useEffect(() => {
    if (tab !== 'cumulative') return;

    let cancelled = false;
    const requestId = cumulativeRequestIdRef.current + 1;
    cumulativeRequestIdRef.current = requestId;
    const fetchCumulativeUsers = async () => {
      setCumulativeLoading(true);
      setCumulativeError(null);
      try {
        const res = await fetch(buildCollectionCumulativeUsersUrl(collection, range));
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json() as CollectionCumulativeUsersResponse;
        if (cancelled || requestId !== cumulativeRequestIdRef.current) return;
        const categories = buildCollectionCumulativeUsersCategories(data.rows);
        const series = buildCollectionCumulativeUsersSeries(data.rows);
        const maxValue = Math.max(...data.rows.map((row) => row.cumulative), 0) * 1.05;
        setCumulativeOptions((prevOptions) => ({
          ...prevOptions,
          chart: {
            ...prevOptions.chart,
            id: `collection-cumulative-users-${requestId}`,
          },
          xaxis: {
            ...prevOptions.xaxis,
            categories,
          },
          yaxis: {
            ...prevOptions.yaxis,
            max: maxValue > 0 ? maxValue : 1,
          },
        }));
        setCumulativeState({ series });
        setCumulativeChartKey((value) => value + 1);
      } catch (err: any) {
        if (cancelled || requestId !== cumulativeRequestIdRef.current) return;
        setCumulativeError(err.message);
        setCumulativeState({ series: [] });
        setCumulativeChartKey((value) => value + 1);
      } finally {
        if (!cancelled && requestId === cumulativeRequestIdRef.current) {
          setCumulativeLoading(false);
        }
      }
    };
    fetchCumulativeUsers();
    return () => {
      cancelled = true;
    };
  }, [collection, range, tab]);

  // Loading 表示は消す（常に表は表示）
  // エラーは表の上に表示する形に変更
  return (
    <div className="overflow-x-auto">
      <div className="mb-4 inline-flex items-center gap-1 rounded-md bg-slate-200 p-1.5 dark:bg-meta-4">
        <button
          className={`rounded py-1 px-3 text-xs font-medium ${tab === 'summary'
            ? 'text-black bg-white dark:bg-boxdark dark:text-white'
            : 'text-black hover:bg-white hover:shadow-card dark:text-white dark:hover:bg-boxdark'}`}
          onClick={() => setTab('summary')}
        >
          Summary
        </button>
        <button
          className={`rounded py-1 px-3 text-xs font-medium ${tab === 'cumulative'
            ? 'text-black bg-white dark:bg-boxdark dark:text-white'
            : 'text-black hover:bg-white hover:shadow-card dark:text-white dark:hover:bg-boxdark'}`}
          onClick={() => setTab('cumulative')}
        >
          Cumulative Users
        </button>
      </div>

      {tab === 'summary' && (
        <>
          {error && <div style={{ color: "red" }}>Error: {error}</div>}

          {isLoading &&
            <BarLoader
              width="100%"
              color={colorMode === 'dark' ? "#a6a6a6" : '#000000'}
            />
          }
          <table className="table-auto w-full text-left border-collapse">
            <tbody>
              <tr className="border-b border-gray-300 dark:border-gray-700 align-top">
                <th className="px-4 py-2 align-top whitespace-nowrap">Collection</th>
                <td className="px-4 py-2">{collection}</td>
                <th className="px-4 py-2 align-top whitespace-nowrap">Total DIDs</th>
                <td className="px-4 py-2">{stats ? stats.unique_did.toLocaleString() : "-"}</td>
              </tr>

              <tr className="border-b border-gray-300 dark:border-gray-700">
                <th className="px-4 py-2 whitespace-nowrap">Records</th>
                <td className="px-4 py-2">{stats ? stats.unique_rkey.toLocaleString() : "-"}</td>
                <th className="px-4 py-2 whitespace-nowrap">Events</th>
                <td className="px-4 py-2">{stats ? stats.total_count.toLocaleString() : "-"}</td>
              </tr>
              <tr>
                <th className="px-4 py-2 whitespace-nowrap">First Indexed</th>
                <td className="px-4 py-2">
                  {stats && stats.min_createdat
                    ? stats.min_createdat.startsWith("1900-01-01")
                      ? "Backfilled Data"
                      : new Date(stats.min_createdat + "Z").toLocaleString()
                    : "-"}
                </td>
                <th className="px-4 py-2 whitespace-nowrap">Last Indexed</th>
                <td className="px-4 py-2">
                  {stats && stats.max_createdat
                    ? stats.max_createdat.startsWith("1900-01-01")
                      ? "Backfilled Data"
                      : new Date(stats.max_createdat + "Z").toLocaleString()
                    : "-"}
                </td>
              </tr>
            </tbody>
          </table>
        </>
      )}

      {tab === 'cumulative' && (
        <div>
          {cumulativeError && <div style={{ color: "red" }}>Error: {cumulativeError}</div>}
          <div className="mb-3 flex justify-end">
            <div className="inline-flex items-center gap-1 rounded-md bg-slate-200 p-1.5 dark:bg-meta-4">
              <button
                className={`rounded py-1 px-3 text-xs font-medium ${range === '7 Days'
                  ? 'text-black bg-white dark:bg-boxdark dark:text-white'
                  : 'text-black hover:bg-white hover:shadow-card dark:text-white dark:hover:bg-boxdark'}`}
                onClick={() => setRange('7 Days')}
              >
                This Week
              </button>
              <button
                className={`rounded py-1 px-3 text-xs font-medium ${range === '30 Days'
                  ? 'text-black bg-white dark:bg-boxdark dark:text-white'
                  : 'text-black hover:bg-white hover:shadow-card dark:text-white dark:hover:bg-boxdark'}`}
                onClick={() => setRange('30 Days')}
              >
                This Month
              </button>
              <button
                className={`rounded py-1 px-3 text-xs font-medium ${range === '365 Days'
                  ? 'text-black bg-white dark:bg-boxdark dark:text-white'
                  : 'text-black hover:bg-white hover:shadow-card dark:text-white dark:hover:bg-boxdark'}`}
                onClick={() => setRange('365 Days')}
              >
                This Year
              </button>
            </div>
          </div>
          <div className="relative pb-2">
            {isCumulativeLoading && (
              <div className="absolute inset-0 z-10 flex items-center justify-center bg-white/60 dark:bg-boxdark/60" aria-label="Loading cumulative users">
                <span className="h-8 w-8 animate-spin rounded-full border-4 border-slate-200 border-t-primary" />
              </div>
            )}
            <ReactApexChart
              key={`${collection}-${range}-${cumulativeChartKey}`}
              options={cumulativeOptions}
              series={cumulativeState.series}
              type="area"
              height={300}
            />
          </div>
        </div>
      )}
      <p className="text-xs text-gray-500 dark:text-gray-400 mt-4 text-center">
        Data may take up to 10 minutes to be reflected.
      </p>
    </div>
  );
};


export default StatsViewer;
