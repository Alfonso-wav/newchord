// Cliente del archivo local (archive.worker.ts). Si el worker no arranca, la sala sigue igual:
// solo deja de guardarse, y `failed` lo cuenta.
import workerURL from './archive.worker.ts?worker&url';
import { scriptURL } from './tt';
import type { ArchiveReq, ArchiveRow, ArchiveStats } from './archive.worker';

export type { ArchiveRow, ArchiveStats };

export class Archive {
  failed = '';
  private worker: Worker | null = null;
  private n = 0;
  private waiting = new Map<number, { ok: (v: unknown) => void; ko: (e: Error) => void }>();

  private get w() {
    if (!this.worker && !this.failed) {
      try {
        this.worker = new Worker(scriptURL(workerURL), { type: 'module', name: 'archivo' });
        this.worker.onmessage = (e: MessageEvent<{ n: number; result?: unknown; error?: string }>) => {
          const p = this.waiting.get(e.data.n);
          this.waiting.delete(e.data.n);
          if (e.data.error !== undefined) p?.ko(new Error(e.data.error));
          else p?.ok(e.data.result);
        };
        this.worker.onerror = (e) => this.fail(e.message || 'el archivo local no arrancó');
      } catch (e) {
        this.fail((e as Error).message);
      }
    }
    return this.worker;
  }

  private fail(msg: string) {
    this.failed = msg;
    for (const p of this.waiting.values()) p.ko(new Error(msg));
    this.waiting.clear();
    this.worker?.terminate();
    this.worker = null;
  }

  private call<T>(req: ArchiveReq): Promise<T> {
    const w = this.w;
    if (!w) return Promise.reject(new Error(this.failed));
    const n = ++this.n;
    return new Promise<T>((ok, ko) => {
      this.waiting.set(n, { ok: ok as (v: unknown) => void, ko });
      w.postMessage({ n, req });
    });
  }

  add(row: ArchiveRow) {
    return this.call<null>({ op: 'add', row });
  }
  list(room: string, limit = 200) {
    return this.call<ArchiveRow[]>({ op: 'list', room: room.toLowerCase(), limit });
  }
  clear(room: string | null) {
    return this.call<null>({ op: 'clear', room: room?.toLowerCase() ?? null });
  }
  exportFile() {
    return this.call<Uint8Array<ArrayBuffer>>({ op: 'export' });
  }
  stats() {
    return this.call<ArchiveStats>({ op: 'stats' });
  }
}
