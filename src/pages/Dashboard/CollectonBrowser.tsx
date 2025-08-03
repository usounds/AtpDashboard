import React, { useEffect, useState, useRef } from 'react';
import Checkbox from '../../components/Checkboxes/CheckBox';
import { Collection } from '../../types/collection';
import { useModeStore } from "../../zustand/preference";
import { Tree, TreeApi, NodeApi } from 'react-arborist';
import { FaFileCode, FaRegFolder, FaRegFolderOpen } from "react-icons/fa";
import { BarLoader } from 'react-spinners';
import useColorMode from '../../hooks/useColorMode';
import { GoDotFill } from "react-icons/go";
import CollectionDetail from '../../components/CollectionDetail';
import DatePickerOne from '../../components/Forms/DatePicker/DatePickerOne';
import { VscExpandAll } from "react-icons/vsc";
import { VscCollapseAll } from "react-icons/vsc";
import { TLD_LIST } from "../../types/tlds";

type TreeNode = {
  id: string;
  name: string;
  children?: TreeNode[];
  hasLexicon?: boolean;
  data?: { name: string; hasLexicon?: boolean };
};

const ATmosphere: React.FC = () => {
  const [collection, setCollection] = useState<Collection[]>([]);
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [lexiconKeys, setLexiconKeys] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const exceptCollectionWithTransaction = useModeStore((state) => state.exceptCollectionWithTransaction);
  const setExceptCollectionWithTransaction = useModeStore((state) => state.setExceptCollectionWithTransaction);
  const [selectedCollection, setSelectedCollection] = useState<string | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [firstFrom, setFirstFrom] = useState('');
  const [firstTo, setFirstTo] = useState('');
  const [lastFrom, setLastFrom] = useState('');
  const [lastTo, setLastTo] = useState('');
  const [word, setWord] = useState('');
  const [hasLexiconCheck, setHasLexiconCheck] = useState(false);
  const [colorMode,] = useColorMode();
  const treeRef = useRef<TreeApi<TreeNode> | null>(null);
  const [showFilters, setShowFilters] = useState(false);

  const handleNodeClick = (node: NodeApi<TreeNode>) => {
    const data = node.data;
    if (node.isLeaf) {
      setSelectedCollection(data?.name ?? data?.id ?? null);
      setIsOpen(true);
    } else {
      node.toggle();
    }
  };

  const handleUnselect = () => {
    setIsOpen(false);
    setSelectedCollection(null);
  };

  // Lexicon rkey 一覧を取得
  useEffect(() => {
    const fetchLexiconKeys = async () => {
      try {
        const res = await fetch("https://collectiondata.usounds.work/distinct_schema_rkeys");
        if (!res.ok) throw new Error(res.statusText);
        const data: { rkey: string }[] = await res.json();
        setLexiconKeys(data.map((d) => d.rkey));
      } catch (err: any) {
        console.error("Failed to fetch lexicon keys:", err);
      }
    };
    fetchLexiconKeys();
  }, []);

  async function buildTreeFromCollections(collections: Collection[]): Promise<TreeNode[]> {
    const root: TreeNode[] = [];

    function findOrCreateNode(nodes: TreeNode[], name: string): TreeNode {
      let node = nodes.find((n) => n.name === name);
      if (!node) {
        node = { id: "", name, children: [], hasLexicon: false, data: { name } };
        nodes.push(node);
      }
      return node;
    }

    for (const col of collections) {
      const parts = col.collection.split(".");
      if (parts.length < 2) continue;

      const rootName = `${parts[0]}.${parts[1]}`;
      const rootNode = findOrCreateNode(root, rootName);

      if (lexiconKeys.some((key) => rootName.includes(key))) {
        rootNode.hasLexicon = true;
        rootNode.data!.hasLexicon = true;
      }

      let currentLevel = rootNode.children!;
      for (let i = 2; i < parts.length; i++) {
        const fullName = parts.slice(0, i + 1).join(".");
        const node = findOrCreateNode(currentLevel, fullName);

        if (lexiconKeys.some((key) => fullName.includes(key))) {
          node.hasLexicon = true;
          node.data!.hasLexicon = true;
        }

        if (!node.children) node.children = [];
        currentLevel = node.children;
      }
    }

    function removeEmptyChildren(nodes: TreeNode[]) {
      nodes.forEach((node) => {
        if (node.children && node.children.length === 0) {
          delete node.children;
        } else if (node.children) {
          removeEmptyChildren(node.children);
        }
      });
    }

    function sortNodesByName(nodes: TreeNode[]) {
      nodes.sort((a, b) => a.name.localeCompare(b.name));
      nodes.forEach((node) => {
        if (node.children) {
          sortNodesByName(node.children);
        }
      });
    }

    function assignIds(nodes: TreeNode[], prefix?: string) {
      nodes.forEach((node, idx) => {
        node.id = prefix ? `${prefix}-${idx + 1}` : `${idx + 1}`;
        if (node.children && node.children.length > 0) {
          assignIds(node.children, node.id);
        }
      });
    }

    function compressSingleChild(nodes: TreeNode[]) {
      nodes.forEach((node) => {
        if (node.children && node.children.length > 0) {
          while (
            node.children &&
            node.children.length === 1 &&
            node.children[0].children &&
            node.children[0].children.length > 0
          ) {
            const onlyChild: TreeNode = node.children[0];
            node.children = onlyChild.children;
            node.hasLexicon = node.hasLexicon || onlyChild.hasLexicon;
            node.data!.hasLexicon = node.hasLexicon;
          }
          compressSingleChild(node.children ?? []);
        }
      });
    }

    function propagateHasLexicon(nodes: TreeNode[]): boolean {
      let hasAny = false;
      for (const node of nodes) {
        if (node.children && node.children.length > 0) {
          const childHas = propagateHasLexicon(node.children);
          if (childHas) {
            node.hasLexicon = true;
            node.data!.hasLexicon = true;
          }
        }
        if (node.hasLexicon) hasAny = true;
      }
      return hasAny;
    }

    function filterHasLexicon(nodes: TreeNode[]): TreeNode[] {
      return nodes
        .map((node) => {
          if (node.children) {
            node.children = filterHasLexicon(node.children);
          }
          // 子どもが残っている or 自分がhasLexiconなら残す
          if (node.hasLexicon || (node.children && node.children.length > 0)) {
            return node;
          }
          return null;
        })
        .filter((n): n is TreeNode => n !== null);
    }

    if (exceptCollectionWithTransaction) {
      const tlds = TLD_LIST.map(tld => tld.toLowerCase());

      function filterByTLD(nodes: TreeNode[]): TreeNode[] {
        return nodes
          .map(node => {
            if (node.children) {
              node.children = filterByTLD(node.children);
            }

            const lowerName = node.name.toLowerCase();
            const matchesTLD = tlds.some(tld => lowerName.startsWith(`${tld}.`));

            if (matchesTLD || (node.children && node.children.length > 0)) {
              return node;
            }
            return null;
          })
          .filter((n): n is TreeNode => n !== null);
      }

      const filteredRoot = filterByTLD(root);
      root.splice(0, root.length, ...filteredRoot);
    }

    if (hasLexiconCheck) {
      root.splice(0, root.length, ...filterHasLexicon(root));
    }
    removeEmptyChildren(root);
    sortNodesByName(root);
    compressSingleChild(root);
    propagateHasLexicon(root);

    assignIds(root);

    return root;
  }

  const loadData = async () => {
    setCollection([]);
    setIsLoading(true);

    try {
      const collectionRes = await fetch('https://collectiondata.usounds.work/collection_count_view');
      if (!collectionRes.ok) {
        throw new Error(`Error: ${collectionRes.statusText}`);
      }
      const result1 = (await collectionRes.json()) as Collection[];

      const ret: Collection[] = [];
      for (const item of result1) {
        if (exceptCollectionWithTransaction) {
          if (
            !item.collection.startsWith('com.example')
          ) {
            ret.push(item);
          }
        } else {
          ret.push(item);
        }
      }

      setCollection(ret);
      const treeData = await buildTreeFromCollections(ret);
      setTree(treeData);
      setIsLoading(false);
    } catch (err: any) {
      setError(err.message);
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (lexiconKeys.length > 0) {
      loadData();
    }
  }, [exceptCollectionWithTransaction, lexiconKeys]);

  const handleSearch = () => {
    try {
      setIsLoading(true);
      setError(null);

      let filtered = [...collection];

      if (word.trim()) {
        const keyword = word.trim().toLowerCase();
        filtered = filtered.filter((item) =>
          item.collection.toLowerCase().includes(keyword)
        );
      }

      const toIsoDateString = (dateStr: string) => dateStr.replace(/\//g, '-');

      if (firstFrom) {
        const fromDate = new Date(toIsoDateString(firstFrom));
        filtered = filtered.filter((item) => new Date(item.min) >= fromDate);
      }
      if (firstTo) {
        const toDate = new Date(toIsoDateString(firstTo));
        toDate.setHours(23, 59, 59, 999);
        filtered = filtered.filter((item) => new Date(item.min) <= toDate);
      }

      if (lastFrom) {
        const fromDate = new Date(lastFrom);
        filtered = filtered.filter((item) => new Date(item.max) >= fromDate);
      }
      if (lastTo) {
        const toDate = new Date(lastTo);
        filtered = filtered.filter((item) => new Date(item.max) <= toDate);
      }
      buildTreeFromCollections(filtered).then((treeData) => setTree(treeData));
    } catch (err: any) {
      setError(err.message);
    } finally {
      setIsLoading(false);
    }
  };

  const handleClear = () => {
    setFirstFrom('');
    setFirstTo('');
    setLastFrom('');
    setLastTo('');
    setWord('');
    setHasLexiconCheck(false);
    buildTreeFromCollections(collection).then((treeData) => setTree(treeData));
  };

  const handleExpandAll = () => {
    treeRef.current?.openAll();
  };

  const handleCollapseAll = () => {
    treeRef.current?.closeAll();
  };

  return (
    <>
      {error && <div className="my-2 bg-red-500 text-white p-2 rounded">{error}</div>}

      <div className="mb-2">
        <div className="md:hidden mb-2">
          <button
            onClick={() => setShowFilters(!showFilters)}
            className="w-full bg-gray-200 dark:bg-gray-700 px-4 py-2 rounded text-left"
          >
            {showFilters ? "Hide search conditions" : "Show search conditions"}
          </button>
        </div>

        <div className={`${showFilters ? "block" : "hidden"} md:block`}>
          <div className="flex flex-wrap gap-8 p-1 items-end border-gray-300 pb-2">
            <div className="flex flex-col flex-grow min-w-[200px]">
              <label className="font-semibold mb-1">Search Collections</label>
              <input
                type="text"
                value={word}
                onChange={(e) => setWord(e.target.value)}
                placeholder="Enter collection name"
                className="border-b border-gray-400 outline-none px-1 py-1 w-full bg-transparent dark:bg-gray-800 dark:text-white"
              />
            </div>

            <div className="flex flex-col w-full md:w-auto">
              <label className="font-semibold mb-1">First Indexed</label>
              <div className="flex flex-wrap gap-2">
                <div className="flex flex-col min-w-[110px] flex-1">
                  <span className="text-sm text-gray-500 mb-1">From</span>
                  <DatePickerOne value={firstFrom} onChange={setFirstFrom} />
                </div>
                <div className="flex flex-col min-w-[110px] flex-1">
                  <span className="text-sm text-gray-500 mb-1">To</span>
                  <DatePickerOne value={firstTo} onChange={setFirstTo} />
                </div>
              </div>
            </div>

            <div className="flex flex-col w-full md:w-auto">
              <label className="font-semibold mb-1">Last Indexed</label>
              <div className="flex flex-wrap gap-2">
                <div className="flex flex-col min-w-[110px] flex-1">
                  <span className="text-sm text-gray-500 mb-1">From</span>
                  <DatePickerOne value={lastFrom} onChange={setLastFrom} />
                </div>
                <div className="flex flex-col min-w-[110px] flex-1">
                  <span className="text-sm text-gray-500 mb-1">To</span>
                  <DatePickerOne value={lastTo} onChange={setLastTo} />
                </div>
              </div>
            </div>
          </div>

          <div className="flex flex-wrap justify-center items-center gap-2 mt-3">
            <Checkbox
              checked={hasLexiconCheck}
              onChange={setHasLexiconCheck}
              label="Has Lexicon"
            />

            <Checkbox
              checked={exceptCollectionWithTransaction}
              onChange={setExceptCollectionWithTransaction}
              label="Exclude invalid TLDs"
            />

            <button
              onClick={handleSearch}
              className="bg-meta-3 text-white px-4 py-2 rounded ml-2 "
            >
              Search
            </button>
            <button
              onClick={handleClear}
              className="bg-black dark:bg-gray-700 text-white px-4 py-2 rounded"
            >
              Clear
            </button>
            <button
              onClick={handleExpandAll}
              className="px-2 py-1 rounded flex items-center gap-1"
            >
              <VscExpandAll />
              <span>Expand All</span>
            </button>
            <button
              onClick={handleCollapseAll}
              className="px-2 py-1 rounded flex items-center gap-1 mr-2"
            >
              <VscCollapseAll />
              <span>Collapse All</span>
            </button>

          </div>
        </div>

        {isOpen && selectedCollection && (
          <CollectionDetail
            open={isOpen}
            onCancel={handleUnselect}
            onOk={handleUnselect}
            collection={selectedCollection}
          />
        )}

        {isLoading ? (
          <div className='mt-2'>
            <BarLoader
              width="100%"
              color={colorMode === 'dark' ? "#a6a6a6" : '#000000'}
            />
          </div>
        ) : (
          <>
            {tree.length > 0 ? (
              <div style={{ width: "100vw", height: "100vh" }}>
                <Tree
                  ref={treeRef}
                  initialData={tree}
                  key={tree.length}
                  openByDefault={false}
                  indent={24}
                  rowHeight={36}
                  overscanCount={1}
                  width={"100%"}
                  height={1000}
                  paddingTop={30}
                  paddingBottom={10}
                  padding={25}
                >
                  {({ node, style, dragHandle }) => (
                    <div
                      style={style}
                      className="flex items-center gap-2 px-2 cursor-pointer hover:bg-gray-200 dark:hover:bg-gray-700 select-none"
                      onClick={() => handleNodeClick(node)}
                      {...dragHandle}
                    >
                      {node.isLeaf ? (
                        <FaFileCode />
                      ) : node.isOpen ? (
                        <FaRegFolderOpen />
                      ) : (
                        <FaRegFolder />
                      )}
                      {node.data?.hasLexicon && (
                        <GoDotFill size={10} className="shrink-0 text-blue-500" />
                      )}
                      <span>{node.data?.name ?? node.data?.id}</span>
                    </div>
                  )}
                </Tree>
              </div>
            ) : (
              <div className="m-5">No Items</div>
            )}
          </>
        )}
      </div>
    </>
  );
};

export default ATmosphere;
