import { Jetstream } from '@bsky/jetstream';
import pg from 'pg';
import * as dotenv from 'dotenv';
import logger from './logger.js';

dotenv.config();

const { Pool } = pg;

const pool = new Pool({
  user: process.env.PG_USER,
  host: process.env.PG_HOST,
  database: process.env.PG_DATABASE,
  password: process.env.PG_PASSWORD,
  port: process.env.PG_PORT ? Number(process.env.PG_PORT) : undefined,
});

// 2025-01-18 23:59:59.999 UTC
const DEFAULT_CUTOFF_DATE = '2025-01-18T23:59:59.999Z';
const CUTOFF_TIME_MS = process.env.BACKFILL_CUTOFF_DATE
  ? new Date(process.env.BACKFILL_CUTOFF_DATE).getTime()
  : new Date(DEFAULT_CUTOFF_DATE).getTime();

// 既存のライブ収集 ('collection') と完全に分離したバックフィル専用カーソル名
const SERVICE_NAME = process.env.BACKFILL_SERVICE_NAME || 'backfill_collection';
const BATCH_SIZE = process.env.BACKFILL_BATCH_SIZE ? Number(process.env.BACKFILL_BATCH_SIZE) : 1000;
const FLUSH_INTERVAL_MS = process.env.BACKFILL_FLUSH_INTERVAL_MS
  ? Number(process.env.BACKFILL_FLUSH_INTERVAL_MS)
  : 2000;

interface CollectionRecord {
  did: string;
  collection: string;
  rkey: string;
  createdAt: string;
  seq: number;
}

let recordBuffer: CollectionRecord[] = [];
let highestSeqInBuffer = 0;
let lastSavedSeq = 0;
let totalInserted = 0;
let totalProcessedEvents = 0;
let isFlushing = false;
let isShuttingDown = false;
let flushTimer: NodeJS.Timeout | null = null;
let statsTimer: NodeJS.Timeout | null = null;

async function getStartSeq(client: pg.PoolClient): Promise<number> {
  if (process.env.BACKFILL_START_SEQ !== undefined) {
    const specified = Number(process.env.BACKFILL_START_SEQ);
    logger.info(`環境変数指定の開始 seq を使用します: ${specified}`);
    return specified;
  }

  try {
    const query = 'SELECT cursor FROM cursor WHERE service = $1;';
    const result = await client.query(query, [SERVICE_NAME]);
    if (result.rows.length > 0) {
      const seq = Number(result.rows[0].cursor);
      logger.info(`DBからバックフィル専用チェックポイントを取得しました [service=${SERVICE_NAME}]: seq = ${seq}`);
      return seq;
    }
  } catch (err) {
    logger.warn(`チェックポイントの取得に失敗したため、初期値0から開始します: ${err}`);
  }

  logger.info(`チェックポイントが存在しないため、アーカイブ先頭 (afterSeq: 0) から開始します [service=${SERVICE_NAME}]`);
  return 0;
}

async function flushBuffer(client: pg.PoolClient) {
  if (isFlushing || recordBuffer.length === 0) return;
  isFlushing = true;

  const recordsToInsert = [...recordBuffer];
  const maxSeq = highestSeqInBuffer;
  recordBuffer = [];

  try {
    const values: any[] = [];
    const valuePlaceholders: string[] = [];

    recordsToInsert.forEach((rec, idx) => {
      const offset = idx * 4;
      valuePlaceholders.push(`($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4})`);
      values.push(rec.did, rec.collection, rec.rkey, rec.createdAt);
    });

    await client.query('BEGIN');

    if (valuePlaceholders.length > 0) {
      const insertQuery = `
        INSERT INTO public.collection (did, collection, rkey, "createdAt")
        VALUES ${valuePlaceholders.join(', ')}
        ON CONFLICT (did, collection, rkey, "createdAt")
        DO NOTHING;
      `;
      await client.query(insertQuery, values);
    }

    if (maxSeq > 0) {
      const cursorQuery = `
        INSERT INTO cursor (service, cursor)
        VALUES ($1, $2)
        ON CONFLICT (service)
        DO UPDATE SET cursor = EXCLUDED.cursor;
      `;
      await client.query(cursorQuery, [SERVICE_NAME, maxSeq]);
      lastSavedSeq = maxSeq;
    }

    await client.query('COMMIT');
    totalInserted += recordsToInsert.length;
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error(`バッチ書き込みエラー: ${err}`);
    recordBuffer = [...recordsToInsert, ...recordBuffer];
  } finally {
    isFlushing = false;
  }
}

async function main() {
  const client = await pool.connect();

  const startSeq = await getStartSeq(client);
  lastSavedSeq = startSeq;

  let serviceHost =
    process.env.JETSTREAM_SERVICE ||
    process.env.BACKFILL_JETSTREAM_URL ||
    'https://jetstream.us-west.bsky.network';

  // Jetstream Replay SDK はアーカイブセグメントを HTTP fetch で取得するため https:// を使用
  serviceHost = serviceHost.replace(/^wss:\/\//, 'https://').replace(/^ws:\/\//, 'http://');
  if (!serviceHost.startsWith('http://') && !serviceHost.startsWith('https://')) {
    serviceHost = `https://${serviceHost}`;
  }

  const apiKey = process.env.JETSTREAM_API_KEY || process.env.BLUESKY_API_KEY;

  logger.info(`Jetstream v2 Replay 接続先: ${serviceHost}`);
  logger.info(`バックフィル専用カーソルキー: ${SERVICE_NAME}`);
  logger.info(`対象終了日時: ${new Date(CUTOFF_TIME_MS).toISOString()}`);

  if (apiKey) {
    logger.info('Jetstream APIキー（リプレイ認証）を設定しました');
  } else {
    logger.warn('JETSTREAM_API_KEY が未設定です（Bluesky公式ホストのアーカイブReplayにはAPIキーが必要です）');
  }

  const jetstream = new Jetstream({
    service: serviceHost,
    apiKey,
  });

  flushTimer = setInterval(async () => {
    await flushBuffer(client);
  }, FLUSH_INTERVAL_MS);

  let lastReportedTime = Date.now();
  let lastReportedCount = 0;

  statsTimer = setInterval(() => {
    const now = Date.now();
    const elapsedSec = (now - lastReportedTime) / 1000;
    const rate = elapsedSec > 0 ? Math.round((totalProcessedEvents - lastReportedCount) / elapsedSec) : 0;
    lastReportedTime = now;
    lastReportedCount = totalProcessedEvents;

    logger.info(
      `[進捗] 現在 seq: ${lastSavedSeq} | 受信イベント: ${totalProcessedEvents} | 挿入レコード: ${totalInserted} | 速度: ${rate} events/s`
    );
  }, 10000);

  const shutdown = async (signal?: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    logger.info(`シャットダウン処理中 (${signal || '完了'})...`);

    if (flushTimer) clearInterval(flushTimer);
    if (statsTimer) clearInterval(statsTimer);

    await flushBuffer(client);
    logger.info(`バックフィル用チェックポイント保存完了 [service=${SERVICE_NAME}]: seq = ${lastSavedSeq}`);

    client.release();
    await pool.end();
    logger.info('バックフィル処理が正常に終了しました');
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  try {
    // Jetstream v2 Replay ストリームを起動
    for await (const evt of jetstream.replay({
      afterSeq: startSeq,
      kinds: ['commit'],
    })) {
      if (isShuttingDown) break;

      totalProcessedEvents++;

      if (evt.kind !== 'commit' || !('commit' in evt)) {
        continue;
      }

      const timeStr = 'time' in evt ? (evt as any).time : new Date().toISOString();
      const eventTimeMs = new Date(timeStr).getTime();

      // 2025年1月18日カットオフ判定
      if (eventTimeMs && eventTimeMs > CUTOFF_TIME_MS) {
        logger.info(`バックフィル終了日時に到達しました: ${timeStr} > ${new Date(CUTOFF_TIME_MS).toISOString()}`);
        await shutdown('CutoffReached');
        break;
      }

      const commit = evt.commit;
      const collection = commit.collection;
      const rkey = commit.rkey;
      const did = evt.did;
      const seq = evt.seq;

      if (seq && seq > highestSeqInBuffer) {
        highestSeqInBuffer = seq;
      }

      if (!collection || !rkey || !did) {
        continue;
      }

      // 公式 bsky コレクションを除外
      if (collection.startsWith('app.bsky') || collection.startsWith('chat.bsky')) {
        continue;
      }

      recordBuffer.push({
        did,
        collection,
        rkey,
        createdAt: timeStr,
        seq,
      });

      if (recordBuffer.length >= BATCH_SIZE) {
        await flushBuffer(client);
      }
    }
  } catch (err: any) {
    logger.error(`Replay ストリームエラー: ${err.message || err}`);
    await shutdown('Error');
  }
}

main().catch((err) => {
  logger.error(`Fatal Error in backfill: ${err}`);
  process.exit(1);
});
