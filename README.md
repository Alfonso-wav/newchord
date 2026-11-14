# Cryptopo

Antes se llamaba newchord. Si no hay `%APPDATA%\cryptopo` ni `cryptopo.db`, el panel y la consola siguen usando
`%APPDATA%
ewchord` y `newchord.db` donde están, sin moverlos; las variables `NEWCHORD_*` valen si no hay `CRYPTOPO_*`. La derivación de
claves no cambia: claves guardadas, identidades y códigos de seguridad siguen igual.

Discord en el navegador, P2P. Voz, cámara, compartir pantalla a resolución nativa
y retransmitir vídeos locales, con chat de texto por salas.

- **Media 100% P2P** (WebRTC en malla): el servidor solo presenta a los peers.
- **Cifrado de extremo a extremo**, con la señalización incluida, y códigos de seguridad para
  comprobar que no hay nadie en medio. Modelo de amenazas y límites en [docs/SEGURIDAD.md](docs/SEGURIDAD.md).
- **Pantalla**: resolución nativa/4K/1440p, 15–144 fps, codec elegible (AV1/VP9/H264/…),
  bitrate hasta 80 Mbps, modo nitidez (texto) o fluidez (juegos/vídeo), audio de sistema.
- **Vídeo local**: abre un mp4/webm/mkv y lo emites; play/pausa/seek mandan para todos.
- **Chat** por DataChannel. Quien llega no ve lo anterior, salvo que alguien active `pasar historial`.
- **Imágenes** en el chat: botón `img`, pegar o arrastrar. Se recodifican antes de salir (WebP o JPEG, máx.
  2048 px y 2 MB, sin EXIF ni GPS) y van en trozos por el mismo canal cifrado.
- **Voz a texto (dictado)**: Whisper base corre en tu navegador sobre tu micro; a la sala solo va el texto
  (🎙). El modelo (~77 MB) lo sirve el propio binario y se baja una vez. Español, inglés, catalán o detección.
- **Texto a voz**: `/decir hola` o el botón 🔊 manda un mensaje que la sala oye leído; cada uno puede además
  leer el chat o las transcripciones de los demás. Solo voces locales del sistema (las de red mandarían el texto fuera).
- **Archivo local**: chat, imágenes y transcripciones se guardan en SQLite (WASM, OPFS) **en tu navegador**,
  nunca en el servidor. Al volver a la sala reaparecen; `voz/archivo` permite exportar el `.sqlite3`, borrar una
  sala o todo, y apagarlo.
- Stats en vivo en cada ficha (resolución, fps, Mbps, codec, encoder HW/SW, limitación).

## Ejecutar

```powershell
./build.ps1     # necesita Go, Node y la CLI de Wails
```

Genera dos binarios con el mismo código:

- **`cryptopo.exe`: panel de escritorio.** Doble clic, pulsa `Arrancar server` y `Abrir al exterior`,
  y pasa la invitación, que es un enlace con la clave. Quien la recibe solo necesita Chrome. La clave
  se genera sola; en Settings se puede cambiar. El server escucha únicamente en `127.0.0.1` y, al
  cerrar la ventana, se cierran server y Funnel. Ajustes y base están en `%APPDATA%\cryptopo`, con la
  clave cifrada para tu cuenta de Windows.
  El exe lleva Tailscale dentro (`tsnet`), así que no hay que instalar nada. La primera vez,
  `Abrir al exterior` pide iniciar sesión con una cuenta gratuita de Tailscale y aprobar HTTPS y Funnel.
  El equipo queda como `cryptopo` en esa tailnet, con URL fija `https://cryptopo.<tailnet>.ts.net`, y su
  estado se guarda en `%APPDATA%\cryptopo\tailscale`. No sube logs a Tailscale.
- **`cryptopo-server.exe`: consola, sin panel.** Ver [Servidor en consola](#servidor-en-consola).

También deja `SHA256SUMS.txt`, para que quien reciba los binarios compruebe que son los tuyos.

Para desarrollo con recarga en caliente:

```powershell
$env:CRYPTOPO_PASSWORD = 'una-clave-de-desarrollo-larga'
./cryptopo-server.exe -origins localhost:5173   # señalización en 127.0.0.1:8080
cd web; npm run dev                             # Vite en :5173, proxy de /ws a :8080
```

`-static web/dist` sirve el frontend desde disco en vez del embebido.

## Servidor en consola

```powershell
./cryptopo-server.exe -new-key                  # da la clave de sala y su verificador
$env:CRYPTOPO_VERIFIER = '<verificador>'
./cryptopo-server.exe                           # escucha en 127.0.0.1:8080
```

Para invitar sin repartir la clave, arranca con `-invite https://tu-host` (necesita `-password`,
`-password-file` o `CRYPTOPO_PASSWORD`, no `-verifier`): imprime un enlace `#i=…` que vale una vez y 24 horas.
En el panel, «Copiar invitación» lo copia y «WhatsApp» abre WhatsApp con el mensaje escrito: se pulsa el enlace y entra.
Con la clave, también vale `https://tu-host/#k=<clave>`, permanente. El navegador no envía lo que va tras el `#`, y lo borra de la
barra al abrirlo. Con el verificador, el servidor no llega a conocer la clave. También se puede
arrancar con `-password-file clave.txt` o `CRYPTOPO_PASSWORD`. Se niega a arrancar sin clave, con
menos de 16 caracteres, o sin TLS en una dirección que no sea local (`-insecure-http` solo para pruebas).

**Sin fiarte del servidor:** `./cryptopo-server.exe -join https://tu-host/` sirve en
`http://127.0.0.1:8091` la interfaz de tu propio binario, y solo la señalización va al servidor remoto.
Es lo que impide que un servidor comprometido cambie el código que maneja las claves.

## Jugar con amigos

Cámara/micro/pantalla exigen **HTTPS** salvo en `localhost`. cryptopo no funciona sin ello, porque el
navegador solo permite cifrar en contexto seguro. Opciones:

- Túnel: `cloudflared tunnel --url http://localhost:8080` → URL https pública. Cloudflare termina el
  TLS y podría modificar la página: para más garantías, `-join` o Tailscale Funnel.
- Certificado propio: `./cryptopo-server.exe -addr :443 -cert cert.pem -key key.pem`.

Por defecto usa STUN de Google. Si alguien está tras NAT simétrico/CGNAT (móvil, algunas
fibras) no conectará sin TURN: monta coturn y pásalo con
`-turn turn:mi.host:3478 -turn-secret s` (`use-auth-secret` de coturn: credenciales temporales) o
`-turn-user u -turn-pass p`. Con TURN el media pasa por ese relay, que solo ve paquetes cifrados.
`-relay-only` fuerza todo por TURN, para que los participantes no vean la IP de los demás. Los STUN de
Google ven tu IP pública; `-stun` los cambia.

**TURN en el panel:** Settings → TURN tiene solo dos botones, y activar uno apaga el otro. Se aplica al
momento, a quien entre o reconecte.

- **TURN propio:** la primera vez que lo pulsas, crea `%APPDATA%\cryptopo\turn.json` y lo abre en el Bloc de
  notas. Rellena `urls` y `secret` (o `user` y `pass`), opcionalmente `relayOnly`, guarda y vuelve a pulsar. Al
  leerlo, el panel cifra `secret` y `pass` para tu cuenta de Windows y los quita del texto en claro; para
  cambiarlos, vuelve a escribir el campo. Si el fichero se rompe, el server arranca sin TURN y lo avisa.
- **TURN integrado:** arranca un TURN dentro del exe, sin configurar nada. Los
  invitados lo reciben como `turns:<equipo>.ts.net:8443`, por el mismo Funnel, y el navegador del anfitrión por
  `127.0.0.1`. Las credenciales caducan y el secreto se genera en cada arranque. Solo lo usa quien no consigue
  conectar directo. Limitaciones: va por TCP a través de Tailscale, así que con pérdidas la voz puede dar
  tirones, y todo lo retransmitido entra y sale por la conexión del anfitrión. Para compartir pantalla en alta
  resolución, mejor el propio. `-builtin-turn` hace lo mismo en consola, solo para navegadores de esa máquina
  (pruebas).

El exe solo lleva la web: `build.ps1` y `TestEmbedded*` fallan si en lo embebido aparece cualquier otra cosa
(logs, bases, ajustes, `turn.json`).

Flags: `-channels general,cine,…` (canales fijos; además cualquiera puede crear salas). Las salas
creadas siguen en la lista aunque se vacíen, hasta reiniciar el server o borrarlas desde la lista (papelera al
pasar el ratón), con un máximo de 50 recordadas. Solo se borra una sala creada y sin nadie más dentro.
Los nombres no distinguen mayúsculas. `-max-room` limita las personas por sala (6 por defecto).

**Clave de sala:** se exige antes de ver salas o recibir ICE. No viaja: el navegador responde a un reto
y guarda un derivado no extraíble. Los fallos quedan limitados a uno por segundo en todo el servidor,
cinco por conexión, y registrados como `auth-failed`. `olvidar` la borra del navegador. `-password` en la
línea de órdenes queda en el historial del shell y en la lista de procesos: mejor fichero o entorno.

## App Android

`android/` genera un APK que entra en cualquier servidor cryptopo, el del panel de Windows incluido. Además puede
**emitir la pantalla del móvil** con su audio, cosa que Chrome para Android no hace.

`./build.ps1` lo deja en la raíz como `cryptopo.apk` (~260 KB), junto a los exe y con su huella en
`SHA256SUMS.txt`. Solo hace falta Android Studio instalado; sin él, ese paso se salta con un aviso.

- **Entrar:** abre el enlace de invitación `https://…ts.net/#k=…` y elige cryptopo, o compártelo con la app desde
  WhatsApp/Telegram, o pégalo en la pantalla de inicio. La app recuerda el servidor, no la clave.
- **Emitir pantalla:** `./emitir --pantalla`, y Android pide permiso cada vez. Por defecto, 1080p a 30 fps y
  4 Mbps por persona, para que aguanten los datos móviles. Se ajusta en el mismo diálogo.
- **En segundo plano:** la llamada sigue, con una notificación fija. Desde ella se puede `Dejar de emitir`. Con
  `atrás` en la raíz se elige entre minimizar, cambiar de servidor o salir.
- Requiere Android 10 o superior, con Android System WebView actualizado. Cómo funciona por dentro: H11 en
  [docs/HALLAZGOS.md](docs/HALLAZGOS.md).

## Sesiones y logs

La consola registra en `cryptopo.db` (`-db ""` para no registrar nada). El panel usa su propia base en
`%APPDATA%\cryptopo`. Se conserva todo; con `-retention 168h` se borra lo más antiguo, con borrado seguro. El
panel tiene un botón para vaciarla. Contiene IPs: no la compartas. Dos instancias a la vez deben usar bases distintas: al arrancar, cada una
marca como `interrupted` las sesiones abiertas.

- `sessions`: quién entró en qué sala, desde qué IP y navegador, cuándo y por qué salió
  (`leave`, `switch`, `disconnect`, `server-stop`, `interrupted`).
- `events`: `connect`, `disconnect`, `ws-rejected`, `auth-failed`, `rename` (detalle: nombre anterior),
  `delete-room` y las líneas de `log`.

Contiene IPs y nombres. No guarda chat, que no pasa por el servidor, ni SDP. Tras un túnel, `ip` es
la del proxy local y la real está en `forwarded_for`, que solo se acepta desde un proxy en esta máquina.

```sql
SELECT joined_at, left_at, left_reason, name, room, forwarded_for
FROM sessions ORDER BY joined_at DESC LIMIT 50;
```

## Tests

```powershell
go test .                  # señalización (requiere web/dist compilado)
cd web; npm test           # unitarios de SDP y criptografía
cd web; npm run test:e2e   # dos Chrome headless reales con dispositivos falsos, y ataques
cd web; npm run test:e2e:firefox   # Firefox + Chrome headless
```

`npm run build` baja una vez el modelo del dictado a `web/public/stt/` (revisión fija de Hugging Face, cada
fichero comprobado por SHA-256 en `web/scripts/stt-assets.mjs`); después compila sin red. El exe crece ~105 MB.

Errores conocidos, cobertura y guía de prueba con WSL en [docs/HALLAZGOS.md](docs/HALLAZGOS.md).

## Límites de la malla P2P

Cada espectador recibe su propia copia codificada:

- **Subida del emisor** ≈ bitrate × espectadores. 4K60 a 25 Mbps con 4 viendo = 100 Mbps de subida.
- **Codificación**: Chrome codifica una vez por peer → 4K a varios peers carga GPU/CPU.
  Mira `encoderImplementation` en stats: si sale `libvpx`/`libaom` es software;
  H264 suele ir por hardware (NVENC/QuickSync/AMF).

Pensado para 2–6 personas. Más allá hace falta un SFU.

## Notas

- Mejor Chrome/Edge en todos los equipos (captureStream, audio de sistema, AV1 HW). Firefox funciona
  con Chromium, pero corta la captura al minimizar la ventana compartida y no conecta con una VM en
  NAT del mismo equipo: ver [docs/HALLAZGOS.md](docs/HALLAZGOS.md).
- Entrar a una sala abre el micro **en silencio**: se habla pulsando `M`.
- **Mezcla** (`X`): fader, mute y medidor por persona y por cada fuente suya (micro, pantalla, vídeo), solo
  por persona y master. Los de recepción solo bajan (el audio sigue saliendo por `<audio>` para no romper la
  cancelación de eco); el de tu micro va de −∞ a +12 dB y cambia lo que oyen los demás. Se guarda por
  dispositivo del otro, no por nombre.
- **Perfil**: clic en tu avatar, abajo a la izquierda. Nombre y avatar (imagen o símbolo) cambian en plena
  llamada sin reconectar. La imagen se reduce a 128×128 y va solo por el DataChannel.
- Audio de sistema completo solo en Windows/ChromeOS; en macOS, audio de pestaña.
- mkv se reproduce si el navegador soporta sus codecs (H264/VP9/AV1 + AAC/Opus); HEVC/DTS no.
- Quien tenga el enlace con la clave entra. Trátalo como una contraseña.
- Depuración: `window.cryptopo` en la consola (p.ej. `cryptopo.peerViews()`).
