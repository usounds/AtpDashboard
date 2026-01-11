import { ApexOptions } from 'apexcharts';
import React, { useState, useEffect } from 'react';
import ReactApexChart from 'react-apexcharts';
import { DailySummary } from '../../types/collection';

interface WeekChartProps {
  newView: string;
  newTitle: string;
  activeView: string;
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

interface ChartTwoState {
  series: {
    name: string;
    data: number[];
  }[];
}

const WeekChart: React.FC<WeekChartProps> = ({ newTitle, newView, activeTitle, activeView, title }) => {
  const [state, setState] = useState<ChartTwoState>({
    series: [

    ],
  });
  const [range, setRange] = useState<string>('30 Days');
  const [currentOption, setCurrentOption] = useState<ApexOptions>(options);
  const handleReset = () => {
    setState((prevState) => ({
      ...prevState,
    }));
  };
  handleReset;

  const getMappedDailySummary = async (view: string): Promise<number[]> => {
    const limit = range === '7 Days' ? 7 : range === '30 Days' ? 30 : 365;
    // APIからデータを取得
    const newResult = await fetch(`https://collectiondata.usounds.work/${view}?limit=${limit}`);

    // エラーチェック
    if (!newResult.ok) {
      throw new Error(`Error: ${newResult.statusText}`);
    }

    // JSONレスポンスをDailySummary型として受け取る
    const newList = await newResult.json() as DailySummary[];

    // day の最小値と最大値を取得
    const minDay = Math.min(...newList.map(({ day }) => day));
    const maxDay = Math.max(...newList.map(({ day }) => day));

    // day をキーにしたマップを作成
    const dayMap = new Map(newList.map(({ day, count }) => [day, count]));

    // 欠損補完しつつ count の配列を作成
    const completeSummaryList = [];
    for (let d = minDay; d <= maxDay; d++) {
      completeSummaryList.push(dayMap.get(d) ?? 0);
    }

    // 365日表示の場合は30日ごとのバケットに集計
    if (range === '365 Days') {
      const bucketSize = 30;
      const bucketed: number[] = [];
      for (let i = 0; i < completeSummaryList.length; i += bucketSize) {
        const slice = completeSummaryList.slice(i, i + bucketSize);
        const sum = slice.reduce((a, b) => a + b, 0);
        bucketed.push(sum);
      }
      // 逆順にして最新のバケットが先頭になるように
      return bucketed.reverse();
    }

    return completeSummaryList.reverse(); // 逆順にする
  };

  const loadData = async () => {
    const newResult = await getMappedDailySummary(newView);
    const activeResult = await getMappedDailySummary(activeView);

    // カテゴリはバケット数に合わせて生成
    const categories = activeResult.map((_, index) => {
      const result = activeResult.length - index - 1;
      // 30日バケットの場合は "-30", "-60" など、1日バケットの場合は "-1", "-2" ...
      if (range === '365 Days') {
        const days = (result + 1) * 30; // 1 バケット = 30日
        return `-${days}`;
      }
      return result === 0 ? '0' : `-${result}`;
    });

    const maxValue = Math.max(...activeResult) * 1.05;

    setCurrentOption((prevOptions) => ({
      ...prevOptions,
      xaxis: {
        ...prevOptions.xaxis,
        categories,
      },
      yaxis: {
        ...prevOptions.yaxis,
        max: maxValue,
      },
    }));

    setState({
      series: [
        {
          name: activeTitle,
          data: activeResult,
        },
        {
          name: newTitle,
          data: newResult,
        },
      ],
    });
  };

  useEffect(() => {
    // データを取得する非同期関数
    const fetchData = async () => {
      try {

        await loadData()

      } catch (err: any) {
        //setError(err.message);
      }
    };

    fetchData();
  }, [range]);

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
        <div id="chartTwo" className="-ml-5 -mb-9">
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
