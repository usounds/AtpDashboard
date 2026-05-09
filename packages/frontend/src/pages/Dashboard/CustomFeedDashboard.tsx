import React, { useEffect, useState } from 'react';
import { BiTachometer } from "react-icons/bi";
import { FiUsers } from "react-icons/fi";
import { SiServerless, SiSharp } from "react-icons/si";
import CardDataStats from '../../components/CardDataStats';
import CustomFeedList from '../../components/CustomFeedList';

const CustomFeedDashboard: React.FC = () => {
  const [error, setError] = useState<string | null>(null);
  const [totalFeeedGenerator, setTotalFeeedGenerator] = useState<number>(0);
  const [totalCreator, setTotalCreator] = useState<number>(0);
  const [totalCustomFeed, setTotalCustomFeed] = useState<number>(0);
  const [newFeeedGenerator, setNewFeeedGenerator] = useState<number>(0);
  const [newCreator, setNewCreator] = useState<number>(0);
  const [newtalCustomFeed, setNewCustomFeed] = useState<number>(0);
  const [perCustomFeed, setPerCustomFeed] = useState<number>(0); // New Creators 用
  //const [perCustomFeedThisWeek, setPerCustomFeedThisWeek] = useState<number>(0); // New Creators 用
  const [_, setIsLoading] = useState(true);

  const loadData = async () => {
    setIsLoading(true)
    setTotalFeeedGenerator(0);
    setTotalCreator(0);
    setTotalCustomFeed(0);
    setPerCustomFeed(0)

    const fetchSummary = async () => {
      try {
        const res = await fetch("https://collectiondata.usounds.work/event_logs_summary");
        if (!res.ok) {
          throw new Error(`HTTP error: ${res.status}`);
        }

        const data = await res.json();

        if (Array.isArray(data) && data.length > 0) {
          const summary = data[0];

          // トータル
          setTotalFeeedGenerator(summary.total_servers ?? 0);
          setTotalCreator(summary.total_creators ?? 0);
          setTotalCustomFeed(summary.total_creator_rkeys ?? 0);
          setPerCustomFeed((summary.total_creator_rkeys ?? 0) / (summary.total_creators ?? 0));

          // 直近7日
          setNewFeeedGenerator(summary.new_servers ?? 0);
          setNewCreator(summary.new_creators ?? 0);
          setNewCustomFeed(summary.new_creator_rkeys ?? 0);
          //setPerCustomFeedThisWeek((summary.total_creator_rkeys ?? 0 - summary.new_creator_rkeys ?? 0) / (summary.total_creators ?? 0 - summary.new_creators ?? 0));
        }
      } catch (err) {
        console.error("Failed to fetch event_logs_summary:", err);
      }
    };
    fetchSummary();
    setIsLoading(false)

  }

  useEffect(() => {
    // データを取得する非同期関数
    const fetchData = async () => {
      try {

        await loadData()

      } catch (err: any) {
        setError(err.message);
      }
    };

    fetchData();
  }, []);

  return (
    <>
      {error}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 md:gap-6 xl:grid-cols-4 2xl:gap-7.5" onClick={loadData}>
        <CardDataStats title="Total Feed Generator Server" total={totalFeeedGenerator === 0 ? "Loading" : totalFeeedGenerator.toLocaleString()} rate={newFeeedGenerator.toLocaleString()} levelUp={newFeeedGenerator > 0}  >
          <SiServerless size={22} />
        </CardDataStats>
        <CardDataStats title="Total Creator" total={totalCreator === 0 ? "Loading" : totalCreator.toLocaleString()} rate={newCreator.toLocaleString()} levelUp={newCreator > 0}>
          <FiUsers size={22} />
        </CardDataStats>
        <CardDataStats title="Total Custom Feed" total={totalCustomFeed === 0 ? 'Loading' : totalCustomFeed.toLocaleString()} rate={newtalCustomFeed.toLocaleString()} levelUp={newtalCustomFeed > 0}>
          <SiSharp size={22} />
        </CardDataStats>
        <CardDataStats title="Custom Feed per Creator" total={perCustomFeed === 0 ? 'Loading' : perCustomFeed.toLocaleString()} rate="">
          <BiTachometer size={28} />
        </CardDataStats>
      </div>

      <div className="mt-4 grid grid-cols-12 gap-4 md:mt-6 md:gap-6 2xl:mt-7.5 2xl:gap-7.5">
        <div className="col-span-12 xl:col-span-12 w-full">
          <CustomFeedList />
        </div>
      </div>
    </>
  );
};

export default CustomFeedDashboard;
