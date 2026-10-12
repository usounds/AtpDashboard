import React, { useEffect, useState } from 'react';
import { Modal, SegmentedControl, Group, Text, Box, Button } from '@mantine/core';
import { IconChartBar, IconCode, IconDatabase, IconExternalLink } from '@tabler/icons-react';
import LexiconViewer from './LexiconViewer';
import DataViewer from './DataViewer';
import StatsViewer from './StatsViewer';
import CollectionFavicon from './CollectionFavicon';
import { getWebDomainFromNsid } from '../logic/domain';

export type ModalProps = {
  open: boolean;
  onClose?: () => void;
  onCancel?: () => void;
  onOk?: () => void;
  collection: string;
};

const CollectionDetail: React.FC<ModalProps> = ({ open, onClose, onOk, onCancel, collection }) => {
  const handleClose = () => {
    if (onClose) onClose();
    else if (onOk) onOk();
    else if (onCancel) onCancel();
  };
  const [did, setDid] = useState('');
  const [rkey, setRkey] = useState('');
  const [mode, setMode] = useState<'stats' | 'lexicon' | 'data'>('stats');
  const webDomain = getWebDomainFromNsid(collection);

  useEffect(() => {
    if (open) {
      setDid('');
      setRkey('');
      setMode('stats');
    }
  }, [open, collection]);

  useEffect(() => {
    if (!open) return;
    const fetchData = async () => {
      try {
        const result = await fetch(
          `https://collectiondata.usounds.work/collection?select=did,rkey,collection,createdAt&collection=eq.${collection}&order=createdAt.desc&limit=1`,
        );
        const resultData = await result.json();
        if (resultData.length > 0) {
          const item = resultData[0] as { did: string; rkey: string };
          setDid(item.did);
          setRkey(item.rkey);
        }
      } catch (err) {
        console.error('Error fetching collection detail:', err);
      }
    };
    fetchData();
  }, [open, collection]);

  return (
    <Modal
      opened={open}
      onClose={handleClose}
      title={
        <SegmentedControl
          value={mode}
          onChange={(val) => setMode(val as 'stats' | 'lexicon' | 'data')}
          radius="md"
          size="sm"
          data={[
            {
              value: 'stats',
              label: (
                <Group gap={6} wrap="nowrap" justify="center">
                  <IconChartBar size={16} />
                  <span className="whitespace-nowrap">Stats</span>
                </Group>
              ),
            },
            {
              value: 'lexicon',
              label: (
                <Group gap={6} wrap="nowrap" justify="center">
                  <IconCode size={16} />
                  <span className="whitespace-nowrap">Lexicon</span>
                </Group>
              ),
            },
            {
              value: 'data',
              label: (
                <Group gap={6} wrap="nowrap" justify="center">
                  <IconDatabase size={16} />
                  <span className="whitespace-nowrap">Sample Data</span>
                </Group>
              ),
            },
          ]}
        />
      }
      size="xl"
      radius="lg"
      centered
      classNames={{
        content: 'dark:bg-[#182234] dark:border dark:border-gray-800',
        header: 'dark:bg-[#182234] border-b border-gray-100 dark:border-gray-800 pb-3',
      }}
    >
      <Box pt="xs">
        {/* Collection Identity Bar */}
        <Group
          justify="space-between"
          align="center"
          mb="md"
          p="xs"
          className="rounded-lg bg-gray-50/80 dark:bg-gray-800/40 border border-gray-200 dark:border-gray-700/60"
        >
          <Group gap="sm" wrap="nowrap">
            <CollectionFavicon domain={webDomain} size={28} />
            <Box>
              <Text fw={700} size="sm" className="font-mono text-gray-900 dark:text-white break-all">
                {collection}
              </Text>
              <Text size="xs" c="dimmed">
                Domain Authority: <span className="font-semibold text-gray-700 dark:text-gray-300">{webDomain}</span>
              </Text>
            </Box>
          </Group>

          <Button
            component="a"
            href={`https://${webDomain}`}
            target="_blank"
            rel="noopener noreferrer"
            variant="light"
            color="blue"
            size="xs"
            radius="md"
            rightSection={<IconExternalLink size={13} />}
          >
            Visit Website
          </Button>
        </Group>

        <Box>
          {mode === 'lexicon' && <LexiconViewer domain={collection} />}
          {mode === 'data' && (
            did && rkey ? (
              <DataViewer uri={`at://${did}/${collection}/${rkey}`} />
            ) : (
              <Text size="sm" c="dimmed" ta="center" py="xl">
                No sample data available for this collection.
              </Text>
            )
          )}
          {mode === 'stats' && <StatsViewer collection={collection} />}
        </Box>
      </Box>
    </Modal>
  );
};

export default CollectionDetail;
