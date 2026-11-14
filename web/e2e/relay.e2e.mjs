// TURN real y WebKit con WebRTC: el WebKit de Playwright para Windows no trae RTCPeerConnection, así
// que todo va en Docker. Levanta coturn (use-auth-secret) y el contenedor oficial de Playwright con
// el servidor compilado para Linux, y ejecuta relay.inner.mjs dentro. Requiere Docker en marcha.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, test } from 'node:test';

const ROOT = resolve(import.meta.dirname, '..', '..');
const PW_IMAGE = 'mcr.microsoft.com/playwright:v1.64.1-noble';
const TURN_IMAGE = 'coturn/coturn:latest';
const NET = 'cryptopo-e2e';
const SECRET = randomBytes(24).toString('hex');
let tmp;

const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8' }).trim();
const quiet = (...args) => spawnSync('docker', args, { stdio: 'ignore' });

before(() => {
  tmp = mkdtempSync(join(tmpdir(), 'cryptopo-relay-'));
  execFileSync('go', ['build', '-o', join(tmp, 'cryptopo'), '.'], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, GOOS: 'linux', GOARCH: 'amd64', CGO_ENABLED: '0' },
  });
  quiet('rm', '-f', 'nc-turn');
  quiet('network', 'rm', NET);
  docker('network', 'create', NET);
  docker(
    'run', '-d', '--name', 'nc-turn', '--network', NET, TURN_IMAGE,
    '-n', '--log-file=stdout', '--listening-port=3478', '--realm=cryptopo', '--use-auth-secret',
    `--static-auth-secret=${SECRET}`, '--no-tls', '--verbose', '--fingerprint',
    '--min-port=49160', '--max-port=49200',
  );
});

after(() => {
  if (process.env.KEEP_TURN) return;
  quiet('rm', '-f', 'nc-turn');
  quiet('network', 'rm', NET);
  rmSync(tmp, { recursive: true, force: true });
});

test('coturn + WebKit/Chromium de Linux con -relay-only', () => {
  const r = spawnSync(
    'docker',
    [
      'run', '--rm', '--network', NET, '--ipc=host', '-e', `TURN_SECRET=${SECRET}`,
      '-v', `${tmp}:/nc:ro`, '-v', `${import.meta.dirname}:/e2e:ro`, PW_IMAGE,
      'bash', '-c', 'mkdir -p /tmp/pw && cd /tmp/pw && npm i --silent --no-save playwright-core@1.64.1 >/dev/null && node --test /e2e/relay.inner.mjs',
    ],
    { encoding: 'utf8', timeout: 300_000 },
  );
  const turnLog = docker('logs', 'nc-turn');
  console.log(r.stdout.split('\n').filter((l) => /chromium|^(not )?ok/.test(l)).join('\n'));
  if (r.status !== 0) console.log(r.stdout, r.stderr, turnLog.split('\n').slice(-40).join('\n'));
  assert.equal(r.status, 0, 'falló dentro del contenedor');
  assert.match(turnLog, /ALLOCATE processed, success/, 'coturn no concedió ninguna asignación');
  assert.doesNotMatch(turnLog, /Cannot find credentials/i, 'coturn rechazó credenciales');
});
