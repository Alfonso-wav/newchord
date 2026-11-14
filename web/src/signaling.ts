import type { Envelope } from './e2e';

export interface PeerInfo {
  id: string;
  name: string;
}

export interface RoomInfo {
  name: string;
  members: PeerInfo[];
  fixed?: boolean; // canal de -channels: no se puede borrar
}

export type ServerMsg =
  | { type: 'auth-required'; nonce: string }
  | { type: 'auth-failed'; nonce: string }
  | { type: 'invite'; iv: string; ct: string }
  | { type: 'invite-failed' }
  | { type: 'hello'; id: string; ice: RTCIceServer[]; relay?: boolean; rooms: RoomInfo[] }
  | { type: 'room-full'; room: string }
  | { type: 'room-busy'; room: string }
  | { type: 'rooms'; rooms: RoomInfo[] }
  | { type: 'joined'; room: string; peers: PeerInfo[] }
  | { type: 'peer-joined'; id: string; name: string }
  | { type: 'peer-left'; id: string }
  | { type: 'signal'; from: string; data: Envelope };

export interface SignalData {
  description?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
  gen?: number; // generación de la conexión; lo de otra generación se descarta
  reset?: boolean; // rehacer la conexión en la generación `gen`
  failed?: boolean; // el otro se ha rendido tras varios intentos
}

// WebSocket con reconexión automática. Al reconectar el servidor manda un
// "hello" nuevo y Mesh vuelve a unirse a la sala.
export class Signaling {
  onMessage: (m: ServerMsg) => void = () => {};
  onStatus: (online: boolean) => void = () => {};
  private ws: WebSocket | null = null;

  constructor(private url: string) {
    this.connect();
  }

  private connect() {
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => this.onStatus(true);
    ws.onmessage = (e) => {
      try {
        this.onMessage(JSON.parse(e.data));
      } catch (err) {
        console.warn('mensaje del servidor no válido', err);
      }
    };
    ws.onclose = () => {
      this.ws = null;
      this.onStatus(false);
      setTimeout(() => this.connect(), 2000);
    };
  }

  // Cierra para volver a empezar: quien olvida la clave deja de estar autenticado aquí.
  reconnect() {
    this.ws?.close();
  }

  send(m: object) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }
}

export function wsUrl() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/ws`;
}
