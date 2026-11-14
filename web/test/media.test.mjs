import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mungeRemoteSdp, yieldsInGlare } from '../src/media.ts';

const FIREFOX_UA = 'Mozilla/5.0 (Windows NT 10.0; rv:159.0) Gecko/20100101 Firefox/159.0';
const CHROME_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';
const FIREFOX_SDP = 'v=0\r\no=mozilla...THIS_IS_SDPARTA-159.0 1 0 IN IP4 0.0.0.0\r\n';
const CHROME_SDP = 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\n';

test('en glare mixto cede Firefox, sea cual sea polite', () => {
  for (const polite of [true, false]) {
    assert.equal(yieldsInGlare(FIREFOX_UA, CHROME_SDP, polite), true);
    assert.equal(yieldsInGlare(CHROME_UA, FIREFOX_SDP, polite), false);
  }
});

test('en glare entre iguales decide polite', () => {
  for (const polite of [true, false]) {
    assert.equal(yieldsInGlare(CHROME_UA, CHROME_SDP, polite), polite);
    assert.equal(yieldsInGlare(FIREFOX_UA, FIREFOX_SDP, polite), polite);
  }
});

const sdp = (...lines) => lines.join('\r\n');
const lineFor = (out, pt) => out.split('\r\n').find((l) => l.startsWith(`a=fmtp:${pt} `));

const VIDEO = sdp(
  'v=0',
  'm=video 9 UDP/TLS/RTP/SAVPF 96 97 98 99',
  'a=mid:1',
  'a=rtpmap:96 VP8/90000',
  'a=rtpmap:97 rtx/90000',
  'a=fmtp:97 apt=96',
  'a=rtpmap:98 H264/90000',
  'a=fmtp:98 profile-level-id=42e01f;packetization-mode=1',
  'a=rtpmap:99 ulpfec/90000',
);

test('codec de vídeo sin fmtp recibe una línea tras su rtpmap', () => {
  const lines = mungeRemoteSdp(VIDEO).split('\r\n');
  const i = lines.indexOf('a=rtpmap:96 VP8/90000');
  assert.equal(lines[i + 1], 'a=fmtp:96 x-google-start-bitrate=8000;x-google-max-bitrate=100000');
});

test('codec con fmtp conserva sus parámetros y añade los de bitrate', () => {
  const l = lineFor(mungeRemoteSdp(VIDEO), 98);
  assert.match(l, /profile-level-id=42e01f/);
  assert.match(l, /packetization-mode=1/);
  assert.match(l, /x-google-start-bitrate=8000/);
  assert.match(l, /x-google-max-bitrate=100000/);
});

test('rtx y fec no se tocan', () => {
  const out = mungeRemoteSdp(VIDEO);
  assert.equal(lineFor(out, 97), 'a=fmtp:97 apt=96');
  assert.equal(lineFor(out, 99), undefined);
});

test('opus pasa a estéreo y bitrate alto', () => {
  const out = mungeRemoteSdp(
    sdp('m=audio 9 UDP/TLS/RTP/SAVPF 111', 'a=rtpmap:111 opus/48000/2', 'a=fmtp:111 minptime=10;useinbandfec=1'),
  );
  const l = lineFor(out, 111);
  assert.match(l, /minptime=10/);
  assert.match(l, /useinbandfec=1/);
  assert.match(l, /stereo=1/);
  assert.match(l, /sprop-stereo=1/);
  assert.match(l, /maxaveragebitrate=510000/);
});

test('un parámetro ya presente se sobrescribe, no se duplica', () => {
  const out = mungeRemoteSdp(sdp('m=audio 9 RTP 111', 'a=rtpmap:111 opus/48000/2', 'a=fmtp:111 stereo=0'));
  assert.equal(lineFor(out, 111).match(/stereo=/g).length, 2); // stereo y sprop-stereo
  assert.match(lineFor(out, 111), /(^|[ ;])stereo=1/);
});

test('sesión y m=application quedan intactas', () => {
  const input = sdp('v=0', 'o=- 1 2 IN IP4 127.0.0.1', 'm=application 9 UDP/DTLS/SCTP webrtc-datachannel', 'a=mid:0', '');
  assert.equal(mungeRemoteSdp(input), input);
});

test('extmap no se modifica: los ID de extensión RTP son negociados', () => {
  const ext = 'a=extmap:2 http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time';
  assert.ok(mungeRemoteSdp(sdp('m=video 9 RTP 96', ext, 'a=rtpmap:96 VP8/90000')).includes(ext));
});

test('las secciones se conservan en orden', () => {
  const input = sdp('v=0', 'm=application 9 X webrtc-datachannel', 'a=mid:0', 'm=audio 9 RTP 111', 'a=mid:1', 'm=video 9 RTP 96', 'a=mid:2');
  assert.deepEqual(mungeRemoteSdp(input).match(/^m=\w+/gm), ['m=application', 'm=audio', 'm=video']);
});
