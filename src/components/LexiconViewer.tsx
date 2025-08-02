import { useState, useEffect } from 'react';
import { getResolver as getWebResolver } from 'web-did-resolver'
import { Resolver, ResolverRegistry, DIDResolver, DIDDocument } from 'did-resolver'
import { getResolver } from '../logic/DidPlcResolver'
import JsonView from '@uiw/react-json-view';
import { lightTheme } from '@uiw/react-json-view/light';
import { darkTheme } from '@uiw/react-json-view/dark';
import useColorMode from '../hooks/useColorMode';
import { FaSpinner, FaCheckCircle, FaTimesCircle } from "react-icons/fa";

const myResolver = getResolver()
const web = getWebResolver()
const resolver: ResolverRegistry = {
    'plc': myResolver.DidPlcResolver as unknown as DIDResolver,
    'web': web.web,
}
export const resolverInstance = new Resolver(resolver)

export const getServiceEndpoint = (didDoc: DIDDocument) => {
    return didDoc.service?.find(service => service.id.trim() === '#atproto_pds')?.serviceEndpoint;
};

type DnsTxtRecordProps = {
    domain: string;
};

type CheckResult = {
    isProgress: boolean;
    result?: boolean;
    message?: string;
};


const LexiconViewer = ({ domain }: DnsTxtRecordProps) => {
    const [lexicon, setLexicon] = useState<object | null>(null);
    const [colorMode,] = useColorMode();
    const [lexiconSchema, setLexiconShema] = useState<CheckResult | null>({ isProgress: true });
    const [dnsRecord, setDNSRecord] = useState<CheckResult | null>({ isProgress: true });

    const renderIcon = (status: CheckResult | null) => {
        if (!status) return null;

        if (status.isProgress) {
            return <FaSpinner className="animate-spin text-blue-500" />;
        }
        if (status.result) {
            return <FaCheckCircle className="text-green-500" />;
        }
        return <FaTimesCircle className="text-red-500" />;
    };

    const renderMessage = (status: CheckResult | null) => {
        if (!status) return "";
        return status.message || "";
    };

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
        //setIsLoading(true);
        setLexicon(null);
        //setMessage('DID looking up from NSID...');
        const parts = domain.split('.').reverse(); // 'uk.skyblur.post' -> ['post', 'skyblur', 'uk']

        // Lv4以上に対応し、_lexicon.のバリエーションを生成
        //for (let i = 0; i < parts.length - 1; i++) {
        const subDomain = `_lexicon.${parts.slice(1).join('.')}`; // ex: "_lexicon.post.skyblur.uk"
        console.log(subDomain)
        const foundDid = await fetchTxtRecords(subDomain);

        if (foundDid) {
            setDNSRecord({
                isProgress: false,
                result: true,
                message: `Found for ${subDomain}`
            });
            await resolvePds(foundDid);
            return;
        }
        //}
        setDNSRecord({
            isProgress: false,
            result: false,
            message: `Not found for ${subDomain}`
        });

        setLexiconShema({
            isProgress: false,
            result: false,
            message: `Check not performed because DNS record was not found.`
        });
        //setMessage('No lexicon found. Can\'t find DNS record.');
        //setIsLoading(false);
    };

    const resolvePds = async (foundDid: string) => {
        // setMessage('Resolving PDS...');
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
                    setLexiconShema({
                        isProgress: false,
                        result: false,
                        message: `Invalid service endpoint for ${didDoc}`
                    });
                    //setMessage(`No lexicon found. Invalid service endpoint.`);
                    //setIsLoading(false);
                }
            }
        } catch (e) {
            setLexiconShema({
                isProgress: false,
                result: false,
                message: `Can't resolve PDS for ${foundDid}`
            });
            //setMessage(` Can't resolve PDS for ${foundDid}.`);
            //setIsLoading(false);
        }
    };

    const fetchLexicon = async (serviceEndpoint: string, foundDid: string) => {
        const recordUri = `${serviceEndpoint}/xrpc/com.atproto.repo.getRecord?repo=${foundDid}&collection=com.atproto.lexicon.schema&rkey=${domain}`;
        try {
            const record = await fetch(recordUri);

            if (!record.ok) {
                setLexiconShema({
                    isProgress: false,
                    result: false,
                    message: `Not found for ${domain}`
                });
                //setIsLoading(false);
                return;
            }

            const data = await record.json();
            setLexiconShema({
                isProgress: false,
                result: true,
                message: `Found for ${domain}`
            });
            setLexicon(data.value);
            //setIsLoading(false);
        } catch (e) {
            setLexiconShema({
                isProgress: false,
                result: false,
                message: `${e instanceof Error ? e.message : 'Unknown error'} for ${recordUri} `
            });
            //setIsLoading(false);
        }
    };

    useEffect(() => {
        findValidTxtRecord();

    }, [domain]);

    return (
        <div className='mb-2 w-full max-h-[80vh] '>
            {!lexicon &&
                <table className="table-auto w-full text-left border-collapse">
                    <thead>
                        <tr className="border-b border-gray-300 dark:border-gray-700 align-top">
                            <th className="px-4 py-2 align-top whitespace-nowrap">Check</th>
                            <th className="px-4 py-2 align-top whitespace-nowrap">Status</th>
                            <th className="px-4 py-2 align-top whitespace-nowrap">Message</th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr className="border-b border-gray-300 dark:border-gray-700 align-top">
                            <th className="px-4 py-2 align-top whitespace-nowrap">DNS</th>
                            <td className="px-4 py-2">{renderIcon(dnsRecord)}</td>
                            <td className="px-4 py-2">{renderMessage(dnsRecord)}</td>
                        </tr>
                        <tr className="border-gray-300 dark:border-gray-700 align-top">
                            <th className="px-4 py-2 align-top whitespace-nowrap">Lexicon Schema</th>
                            <td className="px-4 py-2">{renderIcon(lexiconSchema)}</td>
                            <td className="px-4 py-2 break-all">{renderMessage(lexiconSchema)}</td>
                        </tr>
                    </tbody>
                </table>
            }
            {lexicon && (
                <div className="max-h-[70vh] overflow-y-auto borderrounded p-2">
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
