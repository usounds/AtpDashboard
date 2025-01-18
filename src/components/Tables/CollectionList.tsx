import { Collection } from '../../types/collection';
import React, { useEffect, useState } from 'react'; import { IoIosSearch } from "react-icons/io";

interface CollectionListProps {
  collections: Collection[]; // Collection[] 型の props を定義
}


const CollectionList: React.FC<CollectionListProps> = ({ collections }) => {
  const [sortedCollections, setSortedCollections] = useState<Collection[]>(collections);
  const [sortConfig, setSortConfig] = useState<{ key: string; direction: 'ascending' | 'descending' } | null>(null);
  const [searchQuery, setSearchQuery] = useState<string>('');

  useEffect(() => {
    setSortedCollections(collections);
    console.log(sortConfig?.key)
    handleSort(sortConfig?.key || '', searchQuery)
  }, [collections]);

  const handleSearch = (event: React.ChangeEvent<HTMLInputElement>) => {
    const query = event.target.value;
    setSearchQuery(query);
    handleSort(sortConfig?.key || '', query)
  };

  const handleSort = (key: string, query: string) => {
    let direction: 'ascending' | 'descending' = 'ascending';

    // If the column is already sorted, toggle the direction
    if (sortConfig && sortConfig.key === key && sortConfig.direction === 'ascending') {
      direction = 'descending';
    }

    const filteredCollections = collections.filter((item) =>
      item.collection.toLowerCase().includes(query.toLowerCase())
    );

    const sorted = [...filteredCollections].sort((a, b) => {
      if (key === 'collection') {
        return direction === 'ascending'
          ? a.collection.localeCompare(b.collection)
          : b.collection.localeCompare(a.collection);
      }
      if (key === 'count') {
        return direction === 'ascending' ? a.count - b.count : b.count - a.count;
      }
      if (key === 'min' || key === 'max') {
        const dateA = new Date(a[key as keyof Collection]);
        const dateB = new Date(b[key as keyof Collection]);

        return direction === 'ascending' ? dateA.getTime() - dateB.getTime() : dateB.getTime() - dateA.getTime();
      }
      return 0;
    });

    setSortedCollections(sorted);
    setSortConfig({ key, direction });
  };

  return (
    <div className="rounded-sm border border-stroke bg-white px-5 pt-6 pb-2.5 shadow-default dark:border-strokedark dark:bg-boxdark sm:px-7.5 xl:pb-1">
      <div className="flex items-center justify-between mb-6">
        <h4 className="text-xl font-semibold text-black dark:text-white">
          3rd Party Collections
        </h4>
        <div className="flex items-center p-2 border rounded-lg text-black dark:text-white focus:outline-none border-stroke dark:border-strokedark">
          <IoIosSearch className="text-lg text-gray-500 dark:text-gray-300 mr-2" />
          <input
            type="text"
            value={searchQuery}
            onChange={handleSearch}
            placeholder="Search..."
            className="w-full bg-transparent focus:outline-none"
          />
        </div>
      </div>

      <div className="flex flex-col">
        <div className="grid grid-cols-3 rounded-sm bg-gray-2 dark:bg-meta-4 sm:grid-cols-4">
          <div className="p-2.5 xl:p-5 cursor-pointer" onClick={() => handleSort('collection', searchQuery)}>
            <h5 className="text-sm font-medium uppercase xsm:text-base">Collection</h5>
          </div>
          <div className="p-2.5 text-center xl:p-5 cursor-pointer" onClick={() => handleSort('count', searchQuery)}>
            <h5 className="text-sm font-medium uppercase xsm:text-base">Events</h5>
          </div>
          <div className="p-2.5 text-center xl:p-5 cursor-pointer" onClick={() => handleSort('min', searchQuery)}>
            <h5 className="text-sm font-medium uppercase xsm:text-base">First Indexed</h5>
          </div>
          <div className="hidden p-2.5 text-center sm:block xl:p-5 cursor-pointer" onClick={() => handleSort('max', searchQuery)}>
            <h5 className="text-sm font-medium uppercase xsm:text-base">Last Indexed</h5>
          </div>
        </div>

        {sortedCollections.length === 0 &&
          <div className="m-5 text-black dark:text-white">
            No Item
          </div>
        }

        {sortedCollections.map((item, key) => (
          <div
            className={`grid grid-cols-3 sm:grid-cols-4 ${key === collections.length - 1
              ? ''
              : 'border-b border-stroke dark:border-strokedark'
              }`}
            key={key}
          >
            <div className="flex items-center gap-3 p-2.5 xl:p-5">
              <p className="text-black dark:text-white sm:block break-words overflow-hidden break-all">
                {item.collection}
              </p>
            </div>

            <div className="flex items-center justify-center p-2.5 xl:p-5">
              <p className="text-black dark:text-white">{item.count}</p>
            </div>

            <div className="flex items-center justify-center p-2.5 xl:p-5">
              {new Date(Date.parse(item.min + 'Z')).toLocaleString()}

            </div>

            <div className="hidden items-center justify-center p-2.5 sm:flex xl:p-5">
              {new Date(Date.parse(item.max + 'Z')).toLocaleString()}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

export default CollectionList;
