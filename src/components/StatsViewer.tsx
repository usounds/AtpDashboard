import React, { useEffect, useState } from "react";

type Stats = {
    unique_did: number;
    min_createdat: string;
    max_createdat: string;
    unique_rkey: number;
    total_count: number;
};

type Props = {
    collection: string;
};

const StatsViewer: React.FC<Props> = ({ collection }) => {
  const [stats, setStats] = useState<Stats | null>(null);
  //const [_, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchStats = async () => {
      try {
        //setLoading(true);
        const url = `https://collectiondata.usounds.work/collection_stats?collection=eq.${encodeURIComponent(collection)}`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data: Stats[] = await res.json();
        setStats(data[0] || null);
      } catch (err: any) {
        setError(err.message);
        setStats(null);
      } finally {
        //setLoading(false);
      }
    };
    fetchStats();
  }, [collection]);

  // Loading 表示は消す（常に表は表示）
  // エラーは表の上に表示する形に変更
  return (
    <div className="overflow-x-auto">
      {error && <div style={{ color: "red" }}>Error: {error}</div>}
      <table className="table-auto w-full text-left border-collapse">
        <tbody>
          <tr className="border-b border-gray-300 dark:border-gray-700 align-top">
            <th className="px-4 py-2 align-top whitespace-nowrap">Collection</th>
            <td className="px-4 py-2">{collection}</td>
            <th className="px-4 py-2 align-top whitespace-nowrap">Total DIDs</th>
            <td className="px-4 py-2">{stats ? stats.unique_did.toLocaleString() : "-"}</td>
          </tr>

          <tr className="border-b border-gray-300 dark:border-gray-700">
            <th className="px-4 py-2 whitespace-nowrap">Records</th>
            <td className="px-4 py-2">{stats ? stats.unique_rkey.toLocaleString() : "-"}</td>
            <th className="px-4 py-2 whitespace-nowrap">Events</th>
            <td className="px-4 py-2">{stats ? stats.total_count.toLocaleString() : "-"}</td>
          </tr>

          <tr>
            <th className="px-4 py-2 whitespace-nowrap">First Indexed</th>
            <td className="px-4 py-2">
              {stats && stats.min_createdat
                ? new Date(stats.min_createdat + "Z").toLocaleString()
                : "-"}
            </td>
            <th className="px-4 py-2 whitespace-nowrap">Last Indexed</th>
            <td className="px-4 py-2">
              {stats && stats.max_createdat
                ? new Date(stats.max_createdat + "Z").toLocaleString()
                : "-"}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
};


export default StatsViewer;
