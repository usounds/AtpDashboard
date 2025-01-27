import { useEffect, useState } from 'react';
import { BsBoxArrowUpRight } from "react-icons/bs";

export type ModalProps = {
    open: boolean;
    onCancel: () => void;
    onOk: () => void;
    collection: string
};

const CollectionDetail = (props: ModalProps) => {
    const [did, setDid] = useState('');
    const [rkey, setRkey] = useState('');
    const [createdDate, setCreatedDate] = useState('');

    useEffect(() => {
        const fetchData = async () => {
            setDid('')
            setRkey('')
            setCreatedDate('')

            const result = await fetch(`https://collectiondata.usounds.work/collection?select=did,rkey,collection,createdAt&collection=eq.${props.collection}&order=createdAt.desc&limit=1'`)
            const result4 = await result.json()
            const item = result4[0] as { did: string; rkey: string, createdAt: string }

            setCreatedDate(new Date(Date.parse(item.createdAt + 'Z')).toLocaleString())

            setDid(item.did)
            setRkey(item.rkey)
        };
        fetchData();
    }, []);


    return props.open ? (
        <>
            {/* オーバーレイ（背景） */}
            <div
                className="fixed inset-0 bg-black bg-opacity-50 z-10"
                onClick={() => props.onCancel()}
            ></div>

            {/* モーダル本体 */}
            <div className="fixed bg-white dark:bg-boxdark top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 max-w-171.5 p-5 flex flex-col items-start z-20 rounded shadow-lg">
                <p className="mb-1">Latest Event : {createdDate}</p>
                <p className="mb-1 break-all">
                    {'at://' + did + '/' + props.collection + '/' + rkey}
                </p>
                <div className="flex w-full justify-center items-center mt-2 mb-4">
                    <a href={'https://pdsls.pages.dev/at/' + did + '/' + props.collection + '/' + rkey} target="_blank" rel="noreferrer" className="flex items-center">
                        <span>View in PDSls</span>
                        <BsBoxArrowUpRight className="ml-2" />
                    </a>
                </div>

                <div className="flex mt-auto w-full justify-center items-center">
                    <button
                        className="inline-flex items-center justify-center bg-black py-2 px-8 text-center font-medium text-white hover:bg-opacity-90 lg:px-2 xl:px-8"
                        onClick={() => props.onOk()}
                    >
                        Close
                    </button>
                </div>
            </div>
        </>
    ) : null;
};

export default CollectionDetail;
