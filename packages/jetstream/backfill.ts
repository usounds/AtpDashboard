import WebSocket from 'ws';
import pg from 'pg';
import * as dotenv from 'dotenv';
import logger from './logger';

dotenv.config();

const { Pool } = pg;

const pool = new Pool({
  user: process.env.PG_USER,
  host: process.env.PG_HOST,
  database: process.env.PG_DATABASE,
  password: process.env.PG_PASSWORD,
  port: process.env.PG_PORT ? Number(process.env.PG_PORT) : undefined,
});

// 2025-01-18 23:59:59.999999 UTC in microseconds (1737244799999999)
const DEFAULT_CUTOFF_TIME_US = 1737244799999999;
const CUTOFF_TIME_US = process.env.BACKFILL_CUTOFF_TIME
  ? Number(process.env.BACKFILL_CUTOFF_TIME)
  : DEFAULT_CUTOFF_TIME_US;

// 既存のライブ収集用 'collection' とは明確に分離した独立カーソルキー
const SERVICE_NAME = process.env.BACKFILL_SERVICE_NAME || 'backfill_collection';
const BATCH_SIZE = process.env.BACKFILL_BATCH_SIZE ? Number(process.env.BACKFILL_BATCH_SIZE) : 1000;
const FLUSH_INTERVAL_MS = process.env.BACKFILL_FLUSH_INTERVAL_MS
  ? Number(process.env.BACKFILL_FLUSH_INTERVAL_MS)
  : 2000;

function epochUsToDateTime(cursor: number): string {
  return new Date(Math.floor(cursor / 1000)).toISOString();
}

interface CollectionRecord {
  did: string;
  collection: string;
  rkey: string;
  createdAt: string;
  time_us: number;
}

let recordBuffer: CollectionRecord[] = [];
let highestCursorInBuffer = 0;
let lastSavedCursor = 0;
let totalInserted = 0;
let totalProcessedEvents = 0;
let isFlushing = false;
let isShuttingDown = false;
let flushTimer: NodeJS.Timeout | null = null;
let statsTimer: NodeJS.Timeout | null = null;
let ws: WebSocket | null = null;

async function getStartCursor(client: pg.PoolClient): Promise<number> {
  if (process.env.BACKFILL_START_CURSOR !== undefined) {
    const specified = Number(process.env.BACKFILL_START_CURSOR);
    logger.info(`環境変数指定の開始カーソルを使用します: ${specified} (${epochUsToDateTime(specified)})`);
    return specified;
  }

  try {
    // 既存のライブカーソル ('collection') と競合しないよう SERVICE_NAME ('backfill_collection') を参照
    const query = 'SELECT cursor FROM cursor WHERE service = $1;';
    const result = await client.query(query, [SERVICE_NAME]);
    if (result.rows.length > 0) {
      const cursor = Number(result.rows[0].cursor);
      logger.info(`DBからバックフィル専用カーソルを取得しました [service=${SERVICE_NAME}]: ${cursor} (${epochUsToDateTime(cursor)})`);
      return cursor;
    }
  } catch (err) {
    logger.warn(`バックフィルカーソルの取得に失敗したため、初期値0から開始します: ${err}`);
  }

  logger.info(`チェックポイントが存在しないため、最古カーソル (0) から開始します [service=${SERVICE_NAME}]`);
  return 0;
}

async function flushBuffer(client: pg.PoolClient) {
  if (isFlushing || recordBuffer.length === 0) return;
  isFlushing = true;

  const recordsToInsert = [...recordBuffer];
  const maxCursor = highestCursorInBuffer;
  recordBuffer = [];

  try {
    // Multi-row INSERT with ON CONFLICT DO NOTHING
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

    if (maxCursor > 0) {
      // 独立したバックフィル用カーソルのみを更新
      const cursorQuery = `
        INSERT INTO cursor (service, cursor)
        VALUES ($1, $2)
        ON CONFLICT (service)
        DO UPDATE SET cursor = EXCLUDED.cursor;
      `;
      await client.query(cursorQuery, [SERVICE_NAME, maxCursor]);
      lastSavedCursor = maxCursor;
    }

    await client.query('COMMIT');
    totalInserted += recordsToInsert.length;
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error(`バッチ書き込みエラー: ${err}`);
    // エラー時はバッファに戻す
    recordBuffer = [...recordsToInsert, ...recordBuffer];
  } finally {
    isFlushing = false;
  }
}

function normalizeJetstreamEndpoint(rawUrl: string, cursor: number): string {
  const base = rawUrl.replace(/\/$/, '');
  const urlObj = new URL(base.startsWith('http') || base.startsWith('ws') ? base : `wss://${base}`);
  urlObj.protocol = urlObj.protocol.replace(/^http/, 'ws');

  // Jetstream v2 xrpc エンドポイントを優先
  if (urlObj.pathname === '/' || urlObj.pathname === '') {
    urlObj.pathname = '/xrpc/network.bsky.jetstream.subscribe';
  }

  urlObj.searchParams.set('kinds', 'commit');
  if (cursor > 0) {
    urlObj.searchParams.set('cursor', cursor.toString());
  }

  return urlObj.toString();
}

async function main() {
  const client = await pool.connect();

  const startCursor = await getStartCursor(client);
  lastSavedCursor = startCursor;

  if (startCursor >= CUTOFF_TIME_US) {
    logger.info(
      `開始カーソル (${startCursor} - ${epochUsToDateTime(startCursor)}) が終了日時 (${CUTOFF_TIME_US} - ${epochUsToDateTime(CUTOFF_TIME_US)}) に達しているため終了します。`
    );
    client.release();
    await pool.end();
    return;
  }

  const rawEndpoint =
    process.env.JETSTREAM_URL ??
    process.env.JETSREAM_URL ??
    'wss://jetstream2.us-east.bsky.network';

  const wsUrl = normalizeJetstreamEndpoint(rawEndpoint, startCursor);
  logger.info(`Jetstream v2 バックフィル接続先: ${wsUrl}`);
  logger.info(`バックフィル専用カーソルキー: ${SERVICE_NAME}`);
  logger.info(`対象終了日時: ${epochUsToDateTime(CUTOFF_TIME_US)} (${CUTOFF_TIME_US} µs)`);

  // 定期フラッシュタイマー
  flushTimer = setInterval(async () => {
    await flushBuffer(client);
  }, FLUSH_INTERVAL_MS);

  let lastReportedTime = Date.now();
  let lastReportedCount = 0;

  // 定期メトリクスログ
  statsTimer = setInterval(() => {
    const now = Date.now();
    const elapsedSec = (now - lastReportedTime) / 1000;
    const rate = elapsedSec > 0 ? Math.round((totalProcessedEvents - lastReportedCount) / elapsedSec) : 0;
    lastReportedTime = now;
    lastReportedCount = totalProcessedEvents;

    const currentCursorTime = lastSavedCursor > 0 ? epochUsToDateTime(lastSavedCursor) : 'N/A';
    logger.info(
      `[進捗] 現在カーソル: ${currentCursorTime} | 受信イベント: ${totalProcessedEvents} | 挿入レコード: ${totalInserted} | 速度: ${rate} events/s`
    );
  }, 10000);

  const shutdown = async (signal?: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    logger.info(`シャットダウン処理中 (${signal || '完了'})...`);

    if (flushTimer) clearInterval(flushTimer);
    if (statsTimer) clearInterval(statsTimer);

    if (ws) {
      ws.removeAllListeners();
      ws.close();
    }

    await flushBuffer(client);
    logger.info(`バックフィル用チェックポイント保存完了 [service=${SERVICE_NAME}]: cursor = ${lastSavedCursor} (${epochUsToDateTime(lastSavedCursor)})`);

    client.release();
    await pool.end();
    logger.info('バックフィル処理が正常に終了しました');
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  const apiKey = process.env.JETSTREAM_API_KEY || process.env.BLUESKY_API_KEY;
  const headers: Record<string, string> = {
    'User-Agent': 'AtpDashboard-Backfill/1.0',
  };

  if (apiKey) {
    headers['Authorization'] = apiKey.startsWith('Bearer ') ? apiKey : `Bearer ${apiKey}`;
    logger.info('Jetstream APIキー（リプレイ認証）を設定しました');
  } else {
    logger.warn('JETSTREAM_API_KEY が未設定です（アーカイブのリプレイ/バックフィルにAPIキーが必要な場合があります）');
  }

  ws = new WebSocket(wsUrl, ['xrpc.v1.json'], {
    headers,
  });

  ws.on('open', () => {
    logger.info('Jetstream WebSocket 接続が確立しました (subprotocol: xrpc.v1.json)');
  });

  ws.on('message', async (data: WebSocket.RawData) => {
    try {
      const text = data.toString('utf-8');
      const msg = JSON.parse(text);

      // Jetstream v2 wire format または v1 envelope の解析
      let payload = msg;
      let kind = msg.kind;
      let did = msg.did;
      let time_us = msg.time_us;

      if (msg.$type === 'message' && msg.payload) {
        payload = msg.payload;
        did = payload.did;
        time_us = payload.time_us;
        const subType = payload.$type || '';
        if (subType.endsWith('#commit') || subType === 'commit') {
          kind = 'commit';
        } else if (subType.endsWith('#info')) {
          logger.info(`Jetstream #info 通知: ${JSON.stringify(payload)}`);
          return;
        } else {
          return;
        }
      } else if (msg.$type === 'info') {
        logger.info(`Jetstream #info: ${JSON.stringify(msg)}`);
        return;
      } else if (msg.$type === 'error') {
        logger.error(`Jetstream エラーフレーム受信: ${JSON.stringify(msg)}`);
        return;
      }

      if (kind !== 'commit' || !payload.commit) {
        return;
      }

      totalProcessedEvents++;

      // 2025年1月18日の終了時刻判定
      if (time_us && time_us > CUTOFF_TIME_US) {
        logger.info(
          `バックフィル終了日時に到達しました: イベント日時 ${epochUsToDateTime(time_us)} > Cutoff ${epochUsToDateTime(CUTOFF_TIME_US)}`
        );
        await shutdown('CutoffReached');
        return;
      }

      const collection: string = payload.commit.collection;
      const rkey: string = payload.commit.rkey;

      if (!collection || !rkey || !did) {
        return;
      }

      // 公式 bsky コレクションは除外
      if (collection.startsWith('app.bsky') || collection.startsWith('chat.bsky')) {
        if (time_us && time_us > highestCursorInBuffer) {
          highestCursorInBuffer = time_us;
        }
        return;
      }

      const createdAt = epochUsToDateTime(time_us);
      recordBuffer.push({
        did,
        collection,
        rkey,
        createdAt,
        time_us,
      });

      if (time_us > highestCursorInBuffer) {
        highestCursorInBuffer = time_us;
      }

      if (recordBuffer.length >= BATCH_SIZE) {
        await flushBuffer(client);
      }
    } catch (err) {
      logger.error(`メッセージ処理エラー: ${err}`);
    }
  });

  ws.on('close', async (code, reason) => {
    logger.warn(`Jetstream 接続が切断されました (code: ${code}, reason: ${reason.toString()})`);
    if (!isShuttingDown) {
      await shutdown('UnexpectedClose');
    }
  });

  ws.on('error', async (err) => {
    logger.error(`Jetstream WebSocket エラー: ${err.message}`);
    if (!isShuttingDown) {
      await shutdown('Error');
    }
  });
}

main().catch((err) => {
  logger.error(`Fatal Error in backfill: ${err}`);
  process.exit(1);
});
