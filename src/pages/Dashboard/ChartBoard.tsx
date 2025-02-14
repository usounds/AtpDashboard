import React, { useEffect } from 'react';
import CollectionChart from '../../components/Charts/CollectionChart';
import WeekChart from '../../components/Charts/WeekChart';

const ChartBoard: React.FC = () => {

  const loadData = async () => {

  }
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
  }, []);

  return (
    <>
      <div className="mt-4 grid grid-cols-12 gap-4 md:mt-6 md:gap-6 2xl:mt-7.5 2xl:gap-7.5">
        <CollectionChart />
        <WeekChart newView='new_collection_summary_view' newTitle="New" activeView='active_collection_summary_view' activeTitle="Active" title='Collections' />
        <WeekChart newView='new_did_summary_view' newTitle="New" activeView='active_did_summary_view' activeTitle="Active" title='Users' />
      </div>
    </>
  );
};

export default ChartBoard;
