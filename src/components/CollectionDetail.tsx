import { useEffect, useState } from 'react';
import LexiconViewer from "./LexiconViewer";
import DataViewer from "./DataViewer";

export type ModalProps = {
    open: boolean;
    onCancel: () => void;
    onOk: () => void;
    collection: string
};

const CollectionDetail = (props: ModalProps) => {
    const [did, setDid] = useState('');
    const [rkey, setRkey] = useState('');
    const [mode, setMode] = useState('lexicon');

    useEffect(() => {
        const fetchData = async () => {
            setDid('')
            setRkey('')

            const result = await fetch(`https://collectiondata.usounds.work/collection?select=did,rkey,collection,createdAt&collection=eq.${props.collection}&order=createdAt.desc&limit=1`)
            const result4 = await result.json()
            const item = result4[0] as { did: string; rkey: string, createdAt: string }

            setDid(item.did)
            setRkey(item.rkey)
        };
        fetchData();
    }, []);

    return props.open ? (
        <>

            <div className="bg-white dark:bg-boxdark w-ful mb-2 flex flex-col items-start">

                <div className="flex mt-auto w-full justify-center items-center mb-2">
                    <button
                        className={`inline-flex items-center justify-center py-2 px-8 text-center font-medium text-white hover:bg-opacity-90 lg:px-2 xl:px-8 ${mode === 'data' ? 'bg-black' : 'bg-meta-3'}`}
                        onClick={() => { setMode('lexicon') }}
                    >
                        Lexicon
                    </button>
                    <button
                        className={`inline-flex items-center justify-center py-2 px-8 text-center font-medium text-white hover:bg-opacity-90 lg:px-2 xl:px-8 ${mode === 'lexicon' ? 'bg-black' : 'bg-meta-3'}`}
                        onClick={() => { setMode('data') }}
                    >
                        Data
                    </button>
                </div>

                {mode === 'lexicon' &&
                    <p className='w-full'>
                        <LexiconViewer domain={props.collection} />
                    </p>
                }

                {mode === 'data' &&
                    <p className='w-full'>
                        <DataViewer uri={'at://'+did+'/'+props.collection+'/'+rkey} />
                    </p>
                }

                <div className="flex mt-auto w-full justify-center items-center mb-2">
                    <button
                        className="inline-flex items-center justify-center bg-black py-2 px-8 text-center font-medium text-white hover:bg-opacity-90 lg:px-2 xl:px-8"
                        onClick={(e) => { e.stopPropagation(); props.onOk(); }}
                    >
                        Close
                    </button>
                </div>

            </div>
        </>
    ) : null;
};

export default CollectionDetail;
