# Hallazgos y errores conocidos

Registro de lo aprendido probando cryptopo. Cada entrada separa lo **medido** de lo que es
**hipótesis**. Última revisión: 2026-11-01 (prueba Windows ↔ Kali en WSL2).

## Estado

| ID | Qué | Estado |
|----|-----|--------|
| H1 | Oferta rechazada deja la conexión colgada sin aviso | **Arreglado**, con fallo inyectado en Chrome y Firefox |
| H2 | Firefox ↔ Chromium: `RTP extension ID reassignment` | **Arreglado**, reproducido y con E2E |
| H3 | Firefox Windows ↔ Kali: ICE falla | **Causa medida**: ruta de red de esta máquina, no cryptopo. Sin arreglo en la app |
| H4 | `-stun ""` sin TURN: `"ice":null` rompe todos los peers | **Arreglado** |
| H5 | El micro se abría y publicaba solo al entrar en sala | **Arreglado**: se abre en silencio, se habla con `M` |
| H6 | Pitido y parpadeo en Kali | No es bug: micro falso de Chromium |
| H7 | Firefox termina la captura al minimizar la ventana | **Medido y mitigado**: pausa y reanudar con un clic y el selector; el corte es del navegador |
| H8 | Móvil en la misma red que el PC se queda en `conectando…` | **Sin causa medida**; con datos móviles conecta |
| H9 | `wails build` vaciaba `web/dist` y metía el panel en su lugar | **Arreglado**, ver abajo |
| H10 | TURN integrado | Medido en local; Funnel sin medir |
| H11 | App Android: el WebView no tiene `getDisplayMedia` | **Resuelto** con puente nativo; medido en emulador, falta móvil real |
| H12 | Dictado, imágenes y archivo local bajo el CSP | **Funciona** en Chrome y Firefox reales; Safari y Android sin medir |

## H1. Oferta rechazada: conexión colgada en silencio

**Síntoma:** chat y lista de usuarios funcionan; sale `X está emitiendo`, pero nunca aparece la
ficha de pantalla. Tampoco llega el micro del otro.

**Mecanismo (medido):** `setRemoteDescription` falla en el receptor, y el emisor se queda en
`have-local-offer`, donde ya no dispara `negotiationneeded`. El DataChannel abierto sigue vivo, así
que el chat va. `addSource` llama a `broadcastMeta()` antes de `attach()`, así que el toast "está
emitiendo" no prueba que haya media.

**Arreglo:** `onSignalError` (`web/src/mesh.ts`). Quien falla rehace su `RTCPeerConnection` y envía
`{ reset, gen }`, y el otro rehace la suya. Toda señal lleva `gen` y se descarta la de otra
generación. Inicia siempre el id menor. Tras 3 intentos en 60 s se rinde: ambos marcan `failed` y la
ficha muestra `· sin conexión`.

**Tests:** E2E de rechazo en emisor y receptor, rechazo persistente sin bucle, y rechazo con
Chrome y con Firefox. Los fallos son inyectados: no se ha visto un rechazo real desde H2.

## H2. Firefox ↔ Chromium: reasignación de extensión RTP

**Error real, en Chromium (Kali) al recibir oferta de Firefox (Windows):**

```
InvalidAccessError: Failed to execute 'setRemoteDescription' on 'RTCPeerConnection':
Failed to set remote offer sdp: RTP extension ID reassignment not supported
(collision on active MID 1, id=2, old_uri="http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time",
new_uri="urn:ietf:params:rtp-hdrext:csrc-audio-level"). (mid=1)
```

**Causa (medida, Chrome 156 ↔ Firefox 159):** ofertas cruzadas con Chromium como `polite`.
Reproducido 3/3 reteniendo la señalización mientras ambos añaden micro, con el DataChannel ya abierto;
0/3 con Firefox como `polite`. Chromium ofrece audio con `2=abs-send-time` y Firefox con
`2=csrc-audio-level`. Sin cruce no hay error: Firefox recorta el id en su respuesta antes de reofrecer.

**Rollback explícito no sirve (medido):** tras `setLocalDescription({ type: 'rollback' })`, Chromium da
el mismo error para `MID 1` y reofrece en `mid 2`. Chromium no puede ceder ante Firefox.

**Arreglo:** `yieldsInGlare` (`web/src/media.ts`). Entre navegadores distintos cede siempre Firefox,
y entre iguales decide `polite`. El navegador remoto se deduce del SDP (`o=mozilla`).

**Tests:** `web/e2e/firefox.e2e.mjs` (`npm run test:e2e:firefox`) y unitarios de `yieldsInGlare`.
También probado 6/6 entre Firefox 159 en Windows y Chromium 150 en Kali por la red de WSL, con micro y
pantalla cruzados y dispositivos falsos.

**Por qué antes no se reproducía:** Firefox headless se quedaba en `connecting`. Entre navegadores
locales necesita `media.peerconnection.ice.obfuscate_host_addresses=false` y
`media.peerconnection.ice.loopback=true`, y además hacía falta forzar el cruce.

## H3. Primer intento sin P2P

Windows (Firefox) y Kali se veían en la sala, pero no iban ni chat ni pantalla. Al salir y
volver a entrar en Kali, el chat empezó a funcionar.

**Descartado por medición:** bloqueo de red. UDP pasa Windows→Kali y Kali→Windows (probado con
Python), aunque Hyper-V tenga `DefaultInboundAction: Block`.

**Corrección importante:** se atribuyó a mDNS y se dijo que hacía falta activar el micro para
obtener IPs reales. Ninguna de las dos cosas está demostrada:
- Con `--use-fake-ui-for-media-stream`, Chrome expone IPs reales sin pedir micro (medido).
- El micro ya se activa solo al entrar (H5).

La causa sigue sin conocerse. Si reaparece, capturar antes de reentrar:
`cryptopo.peerViews().map(p => [p.name, p.state])` y `chrome://webrtc-internals` (o
`about:webrtc` en Firefox).

**Reproducido (2026-11-01), Firefox 159 headless en Windows ↔ Chromium 150 headless en Kali:**
- Con la app: 3/6, 2/6 y 2/6 corridas conectan; una corrida anterior dio 6/6, antes de los cambios de H1.
- Estado al fallar: `sig: stable`, `gen: 0`, sin errores, y en Firefox `conn: failed`, `ice: checking`
  y a veces `dc: closed`. Chromium sigue en `connecting`. La señalización terminó bien.
- Firefox solo anuncia `192.168.1.88`, nunca la interfaz de WSL (`172.27.32.1`). Kali anuncia
  `172.27.39.27`.
- Sin cryptopo, con `RTCPeerConnection` pelado: 0/12, con cualquiera de los dos como oferente. Ese
  control no es idéntico: Chromium iba sin `--use-fake-ui-for-media-stream`, así que pudo anunciar mDNS.

**Descartado:** micro activo en Firefox antes de entrar (2/6, igual que sin él).

**Causa (medida 2026-11-01, segunda tanda):** Firefox solo usa `192.168.1.88` y desde esa IP no se llega
a Kali. UDP pelado con Python, que tiene regla Allow, así que no interviene el bloqueo de Firefox:

| Ruta | Resultado |
|---|---|
| Windows atado a `192.168.1.88` → Kali | no llega |
| Windows atado a `172.27.32.1` → Kali | llega |
| Windows sin atar → Kali | llega, con origen `172.27.32.1` |
| Kali → `192.168.1.88` | llega, con el origen reescrito a `192.168.1.88` |
| Kali → `172.27.32.1` | llega, con origen real |

| Windows ↔ Chromium 150 en Kali, app real | Conectan |
|---|---|
| Firefox 159: por defecto, sin ofuscar, micro antes, micro después, `default_address_only=false`, `force_interface` | 0/36 |
| Firefox 159 con STUN: por defecto y sin ofuscar | 0/12 |
| Chrome en Windows, anuncia todas las interfaces | 18/18, siempre por `172.27.32.1` |

Al fallar, Chromium envía 111 checks con 0 respuestas y 0 peticiones recibidas, así que los checks de
Firefox tampoco llegan. Ningún par por `192.168.1.88` tuvo éxito ni siquiera con Chrome.

**También medido:**
- Por defecto Firefox anuncia `.local`, incluso con micro concedido. Chromium en Kali no lo resuelve a
  través del NAT de WSL y se queda en `new`, sin pares. Es una segunda barrera en esta topología.
- `force_interface` con el nombre del adaptador no cambió nada: siguió en `192.168.1.88`.
- `--force-webrtc-ip-handling-policy=default_public_interface_only` no limitó a Chrome headless, así que
  Chrome no se ha probado con solo `192.168.1.88`.

**Sin medir:**
- Por qué antes conectaban 2–3 de 6. No se ha repetido, y el arnés de entonces no se conservó.
- Cuánto aporta el firewall. Firefox tiene reglas `Inbound Block` en `Public`, y `Ethernet 11` es `Public`;
  cambiarlas pide administrador. La ruta rota no depende de ellas, pero entre dos máquinas reales podrían
  impedir que entren los checks hasta que Firefox abra paso.
- Dos máquinas físicas distintas, WSL con `networkingMode=mirrored` y TURN.

**Consecuencia:** el fallo es de Firefox en Windows contra una VM en NAT del mismo equipo. Para probar
con Kali, usar Chrome en Windows. No sirve como prueba de Firefox entre máquinas reales.

**Aparte:** `restartIce` al llegar a `failed` no lo recupera en Firefox, y el DataChannel queda cerrado.

## H4. `"ice":null` (arreglado)

Con `-stun ""` y sin `-turn`, `h.ice` era nil y Go lo serializaba como `null`.
`new RTCPeerConnection({ iceServers: null })` lanza, y no se creaba ningún peer: `peers` vacío,
el WebSocket online y ningún error en la UI.

**Arreglo:** `ice` se inicializa vacío en `main.go`, y el cliente usa `m.ice ?? []`.
**Test:** `el servidor sin STUN entrega ICE vacío, no null`; los E2E corren con `-stun ""`.

## H5. Micro automático al entrar

`App.tsx` llama a `captureMic()` en cada `join`, con la pista desactivada: `micMuted` empieza en `true`
y vuelve a `true` al salir. Consecuencias:
- El botón sale como `mudo`, y `M` activa el micro.
- El navegador muestra el micro en uso aunque no se envíe audio.
- Dos personas entrando a la vez ofrecen casi simultáneamente. Chrome ↔ Chrome lo resuelve bien
  (cubierto por test).

## H6. Pip-pip-pip en Kali

`--use-fake-device-for-media-stream` emite un pitido periódico. La ficha lo detecta como voz, y
por eso parpadea. Se quita lanzando Chromium sin ese flag o silenciando con `M`.

## H7. Minimizar una ventana compartida

**Síntoma (sesión real, Firefox en Windows):** al minimizar WhatsApp desaparece la ficha en Linux y se
apaga el botón de pantalla.

**Medido, Firefox 159 en Windows, ventana real elegida en el selector:** al minimizar, la pista pasa a
`ended` con el evento `ended`, y restaurar no la recupera. Compartiendo `Screen 1`, la pista sigue `live`
durante el minimizado y después. El selector se maneja por Marionette con
`MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1`, `-remote-allow-system-access` y `PopupNotifications` en contexto chrome.

**Medido, Chrome 156 en Windows, captura real:** con ventana Win32 minimizada, ventana oculta y
Calculadora minimizada, la pista sigue `live`, sin `ended` ni `mute`, y no llegan frames nuevos. Una
ventana quieta tampoco produce frames, así que el emisor no distingue minimizada de quieta. WhatsApp
sin medir.

**Restaurar en Chrome (medido 2026-11-02, Chrome en Windows, ventana WinForms real):** minimizada da 0 frames
con la pista `live`, y al restaurar vuelven solos, unos 10 por segundo, sin eventos ni código de la app. El
emisor no se entera, así que la ficha no pasa a `en pausa`: quien mira ve la imagen congelada.

**Límite:** una web no puede impedir ese corte ni volver a capturar sin clic y selector. No hay forma de
seguir emitiendo la ventana minimizada desde Firefox.

**Reanudar solo en Firefox: no es posible desde la web.** La pista terminada no revive, y cada reanudación
real mostró de nuevo el selector.

**Mitigación:** con `ended` en la pantalla la fuente queda `paused`. Quien mira conserva la ficha, con
la última imagen y `· en pausa`; quien emite ve `EN PAUSA · reanudar`. `resumeSource` usa `replaceTrack`
y no renegocia si no cambian los tipos de pista. También afecta a "dejar de compartir" del navegador: hay
que cortar desde el diálogo.

**Tests:** `ended` simulado en E2E de Chrome y de Firefox. Firefox no entrega un `ended` sintético de
`dispatchEvent`, por eso su test llama al listener de la app. Con minimizado real, en la app y en Firefox: pausa, clic en
el botón, selector y `REC`. Cancelar el selector abre el diálogo, que es donde se puede cortar. Ese flujo se
midió con un arnés suelto; en el repo solo hay E2E con `ended` simulado.

**Interfaz revisada en pantalla (2026-11-01, Chrome headless, `ended` simulado):** el emisor ve el botón
rojo y el aviso, quien mira conserva la última imagen con `· en pausa`, y al reanudar vuelve `REC`. La ficha
propia del emisor queda en negro durante la pausa, porque su pista ya está parada.

## H8. Móvil en la misma red que el PC

**Medido (2026-11-02, Tailscale Funnel, Chrome en Windows ↔ Chrome en Android):**

| Móvil | Resultado |
|---|---|
| Misma IP pública que el PC, probablemente su WiFi | `conectando…` sin pasar de ahí; tampoco con Firefox en el PC |
| Datos móviles | Conecta, según lo visto en la prueba manual |

Es la primera conexión real entre redes distintas. Solo hubo una prueba, sin TURN, y no se capturaron
candidatos ICE.

**Hipótesis sin medir:** aislamiento de clientes WiFi, router sin hairpin NAT o candidatos `.local` sin
resolver. Si reaparece, capturar candidatos y pares con `getStats()` antes de cambiar de red.

**También medido:** con Funnel, `forwarded_for` trae la IP real, y entrar desde el propio PC muestra su
IP de Tailscale. En red `Public`, Firefox tiene `Inbound Block` y Chrome `Allow`.

**Consecuencia:** para probar con el móvil, usar datos. Un amigo en otra red no pasa por esta ruta.

## H9. `wails build` y `web/dist`

**Medido con Wails 2.17.1:** `SyncFrontendDistToEmbedTarget` borra todo embed cuya última carpeta sea `dist`, copia
ahí `frontend:dir/dist` y al terminar lo deja en un `.gitkeep`. Con `frontend:dir: panel`, `web/dist` acababa con el
panel dentro del binario y vacío en disco, y el E2E siguiente no encontraba la app.

**Arreglo:** la función no hace nada si el directorio es `frontend`, así que `panel/` pasó a llamarse así. `build.ps1`
falla si `web/dist/index.html` desaparece.

## H10. TURN integrado

**Medido (2026-11-02, `builtin-turn.e2e.mjs`, dos Chrome en la misma máquina, `-builtin-turn -relay-only`):**
Chrome acepta `turn:127.0.0.1:<puerto>?transport=tcp`, obtiene un candidato `relay` en `127.0.0.1`, y el
par elegido es relay ↔ relay por TCP. El audio llega (más de 100 paquetes).

**Sin medir:** el tramo por Funnel (`turns:…ts.net:8443`, TLS terminado por Tailscale y reenviado a
`127.0.0.1`), el ancho de banda que deja Funnel, y la calidad de voz por TCP con pérdidas. Hace falta una
llamada real con alguien que no conecte directo.

## H11. App Android y pantalla desde el móvil

**Problema:** el WebView de Android no tiene `getDisplayMedia` (tampoco Chrome para Android), y el CSP solo deja
`connect-src 'self'`, así que no vale un WebSocket local.

**Solución (`android/`, `web/src/android.ts`):** MediaProjection → `VirtualDisplay` → MediaCodec H.264
(SPS/PPS delante de cada clave) → `WebMessagePort` entregado solo al origen del servidor → `VideoDecoder` →
`MediaStreamTrackGenerator`. El audio de otras apps sale con `AudioPlaybackCapture` en PCM y llega como `AudioData`.
Para el mesh es una pista más: no cambian ni la señalización ni el cifrado. Sin generador se usa lienzo +
`captureStream`, sin audio.

**Medido (2026-11-02, emulador Android 15 con WebView 124 ↔ Chrome de escritorio, `android.e2e.mjs`):**
- Las dos pistas salen de `MediaStreamTrackGenerator`. 1080×2400 se limita a 864×1920 con el lado largo a 1920
  (por defecto en la app: 1080p, 30 fps, 4 Mbps).
- En el móvil se decodifican 17–20 fps. A Chrome llegan 864×1920 a 11–14 fps con la pantalla quieta (se repite el
  último fotograma cada 100 ms) y un RTT de 7 ms.
- Al girar, Chrome pasa a 1920×864 sin renegociar, y en el móvil se sigue decodificando a ~20 fps.
- `removeSource` libera la MediaProjection y el servicio vuelve a ser solo de micrófono (`types=0x80`).
  "Dejar de emitir" en la notificación pone la emisión en pausa, como H7, y `reanudar` vuelve a pedir permiso.

**Errores encontrados por el camino:**
- `Bridge.detach()` diferido con `Handler.post` cerraba el puerto nuevo que `attach()` acababa de crear.
  La página no recibía nada y el diálogo de captura no salía. Ahora es síncrono.
- Git Bash reescribe `/sdcard/...` en los argumentos de adb: usar `MSYS_NO_PATHCONV=1`.
- `page.click` de puppeteer no acierta en el WebView por CDP. Los E2E pulsan con `element.click()`.
- El emulador (3 GB) más 6 Chrome hacen que falle `mesh.e2e.mjs` por tiempo, y Gradle muere sin memoria.
  Se ejecutan por separado.
- El emulador (`-gpu auto`, Android 15) se congeló dos veces en la misma sesión: adb seguía viéndolo como
  `device`, pero `shell` y `screencap` no respondían. La primera vez fue tras girar varias veces con la captura
  activa. La causa no está medida. Si pasa, matar `qemu-system-x86_64` y arrancar en frío; el E2E ya tiene un tope
  de 60 s por llamada a adb para no quedarse colgado. Tras un cuelgue en horizontal, el diálogo de captura llegó a
  tardar 35 s en dibujarse.

**Sin medir:**
- Móvil real con códec por hardware.
- La caída a 3–4 fps en Chrome justo después de girar. En el emulador WebRTC codifica por software; no se sabe
  si en un móvil real se recupera antes.
- Audio de sistema con algo sonando.
- Android 10 (el `minSdk`) y WebView antiguos sin `WEB_MESSAGE_ARRAY_BUFFER`, que usan el camino en base64.
- Batería y temperatura con emisión larga.

## H12. Dictado, imágenes y archivo local bajo el CSP

**Medido (2026-11-05, Chrome y Firefox de Windows, `e2e/extras.e2e.mjs` y `firefox.e2e.mjs`):**
- Whisper base q8 en WASM de un hilo transcribe la frase de la voz Helena de Windows tal cual
  («Hola a todos.», «Esto es una prueba del dictado.»), en unos 10 s con el modelo ya en caché.
- Firefox carga el modelo y llega a `escuchando`; el archivo SQLite queda en OPFS (`persistent: true`).
- Imágenes de ida y vuelta Chrome ↔ Firefox; una cabecera PNG con SVG dentro se descarta.

**Trampas encontradas:**
- **transformers.js apunta el runtime a jsDelivr** si no se le da ruta. `stt.worker.ts` pone `wasmPaths`
  a `undefined` para que ONNX use el `.wasm` que Vite deja junto al worker (`import.meta.url`); el CSP
  (`connect-src 'self'`) cortaría la descarga de todos modos.
- **En Firefox transformers.js convierte el runtime en `blob:`** para cachearlo, y el CSP no deja importarlo:
  `env.useWasmCache = false`.
- **Vite metía el worklet como `data:`** (menos de 4 KB): `addModule` fallaba con «script de otro origen: null».
  `assetsInlineLimit` lo excluye en `vite.config.ts`.
- **Trusted Types**: `new Worker` y `audioWorklet.addModule` solo aceptan URLs del propio origen pasadas por
  `scriptURL` (`tt.ts`).
- **WriteTimeout de 30 s** cortaría el modelo por un túnel lento: `/stt/` tiene 15 min. Los estáticos llevan
  ETag, así que con `no-cache` se revalida sin volver a bajar.
- **Sin aislamiento entre orígenes** no hay `SharedArrayBuffer`: ONNX va en un hilo y SQLite usa `opfs-sahpool`
  (el VFS `opfs` normal lo necesita).
- **Headless no tiene voces** de síntesis: el E2E de TTS sustituye `speechSynthesis` y comprueba qué se leería.

**Hipótesis sin medir:** el WebView de Android no tiene `speechSynthesis` (la UI lo dice y deja mandar 🔊) y
Whisper puede ir justo de memoria en móviles modestos.

## Prueba manual Windows ↔ Kali (WSL2)

WSL en NAT: `localhost` de Kali **no** llega a Windows. Usar la IP del host (`ip route`, puerta de
enlace; aquí `172.27.32.1`, puede cambiar). Por HTTP esa IP no es contexto seguro, y sin el flag
fallan micro, cámara y `crypto.randomUUID` (chat).

```powershell
# Windows
./build.ps1; ./cryptopo-server.exe -new-key   # guardar la clave en clave.txt
./cryptopo-server.exe -addr :8080 -insecure-http -password-file clave.txt   # abrir http://localhost:8080
```

```bash
# Kali
sudo apt install -y chromium
chromium \
  --unsafely-treat-insecure-origin-as-secure=http://172.27.32.1:8080 \
  --user-data-dir=/tmp/cryptopo-kali \
  --use-fake-ui-for-media-stream \
  http://172.27.32.1:8080
```

Añadir `--use-fake-device-for-media-stream` si Kali no tiene micro o cámara (pita, ver H6).

En Windows usar Chrome: Firefox no conecta con Kali en esta topología (H3).

**Aviso:** `-addr :8080 -insecure-http` escucha en todas las interfaces por HTTP. Por HTTP sin ese flag
de Chromium, el navegador no ofrece `crypto.subtle` y la app muestra el aviso de que no puede cifrar.

## Depurar una sesión real

En consola de cada navegador (Chrome pide escribir `allow pasting`; pegar en una sola línea para
evitar `SyntaxError`):

```js
JSON.stringify([...cryptopo.peers.values()].map(p => ({ name: p.name, ready: p.ready, conn: p.pc.connectionState, sig: p.pc.signalingState, kinds: p.kinds, senders: [...p.senders.keys()], streams: [...p.streams.values()].map(s => [s.id, s.getTracks().map(t => t.kind + ':' + t.readyState + ':' + t.muted)]), tx: p.pc.getTransceivers().map(t => `${t.mid} ${t.receiver.track.kind} ${t.direction}/${t.currentDirection}`) })), null, 1)
```

| Observación | Significado |
|---|---|
| `name` debe ser el **otro** usuario | Si coincide en ambos volcados, se pegó dos veces el mismo |
| `sig: have-local-offer` que no cambia | H1: el otro rechazó la oferta; buscar error rojo allí |
| `kinds` con `screen`, `streams` sin ella | Metadatos llegan, media no se negoció |
| Pista `muted: true` | Negociada, pero no llegan o no se decodifican paquetes |
| `conn: failed` o `connecting` que no cambia | ICE: red, firewall o TURN |

## Qué cubren los tests y qué no

```powershell
go test .              # señalización (necesita web/dist compilado por go:embed)
cd web; npm test       # mungeRemoteSdp
cd web; npm run test:e2e   # dos Chrome headless reales con dispositivos falsos
cd web; npm run test:e2e:firefox   # Firefox + Chrome headless, ofertas cruzadas
cd web; npm run test:e2e:android  # app en emulador ↔ Chrome; requiere adb y el APK de depuración
```

**Cubierto:** perfil en plena sala (nombre y avatar, también desde Firefox), avatares hostiles descartados,
borrar salas, mezcla (fader, mute, solo, guardado por dispositivo) y micro por la ganancia de envío con
energía recibida al otro lado, en Chrome y desde Firefox. Conexión, chat y historial, UI real con micro en silencio, pantalla (también con
audio), cortar y reanudar, glare de micros, llegada tardía, salida, ICE vacío, síntoma de H1. Seguridad:
ver [SEGURIDAD.md](SEGURIDAD.md).

Imágenes (recodificación, reensamblado, formato falso), mensajes 🔊 y lectura del chat, dictado real con la voz de
Windows como micro falso, y archivo SQLite (guardar, recargar en la sala) en `extras.e2e.mjs`; Firefox, en
`firefox.e2e.mjs`. VAD y reensamblado de imágenes, en `npm test`.

**No cubierto:**
- Dictado y archivo local en Safari y en el WebView de Android; voces de síntesis reales (headless no tiene).
- Safari y otros navegadores. Firefox solo con ofertas cruzadas de micro y pantalla.
- Captura de pantalla real, 4K, codecs por hardware y su carga: la pantalla es falsa.
- Máquinas o NAT distintos (solo la prueba manual de H8), TURN por Funnel (H10) y más de 2 peers.
- Emisión de vídeo local (`captureStream`).
- App Android en un móvil real: `test:e2e:android` usa el emulador (H11).

**Medir audio recibido en Chrome:** `totalAudioEnergy` de `inbound-rtp` se queda en 0 si nada reproduce la
pista, aunque lleguen paquetes. El receptor tiene que entrar por la UI para que `Stage` monte el `<audio>`.

**Detalles del montaje:**
- E2E usa el puerto `18080` y la sala `general` en el test de UI, con servidor propio.
- `web/dist` lo reconstruye `test:e2e`; `go test` usa el que haya.
- `--experimental-strip-types` no admite las parameter properties de `mesh.ts`, por eso `Mesh` solo
  se prueba en E2E.
