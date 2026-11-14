// AudioWorklet del dictado: baja el micro a 16 kHz mono y lo manda en bloques de 100 ms por el
// puerto que le dan, directo al worker de Whisper. JS plano: se sirve tal cual (?url).
const OUT_RATE = 16000;
const BLOCK = 1600;

class Capture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.port2 = null;
    this.ratio = sampleRate / OUT_RATE;
    this.acc = 0;
    this.n = 0;
    this.pos = 0;
    this.buf = new Float32Array(BLOCK);
    this.fill = 0;
    this.port.onmessage = (e) => {
      if (e.data && e.data.port) this.port2 = e.data.port;
    };
  }

  // Media de las muestras que caen en cada salida: filtro de caja, de sobra para voz.
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch || !this.port2) return true;
    for (let i = 0; i < ch.length; i++) {
      this.acc += ch[i];
      this.n++;
      this.pos += 1;
      if (this.pos >= this.ratio) {
        this.pos -= this.ratio;
        this.buf[this.fill++] = this.acc / this.n;
        this.acc = 0;
        this.n = 0;
        if (this.fill === BLOCK) {
          this.port2.postMessage(this.buf, [this.buf.buffer]);
          this.buf = new Float32Array(BLOCK);
          this.fill = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor('cryptopo-capture', Capture);
