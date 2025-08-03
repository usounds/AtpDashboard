import { useEffect, useState } from 'react';
import LexiconViewer from "./LexiconViewer";
import DataViewer from "./DataViewer";
import StatsViewer from "./StatsViewer";

export type ModalProps = {
    open: boolean;
    onCancel: () => void;
    onOk: () => void;
    collection: string
};

const CollectionDetail = (props: ModalProps) => {
  const [did, setDid] = useState('');
  const [rkey, setRkey] = useState('');
  const [mode, setMode] = useState<'lexicon' | 'data' |'stats'>('stats');

  // モーダルが開くたびに state 初期化
  useEffect(() => {
    if (props.open) {
      setDid('');
      setRkey('');
      //setMode('lexicon'); // モードを初期化
    }
  }, [props.open]);

  // データ取得
  useEffect(() => {
    if (!props.open) return;
    const fetchData = async () => {
      try {
        const result = await fetch(
          `https://collectiondata.usounds.work/collection?select=did,rkey,collection,createdAt&collection=eq.${props.collection}&order=createdAt.desc&limit=1`
        );
        const result4 = await result.json();
        if (result4.length > 0) {
          const item = result4[0] as { did: string; rkey: string };
          setDid(item.did);
          setRkey(item.rkey);
        }
      } catch (err) {
        console.error('Error fetching collection detail:', err);
      }
    };
    fetchData();
  }, [props.open, props.collection]); // open と collection 両方依存

  if (!props.open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50">
      <div className="bg-white dark:bg-boxdark p-4 rounded-lg w-[80%] max-w-4xl">
        <div className="flex justify-center mb-4">
          <button
            className={`px-4 py-2 text-white ${mode === 'stats'  ?'bg-meta-3' : 'bg-black'}`}
            onClick={() => setMode('stats')}
          >
            Stats
          </button>
          <button
            className={`px-4 py-2 text-white ${mode === 'lexicon' ?'bg-meta-3' : 'bg-black'}`}
            onClick={() => setMode('lexicon')}
          >
            Lexicon
          </button>
          <button
            className={`px-4 py-2 text-white ${mode === 'data'  ?'bg-meta-3' : 'bg-black'}`}
            onClick={() => setMode('data')}
          >
            Data
          </button>
        </div>

        {mode === 'lexicon' && <LexiconViewer domain={props.collection} />}
        {mode === 'data' && did && rkey && (
          <DataViewer uri={`at://${did}/${props.collection}/${rkey}`} />
        )}
        {mode === 'stats' && <StatsViewer collection={props.collection} />}

        <div className="flex justify-center mt-4">
          <button
            className="bg-black text-white px-4 py-2 rounded"
            onClick={props.onOk}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};

export default CollectionDetail;
