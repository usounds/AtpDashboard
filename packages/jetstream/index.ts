import { Jetstream } from '@skyware/jetstream';
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

const client = await pool.connect();

async function getLastCursorFromDB(): Promise<number | null> {
  try {
    const query = "SELECT cursor FROM cursor WHERE service = 'collection';";
    const result = await client.query(query);
    const ret = result.rows.length > 0 ? result.rows[0].cursor : 1737023918000000;
    logger.info(`カーソル: ${ret}  (${epochUsToDateTime(ret)})`);

    return ret;
  } catch (err) {
    logger.error(`カーソルの読み込みに失敗しました: ${err}`);
    return null;
  }
}

const lastCursor = await getLastCursorFromDB();
let prev_time_us = lastCursor;

const jetstream = new Jetstream({
  cursor: prev_time_us,
  endpoint: process.env.JETSTREAM_URL ?? process.env.JETSREAM_URL,
  ws: WebSocket,
});

let event_count = 0;
let cursorUpdateInterval: NodeJS.Timeout;

function epochUsToDateTime(cursor: number): string {
  return new Date(cursor / 1000).toISOString();
}

export const CURSOR_UPDATE_INTERVAL = process.env.CURSOR_UPDATE_INTERVAL
  ? Number(process.env.CURSOR_UPDATE_INTERVAL)
  : 60000;

jetstream.on('open', () => {
  logger.info(`Jetstreamに接続しました:${process.env.JETSTREAM_URL ?? process.env.JETSREAM_URL}`);

  cursorUpdateInterval = setInterval(async () => {
    if (jetstream.cursor) {
      logger.info(`cursor更新: ${jetstream.cursor} (${epochUsToDateTime(jetstream.cursor)}) event:${event_count}`);
      event_count = 0;
      const query = `
        INSERT INTO cursor (service, cursor)
        VALUES ('collection', $1)
        ON CONFLICT (service)
        DO UPDATE SET cursor = EXCLUDED.cursor;
      `;

      await client.query(query, [jetstream.cursor]);

      if (prev_time_us === jetstream.cursor) {
        logger.info('前回からtime_usが変動していませんので再接続します');
        jetstream.close();
      }
      prev_time_us = jetstream.cursor;
    }
  }, CURSOR_UPDATE_INTERVAL);
});

jetstream.on('commit', async (event) => {
  if (event.commit.collection.startsWith('app.bsky') || event.commit.collection.startsWith('chat.bsky')) return;

  const createdAt = epochUsToDateTime(event.time_us);

  const query = `
    INSERT INTO public.collection (did, collection, rkey, "createdAt")
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (did, collection, rkey, "createdAt")
    DO NOTHING;
  `;

  await client.query(query, [
    event.did,
    event.commit.collection,
    event.commit.rkey,
    createdAt,
  ]);

  event_count++;
});

jetstream.on('close', () => {
  clearInterval(cursorUpdateInterval);
  logger.warn('Jetstreamとの接続が切れました');
  process.exit(1);
});

jetstream.on('error', async (error) => {
  logger.error(`Jetstreamでエラーが発生しました: ${error.message}`);
  jetstream.close();
  process.exit(1);
});

await jetstream.start();
