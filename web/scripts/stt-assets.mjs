// Prepara el modelo del dictado para servirlo desde el propio binario, sin Hugging Face en tiempo
// de uso: Whisper base cuantizado, descargado una vez de una revisión fija y comprobado por SHA-256.
// Sin la huella exacta no se guarda nada. (El runtime de ONNX lo empaqueta Vite desde node_modules.)
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const web = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(web, 'public', 'stt');

const REPO = 'onnx-community/whisper-base';
const REV = '27a07b4b52b3a4c5886134bb4320e93e1a4bbc7c';
const MODEL = {
  'config.json': 'f4d0608f7d918166da7edb3e188de5ef1bfe70d9802e785d271fd88111e9cf4b',
  'generation_config.json': '61070cf8de25b1e9256e8e102ded49d8d24a8369ed36ef84fdf21549e68125a0',
  'preprocessor_config.json': 'a6a76d28c93edb273669eb9e0b0636a2bddbb1272c3261e47b7ca6dfdbac1b8d',
  'tokenizer.json': '27fc476bfe7f17299480be2273fc0608e4d5a99aba2ab5dec5374b4482d1a566',
  'tokenizer_config.json': '2e036e4dbacfdeb7242c7d4ec4149f4a16e86026048f94d1637e3a8ee9c6a573',
  'onnx/encoder_model_quantized.onnx': '5862993336bf33acd23736071aae2b32261d3b1b2f37780194460d4ef974dd46',
  'onnx/decoder_model_merged_quantized.onnx': 'fa3ef9902734ce5ae6f9ef2bdb2ba9a6c4b5785b09f4f420ce036573dc9d090b',
};

const sha = (buf) => createHash('sha256').update(buf).digest('hex');

async function hashOf(path) {
  try {
    return sha(await readFile(path));
  } catch {
    return '';
  }
}

for (const [file, want] of Object.entries(MODEL)) {
  const dest = join(out, 'models', REPO, file);
  if ((await hashOf(dest)) === want) continue;
  const url = `https://huggingface.co/${REPO}/resolve/${REV}/${file}`;
  process.stdout.write(`stt: descargando ${file}… `);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const got = sha(buf);
  if (got !== want) throw new Error(`${file}: SHA-256 ${got}, se esperaba ${want}`);
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest + '.part', buf);
  await rename(dest + '.part', dest);
  console.log(`${(buf.length / 1e6).toFixed(1)} MB`);
}
