import React, { useEffect, useMemo, useState } from 'react';
import { BarLoader } from 'react-spinners';
import SelectGroupOne from "../components/Forms/SelectGroup/SelectGroupOne";

interface FeedData {
    server_did: string;
    unique_creator_did: number;
    unique_creator_rkey: number;
    min_create_at: string;
    max_create_at: string;
}

const CustomFeedList: React.FC = () => {
    const [feeds, setFeeds] = useState<FeedData[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [sortedFeeds, setSortedFeeds] = useState<FeedData[]>([]);
    const [sortConfig, setSortConfig] = useState<{ key: string; direction: 'ascending' | 'descending' } | null>(null);
    const [searchQuery, _] = useState<string>('');
    const [selectedRange, setSelectedRange] = useState<string>('all');

    // 月リスト生成（降順）
    const monthRanges = useMemo(() => {
        const start = new Date(2024, 9, 1); // 2024-10
        const now = new Date();
        const list: { label: string; value: string }[] = [];

        list.push({ label: 'All Range', value: 'all' });

        let date = new Date(now.getFullYear(), now.getMonth(), 1);
        while (date >= start) {
            const label = date.toLocaleString('en-US', { month: 'short', year: 'numeric' });
            const value = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
            list.push({ label, value });
            date.setMonth(date.getMonth() - 1);
        }

        return list;
    }, []);

    // APIデータ取得
    useEffect(() => {
        const fetchData = async () => {
            setIsLoading(true);
            let body: Record<string, string>;

            if (selectedRange === 'all') {
                body = {
                    start_date: '2024-10-01T00:00:00Z',
                    end_date: new Date().toISOString()
                };
            } else {
                const [year, month] = selectedRange.split('-').map(Number);
                const startDate = new Date(year, month - 1, 1).toISOString();
                const endDate = new Date(year, month, 1).toISOString();
                body = { start_date: startDate, end_date: endDate };
            }

            try {
                const res = await fetch(
                    'https://collectiondata.usounds.work/rpc/get_event_logs_by_server',
                    {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(body)
                    }
                );


                const data: FeedData[] = await res.json();
                const maskedData = data.map(item => {
                    if (item.unique_creator_rkey === 1) {
                        return {
                            ...item,
                            server_did: 'did:***:*****'
                        };
                    }
                     if (item.server_did.startsWith('did:plc')) {
                        return {
                            ...item,
                            server_did: 'did:plc:*****'
                        };
                    }
                    return item;
                });
                const sorted = [...maskedData].sort(
                    (a, b) => b.unique_creator_rkey - a.unique_creator_rkey
                );


                setFeeds(sorted);
                setSortedFeeds(sorted);
                setSortConfig({ key: 'unique_creator_rkey', direction: 'descending' }); // 状態も設定
            } catch (err) {
                console.error('Failed to fetch data', err);
            }

            setIsLoading(false);
        };

        fetchData();
    }, [selectedRange]);

    const handleSort = (key: string, query: string) => {
        let direction: 'ascending' | 'descending' = 'ascending';

        if (sortConfig && sortConfig.key === key && sortConfig.direction === 'ascending') {
            direction = 'descending';
        }

        const filtered = feeds.filter((item) =>
            item.server_did.toLowerCase().includes(query.toLowerCase())
        );

        const sorted = [...filtered].sort((a, b) => {
            if (key === 'server_did') {
                return direction === 'ascending'
                    ? a.server_did.localeCompare(b.server_did)
                    : b.server_did.localeCompare(a.server_did);
            }
            if (key === 'unique_creator_did' || key === 'unique_creator_rkey') {
                return direction === 'ascending'
                    ? a[key] - b[key]
                    : b[key] - a[key];
            }
            if (key === 'min_create_at' || key === 'max_create_at') {
                return direction === 'ascending'
                    ? new Date(a[key]).getTime() - new Date(b[key]).getTime()
                    : new Date(b[key]).getTime() - new Date(a[key]).getTime();
            }
            return 0;
        });

        setSortedFeeds(sorted);
        setSortConfig({ key, direction });
    };

    return (
        <>
            <div className="rounded-sm border border-stroke bg-white px-5 pt-6 pb-2.5 shadow-default dark:border-strokedark dark:bg-boxdark sm:px-7.5 xl:pb-1">
                <div className="flex items-center justify-between mb-6">
                    <h4 className="text-xl font-semibold text-black dark:text-white">
                        Custom Feeds
                    </h4>
                    <SelectGroupOne
                        label="Range"
                        options={monthRanges}
                        selectedOption={selectedRange}
                        onChange={setSelectedRange}
                    />
                </div>

                <div className="grid grid-cols-3 rounded-sm bg-gray-2 dark:bg-meta-4 2xl:grid-cols-5">
                    <div
                        className="p-2.5 xl:p-5 cursor-pointer"
                        onClick={() => handleSort('server_did', searchQuery)}
                    >
                        <h5 className="text-sm font-medium xsm:text-base">Server DID</h5>
                    </div>
                    <div
                        className="p-2.5 text-center xl:p-5 cursor-pointer"
                        onClick={() => handleSort('unique_creator_did', searchQuery)}
                    >
                        <h5 className="text-sm font-medium xsm:text-base">Unique Creators</h5>
                    </div>
                    <div
                        className="p-2.5 text-center xl:p-5 cursor-pointer"
                        onClick={() => handleSort('unique_creator_rkey', searchQuery)}
                    >
                        <h5 className="text-sm font-medium xsm:text-base">Custom Feed Counts</h5>
                    </div>
                    <div
                        className="hidden 2xl:flex p-2.5 justify-center xl:p-5 cursor-pointer"
                        onClick={() => handleSort('min_create_at', searchQuery)}
                    >
                        <h5 className="text-sm font-medium xsm:text-base">First Indexed</h5>
                    </div>
                    <div
                        className="hidden 2xl:flex items-center justify-center p-2.5 xl:p-5 cursor-pointer"
                        onClick={() => handleSort('max_create_at', searchQuery)}
                    >
                        <h5 className="text-sm font-medium xsm:text-base">Last Indexed</h5>
                    </div>
                </div>

                {isLoading ? <>
                    <div className='py-6 m-5'>
                        Loading...
                        <BarLoader cssOverride={{ width: '100%' }} />
                    </div>
                </> :
                    <div className="flex flex-col">
                        {/* データ行 */}
                        {sortedFeeds.length === 0 && (
                            <div className="m-5 text-black dark:text-white">No Item</div>
                        )}

                        {sortedFeeds.map((item, idx) => (
                            <div
                                key={idx}
                                className={`grid grid-cols-3 2xl:grid-cols-5 ${idx < sortedFeeds.length - 1
                                    ? 'border-b border-stroke dark:border-strokedark'
                                    : ''
                                    }`}
                            >
                                <div className="flex items-center gap-3 p-2.5 xl:p-5 break-words overflow-hidden break-all">
                                    <p className="text-black dark:text-white">
                                        {item.unique_creator_rkey === 1
                                            ? item.server_did.replace(
                                                /^(did:[^:]+:)[^:]+$/,
                                                (_, p1) => p1 + '*****'
                                            )
                                            : item.server_did}
                                    </p>
                                </div>

                                <div className="flex items-center justify-center p-2.5 xl:p-5 text-center">
                                    <p className="text-black dark:text-white">
                                        {item.unique_creator_did.toLocaleString()}
                                    </p>
                                </div>

                                <div className="flex items-center justify-center p-2.5 xl:p-5 text-center">
                                    <p className="text-black dark:text-white">
                                        {item.unique_creator_rkey.toLocaleString()}
                                    </p>
                                </div>

                                <div className="hidden 2xl:flex items-center justify-center p-2.5 xl:p-5 text-center">
                                    <p className="text-black dark:text-white">
                                        {new Date(item.min_create_at).toLocaleString()}
                                    </p>
                                </div>

                                <div className="hidden 2xl:flex items-center justify-center p-2.5 xl:p-5 text-center">
                                    <p className="text-black dark:text-white">
                                        {new Date(item.max_create_at).toLocaleString()}
                                    </p>
                                </div>
                            </div>
                        ))}
                    </div>
                }
            </div>
        </>
    );
};

export default CustomFeedList;
