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

type TreeNode = {
  id: string;
  name: string;
  children?: TreeNode[];
  isNew?: boolean;
  data?: { name: string; isNew?: boolean };
};

function buildTreeFromCollections(collections: Collection[]): TreeNode[] {
  const root: TreeNode[] = [];

  function findOrCreateNode(nodes: TreeNode[], name: string): TreeNode {
    let node = nodes.find((n) => n.name === name);
    if (!node) {
      node = { id: "", name, children: [], isNew: false, data: { name } };
      nodes.push(node);
    }
    return node;
  }

  for (const col of collections) {
    const parts = col.collection.split(".");
    if (parts.length < 2) continue;

    const rootName = `${parts[0]}.${parts[1]}`;
    const rootNode = findOrCreateNode(root, rootName);
    if (col.isNew) rootNode.isNew = true;
    rootNode.data!.isNew = rootNode.isNew;

    let currentLevel = rootNode.children!;
    for (let i = 2; i < parts.length; i++) {
      const fullName = parts.slice(0, i + 1).join(".");
      const node = findOrCreateNode(currentLevel, fullName);
      if (col.isNew) node.isNew = true;
      node.data!.isNew = node.isNew;
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
          node.isNew = node.isNew || onlyChild.isNew;
          node.data!.isNew = node.isNew;
        }
        compressSingleChild(node.children ?? []);
      }
    });
  }

  removeEmptyChildren(root);
  sortNodesByName(root);
  compressSingleChild(root);
  assignIds(root);

  return root;
}

const ATmosphere: React.FC = () => {
  const [collection, setCollection] = useState<Collection[]>([]);
  const [tree, setTree] = useState<TreeNode[]>([]);
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
      const now = new Date();
      const threeDaysAgo = new Date(now.getTime() - 72 * 60 * 60 * 1000); // 72時間前

      for (const item of result1) {
        if (exceptCollectionWithTransaction) {
          if (
            !item.collection.startsWith('ge.shadowcaster') &&
            !item.collection.includes('---') &&
            !item.collection.includes('aaa') &&
            !item.collection.includes('zzz')
          ) {
            ret.push(item);
            const minDate = new Date(item.min + "Z");
            if (minDate > threeDaysAgo) item.isNew = true;
          }
        } else {
          ret.push(item);
          const minDate = new Date(item.min + "Z");
          if (minDate > threeDaysAgo) item.isNew = true;
        }
      }

      setCollection(ret);
      setTree(buildTreeFromCollections(ret));
      setIsLoading(false);
    } catch (err: any) {
      setError(err.message);
      setIsLoading(false);
    }
  };

  useEffect(() => {
    setIsLoading(true);
    const fetchData = async () => {
      try {
        await loadData();
      } catch (err: any) {
        setError(err.message);
        setIsLoading(false);
      }
    };
    fetchData();
  }, [exceptCollectionWithTransaction]);

  const handleSearch = () => {
    try {
      setIsLoading(true);
      setError(null);

      let filtered = [...collection];

      // Word 検索（collection名に含まれる）
      if (word.trim()) {
        const keyword = word.trim().toLowerCase();
        filtered = filtered.filter((item) =>
          item.collection.toLowerCase().includes(keyword)
        );
      }

      const toIsoDateString = (dateStr: string) => {
        // 'YYYY/MM/DD' -> 'YYYY-MM-DD'
        return dateStr.replace(/\//g, '-');
      };

      // First Indexed (min 日付)
      if (firstFrom) {
        const fromDate = new Date(toIsoDateString(firstFrom));
        filtered = filtered.filter((item) => {
          const itemDate = new Date(item.min);
          return itemDate >= fromDate;
        });
      }
      if (firstTo) {
        const toDate = new Date(toIsoDateString(firstTo));
        toDate.setHours(23, 59, 59, 999);
        filtered = filtered.filter((item) => {
          const itemDate = new Date(item.min);
          return itemDate <= toDate;
        });
      }

      // Last Indexed (max 日付)
      if (lastFrom) {
        const fromDate = new Date(lastFrom);
        filtered = filtered.filter((item) => new Date(item.max) >= fromDate);
      }
      if (lastTo) {
        const toDate = new Date(lastTo);
        filtered = filtered.filter((item) => new Date(item.max) <= toDate);
      }

      // ツリー更新
      setTree(buildTreeFromCollections(filtered));
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
    setTree(buildTreeFromCollections(collection));
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
        {/* モバイル用のトグルボタン */}
        <div className="md:hidden mb-2">
          <button
            onClick={() => setShowFilters(!showFilters)}
            className="w-full bg-gray-200 dark:bg-gray-700 px-4 py-2 rounded text-left"
          >
            {showFilters ? "Hide search conditions" : "Show search conditions"}
          </button>
        </div>

        {/* 検索フォーム */}
        <div className={`${showFilters ? "block" : "hidden"} md:block`}>
          {/* 入力エリア */}
          <div className="flex flex-wrap gap-8 p-1 items-end border-gray-300 pb-2">
            {/* Word 入力欄 */}
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

            {/* First Indexed */}
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

            {/* Last Indexed */}
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

          {/* ボタン行 */}
          <div className="flex flex-wrap justify-center items-center gap-2 mt-4">
            <button
              onClick={handleSearch}
              className="bg-meta-3 text-white px-4 py-2 rounded"
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
              className="ml-4 px-2 py-1 rounded flex items-center gap-1"
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
            <Checkbox
              checked={exceptCollectionWithTransaction}
              onChange={setExceptCollectionWithTransaction}
              label="Exclude specific collection"
            />
          </div>
        </div>

        {/* モーダル */}
        {isOpen && selectedCollection && (
          <CollectionDetail
            open={isOpen}
            onCancel={handleUnselect}
            onOk={handleUnselect}
            collection={selectedCollection}
          />
        )}

        {/* ローディング or ツリー */}
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
                      {node.data?.isNew && (
                        <GoDotFill size={10} className="shrink-0 text-meta-3" />
                      )}
                      <span>{node.data?.name ?? node.data?.id}</span>
                    </div>
                  )}
                </Tree>
              </div>
            ) : (
              <div className="m-5">
                No Items
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
};

export default ATmosphere;
