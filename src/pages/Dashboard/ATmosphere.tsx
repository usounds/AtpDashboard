import React, { useEffect, useState } from 'react';
import CardDataStats from '../../components/CardDataStats';
import CollectionList from '../../components/Tables/CollectionList';
import { Collection, Did } from '../../types/collection';
import { FiUsers } from "react-icons/fi";
import { MdOutlineFolderCopy } from "react-icons/md";
import { BiTachometer } from "react-icons/bi";
import { MdDomain } from "react-icons/md";

function epochUsToTimeAgo(cursor: number): string {
  const cursorDate = new Date(cursor / 1000); // UNIXタイムスタンプからDateオブジェクトを作成
  const now = new Date(); // 現在時刻

  const diffInMs = now.getTime() - cursorDate.getTime(); // 現在時刻との差をミリ秒単位で計算
  const diffInMinutes = Math.floor(diffInMs / (1000 * 60)); // ミリ秒を分に変換

  return `${diffInMinutes}`;
}

const ATmosphere: React.FC = () => {
  const [collection, setCollection] = useState<Collection[]>([]);
  const [did, setDid] = useState<Did[]>([]);
  const [cursor, setCursor] = useState<number>(0);
  const [nsidLv2, setNsidLv2] = useState<number>(0);
  const [error, setError] = useState<string | null>(null);
  const [earliestCollection, setEarliestCollection] = useState<Collection | null>(null);

  const loadData = async () => {

    const collection = await fetch('https://collectiondata.usounds.work/collection_count_view');
    if (!collection.ok) {
      throw new Error(`Error: ${collection.statusText}`);
    }
    const result1 = await collection.json();
    setCollection(result1);

    const earliest = result1.reduce((earliest: Collection | null, current: Collection) => {
      const currentMinDate = new Date(current.min);
      const earliestMinDate = earliest ? new Date(earliest.min) : new Date();
      return currentMinDate < earliestMinDate ? current : earliest;
    }, null);

    setEarliestCollection(earliest);


    const did = await fetch('https://collectiondata.usounds.work/did_count_view');
    if (!did.ok) {
      throw new Error(`Error: ${did.statusText}`);
    }
    const result2 = await did.json();
    setDid(result2);

    const index = await fetch('https://collectiondata.usounds.work/cursor?service=eq.collection&select=service,cursor');
    if (!index.ok) {
      throw new Error(`Error: ${index.statusText}`);
    }
    const result3 = await index.json();
    console.log(result3)
    setCursor(result3[0].cursor);



    const nsid = await fetch('https://collectiondata.usounds.work/collection_lv2_view');
    if (!nsid.ok) {
      throw new Error(`Error: ${nsid.statusText}`);
    }
    const result4 = await nsid.json();
    console.log(result4)
    setNsidLv2(result4.length);

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
      <div className="mb-2">
        All data indexed from {earliestCollection?.min ? new Date(Date.parse(earliestCollection.min + 'Z')).toLocaleString() : "Unknown date"}.
        {cursor > 1 && " The index is up to " + new Date(cursor / 1000).toLocaleString() + "."}
      </div>
      {error &&
        <div className="my-2 bg-red-500">
          {error}
        </div>
      }
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 md:gap-6 xl:grid-cols-4 2xl:gap-7.5" onClick={loadData}>
        <CardDataStats title="Total Collections" total={collection.length.toString()} rate="">
          <MdOutlineFolderCopy size={22} />
        </CardDataStats>
        <CardDataStats title="Total Sub Name Spaces" total={nsidLv2.toString()} rate="">
          <MdDomain size={22} />
        </CardDataStats>
        <CardDataStats title="Total Users" total={did.length.toString()} rate="">
          <FiUsers size={22} />
        </CardDataStats>
        <CardDataStats title="Cursor Behind Minues" total={cursor > 0 ? epochUsToTimeAgo(cursor) : '0'} rate="" levelDown={epochUsToTimeAgo(cursor) !== '0'}>
          <BiTachometer size={28} />
        </CardDataStats>
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
