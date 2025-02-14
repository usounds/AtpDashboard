import { ApexOptions } from 'apexcharts';
import ReactApexChart from 'react-apexcharts';
import React, { useEffect, useState } from 'react';
import { DailySummary } from '../../types/collection';

const options: ApexOptions = {
  legend: {
    show: false,
    position: 'top',
    horizontalAlign: 'left',
  },
  colors: ['#3C50E0', '#80CAEE'],
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
    max: 10000,
  },
};

interface ChartOneState {
  series: {
    name: string;
    data: number[];
  }[];
}

const CollectionChart: React.FC = () => {
  const [state, setState] = useState<ChartOneState>({
    series: [
    ],
  });
  const [range, setRange] = useState<string>('30 Days');
  const [currentOption, setCurrentOption] = useState<ApexOptions>(options);

  const loadData = async () => {
    const limit = range === '7 Days' ? 7 : 30;

    const summary = await fetch('https://collectiondata.usounds.work/collection_daily_summary_view?limit=' + limit);
    if (!summary.ok) {
      throw new Error(`Error: ${summary.statusText}`);
    }

    const summaryList = await summary.json() as DailySummary[];
    const reversedSummaryList = [...summaryList].reverse();

    const categories = reversedSummaryList.map(({ day }) =>
      day === 1 ? 'Today' : `-${day - 1}`
    );

    const updatedOptions = { 
      ...options, 
      xaxis: { 
        ...options.xaxis, 
        categories 
      } 
    };

    const data = reversedSummaryList.map(({ count }) =>
      count
    );

    const maxValue = Math.max(...data);
    const roundedMaxValue = Math.ceil(maxValue / 1000) * 1000;

    if (options.yaxis) {
      (options.yaxis as ApexYAxis).max = roundedMaxValue;
    }

    console.log(data)
    setState({
      series: [
        {
          name: 'Events',
          data: data,
        },
      ],
    });

    console.log(options)
    setCurrentOption(updatedOptions)

  }

  useEffect(() => {
    const fetchData = async () => {
      try {

        await loadData()

      } catch (err: any) {
        //setError(err.message);
      }
    };

    fetchData();
  }, [range]);


  const handleReset = () => {
    setState((prevState) => ({
      ...prevState,
    }));
  };
  handleReset;

  return (
    <div className="col-span-12 rounded-sm border border-stroke bg-white px-5 pt-7.5 pb-5 shadow-default dark:border-strokedark dark:bg-boxdark sm:px-7.5 xl:col-span-12">
      <div className="flex flex-wrap items-start justify-between gap-3 sm:flex-nowrap">
        <div className="flex w-full flex-wrap gap-3 sm:gap-5">
          <div className="flex min-w-47.5">
            <span className="mt-1 mr-2 flex h-4 w-full max-w-4 items-center justify-center rounded-full border border-primary">
              <span className="block h-2.5 w-full max-w-2.5 rounded-full bg-primary"></span>
            </span>
            <div className="w-full">
              <p className="font-semibold text-primary">Event Counts</p>
            </div>
          </div>
        </div>
        <div className="flex w-full max-w-45 justify-end">
          <div className="inline-flex items-center rounded-md bg-whiter p-1.5 dark:bg-meta-4">
            <button
              className={`rounded py-1 px-3 text-xs font-medium shadow-card 
                      ${range === "7 Days" ? "bg-white text-black dark:bg-boxdark dark:text-white"
                  : "text-black hover:bg-white hover:shadow-card dark:text-white dark:hover:bg-boxdark"}`}
              onClick={() => setRange("7 Days")}
            >
              This Week
            </button>
            <button
              className={`rounded py-1 px-3 text-xs font-medium  
                      ${range === "30 Days" ? "bg-white text-black dark:bg-boxdark dark:text-white"
                  : "text-black hover:bg-white hover:shadow-card dark:text-white dark:hover:bg-boxdark"}`}
              onClick={() => setRange("30 Days")}
            >
              This Month
            </button>
          </div>
        </div>
      </div>

      <div>
        <div id="chartOne" className="-ml-5">
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

export default CollectionChart;
