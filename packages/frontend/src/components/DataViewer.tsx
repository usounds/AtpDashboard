import { useState, useEffect } from 'react';
import { BarLoader } from 'react-spinners';
import JsonView from '@uiw/react-json-view';
import { lightTheme } from '@uiw/react-json-view/light';
import { darkTheme } from '@uiw/react-json-view/dark';
import { DIDDocument } from 'did-resolver';
import useColorMode from '../hooks/useColorMode';

import { resolverInstance, getServiceEndpoint } from "./LexiconViewer";

type DataViewerProp = {
    uri: string;
};

const DataViewer = ({ uri }: DataViewerProp) => {
    const [message, setMessage] = useState<string>('');
    const [isLoading, setIsLoading] = useState(true);
    const [data, setData] = useState<object | null>(null);
    const [colorMode,] = useColorMode();

    const getData = async () => {
        const cleanedUri = uri.replace("at://", "");
        const parts = cleanedUri.split("/");

        setMessage('Resolving PDS...');
        const didDoc = await resolverInstance.resolve(parts[0]) as unknown as DIDDocument;
        const serviceEndpoints = getServiceEndpoint(didDoc);
        let serviceEndpoint

        if (Array.isArray(serviceEndpoints)) {
            serviceEndpoint = serviceEndpoints[0]
        } else {
            if (typeof serviceEndpoints === 'string') {
                serviceEndpoint = serviceEndpoints
            } else {
                setMessage(`No data found. Invalid service endpoint.`);
                setIsLoading(false);
                return
            }
        }

        setMessage('Retrieving data from PDS...');
        const url = `${serviceEndpoint}/xrpc/com.atproto.repo.getRecord?repo=${parts[0]}&collection=${parts[1]}&rkey=${parts[2]}`

        try{
            const result = await fetch(url)
            if(!result.ok){
                setMessage(`No data found. Can't get record from PDS.`);
                setIsLoading(false);
                return

            }

            const data = await result.json();
            setData(data.value);
            setMessage(''); // 成功したら終了
            setIsLoading(false);
            return
        }catch(e){
            setMessage(`No data found. Can't get record from PDS.`);
            setIsLoading(false);
            return
        }

    }

    useEffect(() => {
        getData();

    }, [uri]);

    return (
        <div className='mb-2 w-full max-h-[80vh]'>
            <p className='break-all'>{uri}</p>
            {isLoading && (
                <div className='w-full flex justify-center'>
                    <div className='flex w-full flex-col items-center'>
                        <BarLoader 
                            width="100%"
                            color={colorMode === 'dark' ? "#a6a6a6" : '#000000'}
                        />
                    </div>
                </div>
            )}
            <p className=''>{(!data) && message}</p>
            {data && (
                <div className="max-h-[70vh] ">
                    <JsonView
                        value={data!}
                        collapsed={9}
                        style={colorMode === 'dark' ? darkTheme : lightTheme}
                        displayDataTypes={false}
                        enableClipboard={false}
                        shortenTextAfterLength={0}
                    />
                </div>
            )}
        </div>
    );
}

export default DataViewer;
