import { useState, useEffect } from 'react';
import { BarLoader } from 'react-spinners';
import { getResolver as getWebResolver } from 'web-did-resolver'
import { Resolver, ResolverRegistry, DIDResolver, DIDDocument } from 'did-resolver'
import { getResolver } from '../logic/DidPlcResolver'
import JsonView from '@uiw/react-json-view';
import { lightTheme } from '@uiw/react-json-view/light';
import { darkTheme } from '@uiw/react-json-view/dark';
import useColorMode from '../hooks/useColorMode';

const myResolver = getResolver()
const web = getWebResolver()
const resolver: ResolverRegistry = {
    'plc': myResolver.DidPlcResolver as unknown as DIDResolver,
    'web': web as unknown as DIDResolver,
}
export const resolverInstance = new Resolver(resolver)

export const getServiceEndpoint = (didDoc: DIDDocument) => {
    return didDoc.service?.find(service => service.id.trim() === '#atproto_pds')?.serviceEndpoint;
};

type DnsTxtRecordProps = {
    domain: string;
};

const LexiconViewer = ({ domain }: DnsTxtRecordProps) => {
    const [message, setMessage] = useState<string>('');
    const [isLoading, setIsLoading] = useState(true);
    const [lexicon, setLexicon] = useState<object | null>(null);
    const [colorMode,] = useColorMode();

    const fetchTxtRecords = async (subDomain: string): Promise<string | null> => {
        try {
            const response = await fetch(`https://dns.google/resolve?name=${subDomain}&type=TXT`);
            const data = await response.json();

            const didMatch = data.Answer?.[0]?.data.match(/did:[\w:]+/);
            return didMatch ? didMatch[0] : null;
        } catch (error) {
            console.error(`TXTレコードの取得に失敗しました (${subDomain}):`, error);
            return null;
        }
    };

    const findValidTxtRecord = async () => {
        setIsLoading(true);
        setLexicon(null);
        setMessage('DID looking up from NSID...');
        const parts = domain.split('.').reverse(); // 'uk.skyblur.post' -> ['post', 'skyblur', 'uk']

        // Lv4以上に対応し、_lexicon.のバリエーションを生成
        for (let i = 0; i < parts.length - 1; i++) {
            const subDomain = `_lexicon.${parts.slice(i).join('.')}`; // ex: "_lexicon.post.skyblur.uk"
            const foundDid = await fetchTxtRecords(subDomain);

            if (foundDid) {
                await resolvePds(foundDid);
                return;
            }
        }

        setMessage('No lexicon found. Can\'t find DNS record.');
        setIsLoading(false);
    };

    const resolvePds = async (foundDid: string) => {
        setMessage('Resolving PDS...');
        try {
            const didDoc = await resolverInstance.resolve(foundDid) as unknown as DIDDocument;
            const serviceEndpoint = getServiceEndpoint(didDoc);
            if (!serviceEndpoint) throw new Error();

            if (Array.isArray(serviceEndpoint)) {
                await fetchLexicon(serviceEndpoint[0], foundDid);
            } else {
                if (typeof serviceEndpoint === 'string') {
                    await fetchLexicon(serviceEndpoint, foundDid);
                } else {
                    setMessage(`No lexicon found. Invalid service endpoint.`);
                    setIsLoading(false);
                }
            }
        } catch (e) {
            setMessage(`No lexicon found. Can't resolve PDS for ${foundDid}.`);
            setIsLoading(false);
        }
    };
    const fetchLexicon = async (serviceEndpoint: string, foundDid: string) => {
        setMessage('Retrieving lexicon from PDS...');
        const recordUri = `${serviceEndpoint}/xrpc/com.atproto.repo.getRecord?repo=${foundDid}&collection=com.atproto.lexicon.schema&rkey=${domain}`;
        try {
            const record = await fetch(recordUri);
            if (!record.ok) {
                setMessage(`No lexicon found. Can't get record from PDS.`);
                setIsLoading(false);
                return;
            }

            const data = await record.json();
            setLexicon(data.value);
            setMessage(''); // 成功したら終了
            setIsLoading(false);
        } catch (e) {
            setMessage(`No lexicon found. Can't get record from PDS.`);
            setIsLoading(false);
        }
    };

    useEffect(() => {
        findValidTxtRecord();

    }, [domain]);

    return (
        <div className='mb-2 w-full'>
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
            <p className=''>{(!lexicon) && message}</p>
            {lexicon && (
                <div className="">
                    <JsonView
                        value={lexicon!}
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
};

export default LexiconViewer;
