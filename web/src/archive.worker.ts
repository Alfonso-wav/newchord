// Archivo local: SQLite (WASM) en el OPFS de este navegador, por origen. Nada de esto viaja: ni al
// servidor ni a los demás. Se usa el VFS opfs-sahpool porque no necesita aislamiento entre orígenes.
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';

const FILE = '/cryptopo.sqlite3';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS messages (
  room       TEXT NOT NULL,
  id         TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('chat', 'image', 'stt', 'tts')),
  author     TEXT NOT NULL,
  author_key TEXT NOT NULL DEFAULT '',
  via        TEXT,
  mine       INTEGER NOT NULL DEFAULT 0,
  text       TEXT NOT NULL DEFAULT '',
  mime       TEXT,
  width      INTEGER,
  height     INTEGER,
  data       BLOB,
  ts         INTEGER NOT NULL,
  PRIMARY KEY (room, id)
);
CREATE INDEX IF NOT EXISTS messages_room_ts ON messages(room, ts);
`;

export interface ArchiveRow {
  room: string;
  id: string;
  kind: 'chat' | 'image' | 'stt' | 'tts';
  author: string;
  author_key: string;
  via: string | null;
  mine: number;
  text: string;
  mime: string | null;
  width: number | null;
  height: number | null;
  data: Uint8Array | null;
  ts: number;
}

export type ArchiveReq =
  | { op: 'add'; row: ArchiveRow }
  | { op: 'list'; room: string; limit: number }
  | { op: 'clear'; room: string | null }
  | { op: 'export' }
  | { op: 'stats' };

export interface ArchiveStats {
  persistent: boolean;
  messages: number;
  images: number;
  transcripts: number;
  bytes: number;
}

type Db = {
  exec(sql: string | { sql: string; bind?: unknown[]; rowMode?: 'object'; returnValue?: 'resultRows' }): unknown;
  selectObjects(sql: string, bind?: unknown[]): Record<string, unknown>[];
  selectValue(sql: string, bind?: unknown[]): unknown;
};

const ready = (async () => {
  const sqlite3 = await sqlite3InitModule();
  try {
    const pool = await sqlite3.installOpfsSAHPoolVfs({ name: 'cryptopo' });
    const db = new pool.OpfsSAHPoolDb(FILE) as unknown as Db;
    db.exec(SCHEMA);
    return { db, persistent: true, exportFile: () => pool.exportFile(FILE) };
  } catch (e) {
    // Sin OPFS (navegación privada en algunos navegadores): en memoria, y la interfaz lo avisa.
    console.warn('archivo local sin OPFS', e);
    const db = new sqlite3.oo1.DB(':memory:') as unknown as Db;
    db.exec(SCHEMA);
    return { db, persistent: false, exportFile: () => sqlite3.capi.sqlite3_js_db_export(db as never) };
  }
})();

async function handle(r: ArchiveReq): Promise<unknown> {
  const { db, persistent, exportFile } = await ready;
  switch (r.op) {
    case 'add': {
      const x = r.row;
      db.exec({
        sql: `INSERT OR IGNORE INTO messages (room, id, kind, author, author_key, via, mine, text, mime, width, height, data, ts)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        bind: [x.room, x.id, x.kind, x.author, x.author_key, x.via, x.mine, x.text, x.mime, x.width, x.height, x.data, x.ts],
      });
      return null;
    }
    case 'list':
      // Los últimos `limit`, en orden de llegada.
      return db
        .selectObjects('SELECT * FROM (SELECT * FROM messages WHERE room = ? ORDER BY ts DESC LIMIT ?) ORDER BY ts', [r.room, r.limit])
        .map((o) => o as unknown as ArchiveRow);
    case 'clear':
      if (r.room === null) db.exec('DELETE FROM messages');
      else db.exec({ sql: 'DELETE FROM messages WHERE room = ?', bind: [r.room] });
      db.exec('VACUUM');
      return null;
    case 'export':
      return exportFile();
    case 'stats': {
      const n = (sql: string) => Number(db.selectValue(sql) ?? 0);
      return {
        persistent,
        messages: n('SELECT count(*) FROM messages'),
        images: n("SELECT count(*) FROM messages WHERE kind = 'image'"),
        transcripts: n("SELECT count(*) FROM messages WHERE kind IN ('stt', 'tts')"),
        bytes: n('SELECT coalesce(sum(length(data)), 0) + coalesce(sum(length(text)), 0) FROM messages'),
      } satisfies ArchiveStats;
    }
  }
}

onmessage = async (e: MessageEvent<{ n: number; req: ArchiveReq }>) => {
  const { n, req } = e.data;
  try {
    const result = await handle(req);
    const transfer = result instanceof Uint8Array ? [result.buffer as ArrayBuffer] : [];
    postMessage({ n, result }, { transfer });
  } catch (err) {
    postMessage({ n, error: (err as Error).message });
  }
};
