import React, { useEffect, useState } from 'react';
import CardDataStats from '../../components/CardDataStats';
import Checkbox from '../../components/Checkboxes/CheckBox';
import CollectionList from '../../components/CollectionList';
import WeekChart from '../../components/Charts/WeekChart';
import { Collection } from '../../types/collection';
import { FiUsers } from "react-icons/fi";
import { MdOutlineFolderCopy } from "react-icons/md";
import { BiTachometer } from "react-icons/bi";
import { MdDomain } from "react-icons/md";
import { useModeStore } from "../../zustand/preference";
import { useCollectionStore } from "../../zustand/collectionStore";
import pslData from '../../data/publicSuffixList.json';

const pslSet = new Set(pslData);

function getPublicSuffix(domain: string): string {
  const labels = domain.split('.');
  let match = '';

  for (let i = 0; i < labels.length; i++) {
    const sub = labels.slice(i).join('.');

    // Exception rule
    if (pslSet.has('!' + sub)) {
      return labels.slice(i + 1).join('.');
    }

    // Exact rule
    if (pslSet.has(sub)) {
      if (!match || sub.split('.').length > match.split('.').length) {
        match = sub;
      }
    }

    // Wildcard rule
    const parent = labels.slice(i + 1).join('.');
    if (parent && pslSet.has('*.' + parent)) {
      if (!match || sub.split('.').length > match.split('.').length) {
        match = sub;
      }
    }
  }

  return match || labels[labels.length - 1];
}

function getRegistrantNsid(nsid: string): string {
  const parts = nsid.split('.');
  const domain = [...parts].reverse().join('.');
  const suffix = getPublicSuffix(domain);
  const suffixParts = suffix.split('.').length;
  const registrantPartsCount = Math.min(parts.length, suffixParts + 1);
  return parts.slice(0, registrantPartsCount).join('.');
}

function epochUsToTimeAgo(cursor: number): string {
  const cursorDate = new Date(cursor / 1000); // UNIXタイムスタンプからDateオブジェクトを作成
  const now = new Date(); // 現在時刻

  const diffInMs = now.getTime() - cursorDate.getTime(); // 現在時刻との差をミリ秒単位で計算
  const diffInMinutes = Math.floor(diffInMs / (1000 * 60)); // ミリ秒を分に変換

  if (diffInMinutes <= 0) return '0'

  return `${diffInMinutes.toLocaleString()}`;
}

const ATmosphere: React.FC = () => {
  const {
    fetchCollection,
    isLoading: isGlobalLoading
  } = useCollectionStore();

  const [filteredCollection, setFilteredCollection] = useState<Collection[]>([]);
  const [newCollection, setNewCollection] = useState<number>(0);
  const [did, setDid] = useState<number>(0);
  const [cursor, setCursor] = useState<number>(0);
  const [nsidLv2, setNsidLv2] = useState<number>(0);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [earliestCollection, setEarliestCollection] = useState<Collection | null>(null);
  const exceptCollectionWithTransaction = useModeStore((state) => state.exceptCollectionWithTransaction);
  const setExceptCollectionWithTransaction = useModeStore((state) => state.setExceptCollectionWithTransaction);

  const loadData = async (force: boolean = false) => {
    setNsidLv2(0)
    setDid(0)
    setNewCollection(0)
    setIsLoading(true)

    await fetchCollection(force);
    const result1 = useCollectionStore.getState().collection;

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

    setFilteredCollection(ret);
    setFilteredCollection(ret);
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


    // NSIDLv2 calculation from collection list (Lines 100-120 logic moved here)
    const distinctNsidLv2 = new Set<string>();

    for (const item of ret) {
      if (item.collection) {
        const nsid = getRegistrantNsid(item.collection);
        if (exceptCollectionWithTransaction) {
          if (!nsid.startsWith('ge.shadowcaster')) {
            distinctNsidLv2.add(nsid);
          }
        } else {
          distinctNsidLv2.add(nsid);
        }
      }
    }
    setNsidLv2(distinctNsidLv2.size);

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
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 md:gap-6 xl:grid-cols-4 2xl:gap-7.5" onClick={() => loadData(true)}>
        <CardDataStats title="Total Collections" total={filteredCollection.length === 0 ? "Loading" : filteredCollection.length.toLocaleString()} rate={newCollection > 0 ? newCollection.toLocaleString() : ''} levelUp={newCollection > 0}>
          <MdOutlineFolderCopy size={22} />
        </CardDataStats>
        <CardDataStats title="Total Sub Name Spaces" total={nsidLv2 === 0 ? "Loading" : nsidLv2.toLocaleString()} rate="">
          <MdDomain size={22} />
        </CardDataStats>
        <CardDataStats title="Total Users" total={did === 0 ? 'Loading' : did.toLocaleString()} rate="">
          <FiUsers size={22} />
        </CardDataStats>
        <CardDataStats title="Cursor Delay in Minutes" total={(isLoading || isGlobalLoading) ? "Loading" : cursor > 0 ? epochUsToTimeAgo(cursor) : '0'} rate={(isLoading || isGlobalLoading) ? '' : epochUsToTimeAgo(cursor) !== '0' ? "Behind" : ""} levelDown={(isLoading || isGlobalLoading) ? false : epochUsToTimeAgo(cursor) !== '0'}>
          <BiTachometer size={28} />
        </CardDataStats>
      </div>

      <div className="mt-4 grid grid-cols-12 gap-4 md:mt-6 md:gap-6 2xl:mt-7.5 2xl:gap-7.5">
        <WeekChart newView='new_collection_summary_view' newTitle="New" activeView='active_collection_summary_view' activeTitle="Active" title='Daily Collections' />
        <WeekChart newView='new_did_summary_view' newTitle="New" activeView='active_did_summary_view' activeTitle="Active" title='Daily Users' />
      </div>

      <div className="mt-4 grid grid-cols-12 gap-4 md:mt-6 md:gap-6 2xl:mt-7.5 2xl:gap-7.5">
        <div className="col-span-12 xl:col-span-12 w-full">
          <CollectionList collections={filteredCollection} />
        </div>
      </div>
    </>
  );
};

export default ATmosphere;
