import { ApexOptions } from 'apexcharts';
import React, { useState, useEffect, useRef } from 'react';
import ReactApexChart from 'react-apexcharts';
import {
  buildDailyChartCategories,
  buildDailyChartSeries,
  buildDailyChartUrl,
  type DailyChartMetric,
  type DailyChartRange,
  type DailyChartResponse,
} from './dailyChart';
import { removeApexSvgTitle } from './chartLabels';

interface WeekChartProps {
  metric: DailyChartMetric;
  newTitle: string;
  activeTitle: string;
  title: string;
}

const options: ApexOptions = {
  legend: {
    show: true,
    position: 'top',
    horizontalAlign: 'center',
  },
  colors: ['#3C50E0', '#80CAEE',],
  chart: {
    fontFamily: 'Satoshi, sans-serif',
    height: 335,
    type: 'area',
    dropShadow: {
      enabled: true,
      color: '#623CEA14',
      top: 10,
      blur: 4,
      left: 0,
      opacity: 0.1,
    },

    toolbar: {
      show: false,
    },
    events: {
      mounted: (chartContext) => removeApexSvgTitle(chartContext),
      updated: (chartContext) => removeApexSvgTitle(chartContext),
    },
  },
  responsive: [
    {
      breakpoint: 1024,
      options: {
        chart: {
          height: 300,
        },
      },
    },
    {
      breakpoint: 1366,
      options: {
        chart: {
          height: 350,
        },
      },
    },
  ],
  stroke: {
    width: [2, 2],
    curve: 'straight',
  },
  // labels: {
  //   show: false,
  //   position: "top",
  // },
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
  dataLabels: {
    enabled: false,
  },
  markers: {
    size: 4,
    colors: '#fff',
    strokeColors: ['#3056D3', '#80CAEE'],
    strokeWidth: 3,
    strokeOpacity: 0.9,
    strokeDashArray: 0,
    fillOpacity: 1,
    discrete: [],
    hover: {
      size: undefined,
      sizeOffset: 5,
    },
  },
  xaxis: {
    type: 'category',
    categories: [

    ],
    axisBorder: {
      show: false,
    },
    axisTicks: {
      show: false,
    },
  },
  yaxis: {
    title: {
      style: {
        fontSize: '0px',
      },
    },
    min: 0,
    labels: {
      formatter: function (val) {
        return val.toFixed(0);
      },
    },
  },
};

interface WeekChartState {
  series: {
    name: string;
    data: number[];
  }[];
}

const WeekChart: React.FC<WeekChartProps> = ({ metric, newTitle, activeTitle, title }) => {
  const [state, setState] = useState<WeekChartState>({
    series: [

    ],
  });
  const [range, setRange] = useState<DailyChartRange>('30 Days');
  const [currentOption, setCurrentOption] = useState<ApexOptions>(options);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const requestIdRef = useRef(0);
  const handleReset = () => {
    setState((prevState) => ({
      ...prevState,
    }));
  };
  handleReset;

  const loadData = async (requestId: number) => {
    const response = await fetch(buildDailyChartUrl(metric, range));
    if (!response.ok) {
      throw new Error(`Error: ${response.statusText}`);
    }

    const result = await response.json() as DailyChartResponse;
    const categories = buildDailyChartCategories(result.rows);
    const series = buildDailyChartSeries(result.rows, activeTitle, newTitle);
    const activeValues = result.rows.map((row) => row.active);
    const maxValue = Math.max(...activeValues, 0) * 1.05;

    if (requestId !== requestIdRef.current) {
      return;
    }

    setCurrentOption((prevOptions) => ({
      ...prevOptions,
      xaxis: {
        ...prevOptions.xaxis,
        categories,
      },
      yaxis: {
        ...prevOptions.yaxis,
        max: maxValue > 0 ? maxValue : 1,
      },
    }));

    setState({
      series,
    });
  };

  useEffect(() => {
    let cancelled = false;
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;

    const fetchData = async () => {
      setIsLoading(true);
      try {
        await loadData(requestId)
      } catch (err: any) {
        //setError(err.message);
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
    <div className="col-span-12 rounded-sm border border-stroke bg-white p-7.5 shadow-default dark:border-strokedark dark:bg-boxdark xl:col-span-6">
      <div className="flex flex-wrap items-start justify-between gap-3 sm:flex-nowrap">
        <div className="flex w-full flex-wrap gap-3 sm:gap-5">
          <div className="flex min-w-47.5">
            <div className="w-full">
              <span className="font-semibold text-black dark:text-white">{title}</span>
            </div>
          </div>
        </div>
        <div className="flex w-full max-w-45 justify-end">
          <div className="inline-flex items-center gap-1 rounded-md bg-slate-200 p-1.5 dark:bg-meta-4">
            <button
              className={`rounded py-1 px-3 text-xs font-medium 
                      ${range === "7 Days" ? " text-black bg-white dark:bg-boxdark dark:text-white"
                  : "text-black hover:bg-white hover:shadow-card dark:text-white dark:hover:bg-boxdark"}`}
              onClick={() => setRange("7 Days")}
            >
              This Week
            </button>
            <button
              className={`rounded py-1 px-3 text-xs font-medium 
                      ${range === "30 Days" ? "text-black bg-white dark:bg-boxdark dark:text-white"
                  : "text-black hover:bg-white hover:shadow-card dark:text-white dark:hover:bg-boxdark"}`}
              onClick={() => setRange("30 Days")}
            >
              This Month
            </button>
            <button
              className={`rounded py-1 px-3 text-xs font-medium 
                      ${range === "365 Days" ? "text-black bg-white dark:bg-boxdark dark:text-white"
                  : "text-black hover:bg-white hover:shadow-card dark:text-white dark:hover:bg-boxdark"}`}
              onClick={() => setRange("365 Days")}
            >
              This Year
            </button>
          </div>
        </div>
      </div>

      <div>
        <div id="chartTwo" className="relative -ml-5 -mb-9">
          {isLoading && (
            <div className="absolute inset-0 z-10 flex items-center justify-center bg-white/60 dark:bg-boxdark/60" aria-label="Loading chart">
              <span className="h-8 w-8 animate-spin rounded-full border-4 border-slate-200 border-t-primary" />
            </div>
          )}
          <ReactApexChart
            options={currentOption}
            series={state.series}
            type="area"
            height={350}
          />
        </div>
      </div>
    </div>
  );
};

export default WeekChart;
