import React, { useEffect, useState } from 'react';
import CardDataStats from '../../components/CardDataStats';
import Checkbox from '../../components/Checkboxes/CheckBox';
import CollectionList from '../../components/CollectionList';
import WeekChart from '../../components/Charts/WeekChart';
import { Collection, NSIDLv2 } from '../../types/collection';
import { FiUsers } from "react-icons/fi";
import { MdOutlineFolderCopy } from "react-icons/md";
import { BiTachometer } from "react-icons/bi";
import { MdDomain } from "react-icons/md";
import { useModeStore } from "../../zustand/preference";

function epochUsToTimeAgo(cursor: number): string {
  const cursorDate = new Date(cursor / 1000); // UNIXタイムスタンプからDateオブジェクトを作成
  const now = new Date(); // 現在時刻

  const diffInMs = now.getTime() - cursorDate.getTime(); // 現在時刻との差をミリ秒単位で計算
  const diffInMinutes = Math.floor(diffInMs / (1000 * 60)); // ミリ秒を分に変換

  if (diffInMinutes <= 0) return '0'

  return `${diffInMinutes.toLocaleString()}`;
}

const ATmosphere: React.FC = () => {
  const [collection, setCollection] = useState<Collection[]>([]);
  const [newCollection, setNewCollection] = useState<number>(0);
  const [did, setDid] = useState<number>(0);
  const [cursor, setCursor] = useState<number>(0);
  const [nsidLv2, setNsidLv2] = useState<number>(0);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [earliestCollection, setEarliestCollection] = useState<Collection | null>(null);
  const exceptCollectionWithTransaction = useModeStore((state) => state.exceptCollectionWithTransaction);
  const setExceptCollectionWithTransaction = useModeStore((state) => state.setExceptCollectionWithTransaction);

  const loadData = async () => {
    setCollection([])
    setNsidLv2(0)
    setDid(0)
    setNewCollection(0)
    setIsLoading(true)

    const collection = await fetch('https://collectiondata.usounds.work/collection_count_view');
    if (!collection.ok) {
      setIsLoading(false)
      throw new Error(`Error: ${collection.statusText}`);
    }
    const result1 = await collection.json() as Collection[];

    const ret = []

    let newCollection = 0
    const now = new Date();
    const threeDaysAgo = new Date(now);
    threeDaysAgo.setHours(now.getHours() - 72);

    for (const item of result1) {
      if (exceptCollectionWithTransaction) {
        if (!item.collection.startsWith('ge.shadowcaster')) {
          ret.push(item)
          const minDate = new Date(item.min + "Z");
          if (minDate > threeDaysAgo) {
            newCollection++
            item.isNew = true
          }
        }

      } else {
        ret.push(item)
        const minDate = new Date(item.min + "Z");
        if (minDate > threeDaysAgo) {
          newCollection++
          item.isNew = true
        }

      }
    }

    setCollection(ret);
    setNewCollection(newCollection)

    const earliest = ret.reduce((earliest: Collection | null, current: Collection) => {
      const currentMinDate = new Date(current.min);
      const earliestMinDate = earliest ? new Date(earliest.min) : new Date();
      return currentMinDate < earliestMinDate ? current : earliest;
    }, null);

    setEarliestCollection(earliest);

    const index = await fetch('https://collectiondata.usounds.work/cursor?service=eq.collection&select=service,cursor');
    if (!index.ok) {
      setIsLoading(false)
      throw new Error(`Error: ${index.statusText}`);
    }
    const result3 = await index.json();
    setCursor(result3[0].cursor);


    const nsid = await fetch('https://collectiondata.usounds.work/collection_lv2');
    if (!nsid.ok) {
      setIsLoading(false)
      throw new Error(`Error: ${nsid.statusText}`);
    }
    const result4 = await nsid.json() as NSIDLv2[]


    const ret2 = []

    for (const item of result4) {
      if (exceptCollectionWithTransaction) {
        if (item.nsidlv2 && !item.nsidlv2.startsWith('ge.shadowcaster')) {
          ret2.push(item);
        }
      } else {
        ret2.push(item);
      }
    }

    setNsidLv2(ret2.length);

    const did = await fetch('https://collectiondata.usounds.work/unique_did_count_view');
    if (!did.ok) {
      setIsLoading(false)
      throw new Error(`Error: ${did.statusText}`);
    }
    const result2 = await did.json();
    setDid(result2[0].unique_did_count);

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
  }, [exceptCollectionWithTransaction]);

  return (
    <>
      <div className="mb-2">
        Indexed from {earliestCollection?.min ? new Date(Date.parse(earliestCollection.min + 'Z')).toLocaleString() : "Unknown date"}
        {cursor > 1 && " to " + new Date(cursor / 1000).toLocaleString() + "."}
      </div>
      {error &&
        <div className="my-2 bg-red-500">
          {error}
        </div>
      }
      <div className="mb-2">
        <Checkbox
          checked={exceptCollectionWithTransaction}
          onChange={setExceptCollectionWithTransaction}
          label="Exclude collections with transaction key"
        />
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 md:gap-6 xl:grid-cols-4 2xl:gap-7.5" onClick={loadData}>
        <CardDataStats title="Total Collections"total={collection.length === 0 ? "Loading" : collection.length.toLocaleString()} rate={newCollection > 0 ? newCollection.toLocaleString() : ''} levelUp={newCollection > 0}>
          <MdOutlineFolderCopy size={22} />
        </CardDataStats>
        <CardDataStats title="Total Sub Name Spaces" total={nsidLv2 === 0 ? "Loading" : nsidLv2.toLocaleString()} rate="">
          <MdDomain size={22} />
        </CardDataStats>
        <CardDataStats title="Total Users" total={did===0? 'Loading' : did.toLocaleString()} rate="">
          <FiUsers size={22} />
        </CardDataStats>
        <CardDataStats title="Cursor Delay in Minutes" total={isLoading? "Loading" :cursor > 0 ? epochUsToTimeAgo(cursor) : '0'} rate={isLoading ? '' : epochUsToTimeAgo(cursor) !== '0' ? "Behind" : ""} levelDown={isLoading ? false: epochUsToTimeAgo(cursor) !== '0'}>
          <BiTachometer size={28} />
        </CardDataStats>
      </div>

      <div className="mt-4 grid grid-cols-12 gap-4 md:mt-6 md:gap-6 2xl:mt-7.5 2xl:gap-7.5">
        <WeekChart newView='new_collection_summary_view' newTitle="New" activeView='active_collection_summary_view' activeTitle="Active" title='Daily Collections' />
        <WeekChart newView='new_did_summary_view' newTitle="New" activeView='active_did_summary_view' activeTitle="Active" title='Daily Users' />
      </div>

      <div className="mt-4 grid grid-cols-12 gap-4 md:mt-6 md:gap-6 2xl:mt-7.5 2xl:gap-7.5">
        <div className="col-span-12 xl:col-span-12 w-full">
          <CollectionList collections={collection} />
        </div>
      </div>
    </>
  );
};

export default ATmosphere;
