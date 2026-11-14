# Seguridad de cryptopo

Revisión del 2026-11-02. Sin auditoría externa: el cifrado usa primitivas estándar del navegador, pero
el protocolo que las combina es propio y solo lo han probado los tests de este repositorio.

## Qué protege y qué no

| Quién ataca | Audio, vídeo, chat | Metadatos |
|---|---|---|
| Alguien en la red, Wi-Fi, operador | Protegido | Ve IPs y que hay tráfico |
| Servidor de señalización **con `-join`** | Protegido: ni lee ni se puede meter en medio | Ve nombres, salas, IPs y horas |
| Servidor o túnel **sin `-join`** | Protegido si es pasivo. **No si es activo**: sirve la página y puede cambiarla | Ve lo mismo |
| Servidor TURN | Protegido: solo ve paquetes cifrados | Ve IPs y volumen |
| Quien tenga la clave de sala | **Entra.** Quien entra oye a la sala | Ve quién está |
| Quien tenga un enlace de invitación (`#i=`) | **Entra una vez**, si llega antes que el invitado y antes de 24 h. Después el enlace no vale | Ve quién está |
| Miembro con la clave + servidor, intentando interceptar | Lo delata el código de seguridad **si lo comparáis** | |
| Otro participante | No puede suplantar ni tirar a los demás | **Ve tu IP**, salvo con `-relay-only` |
| Malware en tu equipo o extensión con acceso a la página | **Sin protección** | **Sin protección** |

**No es Signal.** Sirve para que un grupo de confianza hable sin que terceros ni la infraestructura lo
escuchen. No está pensado para quien tenga un adversario estatal: no oculta quién habla con quién, los
binarios no están firmados y no ha tenido auditoría.

## Cómo usarlo de forma segura

1. **Invita con «Copiar invitación» o «WhatsApp» del panel**, o con `-invite https://host` en la consola. El enlace
   vale una vez y 24 horas, y no contiene la clave de sala. Reparte cada enlace a una sola persona, por un canal
   privado. Si lo abre otro antes, el invitado verá «caducó o ya se usó» y sabrás que se filtró. La clave de sala
   (`#k=`) sigue existiendo, pero ya no hace falta repartirla.
2. **Comparad el código de seguridad** una vez con cada persona, por teléfono o en persona, y marcadlo
   como verificado. Sin este paso, un miembro de acuerdo con el servidor podría interceptar sin que se note.
3. **Si no te fías del servidor, usa `-join`:** la interfaz sale de tu binario, no de él.
   `cryptopo-server.exe -join https://servidor/` y abre `http://127.0.0.1:8091`.
4. **Pasa los binarios con su huella.** `build.ps1` genera `SHA256SUMS.txt`: envíalo por un canal distinto.
5. **Haz caso de los avisos** `⚠ CLAVE CAMBIADA`, `✗ identidad falsa` y `✗ clave distinta`. Un dispositivo
   nuevo da el primero de forma legítima: confírmalo por otro medio antes de verificar.
6. **Para ocultar tu IP a los demás**, `-turn ... -relay-only` con un TURN propio.
7. **Un túnel de terceros termina el TLS en su infraestructura** (Cloudflare, ngrok): puede modificar la
   página. Con Tailscale Funnel, el TLS termina en tu máquina.

## Diseño

```
clave de sala ── PBKDF2-SHA256, 600k ──▶ maestro (no extraíble, en IndexedDB)
                                           ├─ HKDF "auth"   ▶ verificador: lo único que conoce el servidor
                                           └─ HKDF "signal" ▶ AES-256-GCM de los SDP e ICE
```

- **Entrada al servidor:** reto y respuesta `HMAC(verificador, nonce)`. La clave no viaja, y una respuesta
  capturada no sirve para otra conexión. Con `-new-key` y `-verifier` el servidor no llega a conocer la clave.
- **Señalización:** cada mensaje va sellado con sala, emisor, receptor y secuencia como datos adicionales.
  El servidor no puede leerlo, alterarlo, redirigirlo, devolverlo ni repetirlo. Como el SDP lleva la huella
  DTLS, tampoco puede meterse en medio de la conexión WebRTC.
- **Media y chat:** DTLS-SRTP y SCTP de WebRTC, con secreto hacia delante: filtrar la clave de sala más tarde
  no descifra lo ya grabado.
- **Identidad:** par ECDSA P-256 no extraíble por dispositivo. Al abrir el canal, firma nombre, sala y las
  dos huellas DTLS. Una firma que no cuadra cierra la conexión, y hasta verificarla no sale ni entra nada por el
  canal. El código de seguridad son 30 dígitos derivados de las dos claves públicas.
- **Invitación de un solo uso (`invite.go`, `openInvite` en `e2e.ts`):** el enlace es `/#i=<id>.<k>`, con `id` de
  16 bytes y `k` de 32, ambos aleatorios. El anfitrión sella la clave de sala con AES-256-GCM bajo `k` (datos
  adicionales: el `id`) y deja el sobre en el servidor, en memoria, 24 horas como máximo y 20 a la vez. El
  invitado manda `redeem` con el `id`; el servidor entrega el sobre **una vez** y lo borra, y el navegador lo
  abre con `k`, que nunca sale del enlace. Cambiar la clave de sala invalida las pendientes. Un canje fallido
  paga el mismo retraso que una clave errónea y se registra como `invite-failed`; tres por conexión. Vector
  común en `invite_token_test.go` y `web/test/e2e.test.mjs`; flujo real en `e2e/invite.e2e.mjs`.
  **Límite:** el servidor que sella no es ciego. Solo el anfitrión con la clave en claro (panel o `-invite`)
  puede emitirlas; con `-verifier` no hay invitaciones. Y quien canjea ya se queda con la clave de sala en ese
  navegador: la invitación evita que el *enlace* sea una clave permanente, no revoca a quien ya entró.
- **Sin rebaja:** el cliente no envía señalización sin clave, aunque el servidor no pida autenticación.
- **TURN integrado (`turn_builtin.go`):** las credenciales solo se dan tras autenticarse con la clave de sala,
  y caducan a las 12 h. Cada asignación retransmite desde un puerto UDP en `127.0.0.1` y solo intercambia
  datagramas con otras asignaciones del mismo servidor. No sirve para llegar a otros servicios de la máquina
  ni para mandar tráfico a terceros (`TestBuiltinTURNCannotReachOtherServices`). Hay un máximo de 120
  asignaciones. Tailscale termina el TLS de 8443 y solo ve SRTP/DTLS cifrado.
- **App Android (`android/`):** es un WebView que carga la web del servidor elegido; cripto, señalización y media
  son los mismos de la web. Lo nuevo:
  - **Un solo origen.** Solo se guarda el origen, nunca la clave (la guarda la web, como en el navegador). La
    navegación a otros orígenes se abre fuera de la app, y los permisos de micro y cámara se dan solo a ese origen.
    Acepta HTTPS, y HTTP únicamente hacia `localhost`/`127.0.0.1` para pruebas con `adb reverse` (`Invite.kt`,
    `network_security_config.xml`). Prueba: `InviteTest`.
  - **Puente sin `JavascriptInterface`.** Va por un `WebMessagePort` que se entrega con `postWebMessage` y
    `targetOrigin` = el servidor: si la página es otra, el sistema no lo entrega. Por él solo pasan la orden de emitir
    o cortar y los fotogramas. La captura exige además el diálogo del sistema cada vez.
  - **Audio capturado:** excluye el propio UID, para no reenviar las voces de la sala. Las apps que prohíben la
    captura (`allowAudioPlaybackCapture=false`) no suenan.
  - **APK de release:** firmado con la clave de depuración hasta tener keystore propio. Antes de repartirlo fuera
    del grupo, crear una clave y publicar su huella junto a `SHA256SUMS.txt`.
- **TURN propio del panel (`turn.json`):** `secret` y `pass` se escriben a mano en claro y, al leerlos, se
  sustituyen por `protectedSecret`/`protectedPass` con DPAPI, igual que la clave. Nada de esto, ni los logs, va
  dentro del exe: `TestEmbedded*` y `build.ps1` lo comprueban.

## Qué se encontró y cómo quedó

| # | Grav. | Hallazgo | Estado |
|---|---|---|---|
| 1 | Crítica | El servidor reenviaba las huellas DTLS en claro: podía interceptar todo, pese a que la app decía que "solo os presenta" | Señalización E2E y firma de identidad |
| 2 | Crítica | El servidor sirve el código que maneja las claves | Mitigado con `-join`; sin él sigue siendo un límite |
| 3 | Alta | Sin contraseña por defecto, y `-addr :8080` abierto a la red por HTTP | Clave obligatoria (16+), `127.0.0.1` por defecto, TLS exigido fuera de local |
| 4 | Alta | Cualquier miembro podía publicar mensajes como otro, incluso como tuyos, mediante `history` y `name` | El autor lo fija la conexión; el historial queda marcado `[vía X]` |
| 5 | Alta | Contraseña en claro en `localStorage` y enviada al servidor | Maestro no extraíble, reto y respuesta, y se borra la antigua |
| 6 | Alta | Contraseña en claro en `settings.json` | DPAPI, con migración automática |
| 7 | Alta | 20 CVE alcanzables en la stdlib de Go 1.26.1 | Go 1.27.3 y dependencias al día; `govulncheck` limpio |
| 8 | Alta | SQLite con IP, nombre, sala y horas, activa por defecto y sin caducidad | Activa y sin caducidad por decisión del dueño: contiene IPs, no la compartas. `-db ""` la apaga y `-retention` la caduca con borrado seguro; botón de borrar en el panel |
| 9 | Media | Entrar en una sala abría el micro a todos | Se entra en silencio |
| 10 | Media | Quien entraba recibía 200 mensajes anteriores sin que nadie lo decidiera | Desactivado por defecto; cada uno lo activa |
| 11 | Media | Sin CSP ni cabeceras | CSP estricto con Trusted Types, y COOP, CORP, nosniff, Referrer y Permissions-Policy |
| 12 | Media | Google Fonts: cada visita avisaba a Google | Fuentes en el binario |
| 13 | Media | Sin timeouts HTTP ni límite de conexiones o mensajes | Timeouts; límites de 8 sin autenticar por IP, 64 clientes, 6 por sala, 256 KiB y cubo de mensajes |
| 14 | Media | `X-Forwarded-For` falsificable en los logs | Solo se cree desde un proxy local, y el último valor |
| 15 | Media | Un peer podía inundar con mensajes, metadatos o reinicios | Validación de todo lo recibido y límites por peer |
| 16 | Media | Nombres con bidi o anchura cero imitaban a otros; nombres duplicados sin aviso | Se limpian en servidor y cliente; aviso de nombre repetido y de clave cambiada |
| 17 | Baja | Ping que ignoraba errores: conexiones muertas seguían en la sala; además bloqueaba los envíos | Goroutine propia, cierra si no hay pong |
| 18 | Baja | Cambio de contraseña con carrera entre comprobar y admitir | Misma sección crítica |
| 19 | Baja | `OpenURL` del panel validaba sin anclar | Regex anclada |
| 20 | Baja | Credenciales TURN fijas compartidas | `-turn-secret`: temporales, por cliente |
| 21 | Baja | Binarios con rutas locales, sin huellas | `-trimpath` y `SHA256SUMS.txt` |

**Perfil y salas (2026-11-02):** el avatar va solo por el DataChannel, de un peer ya demostrado; se acepta
imagen PNG, JPEG o WebP en `data:` de hasta 48 000 caracteres, o un glifo de 2 caracteres, y nada más (ni SVG
ni otros esquemas). El nombre nuevo pasa por `safeName` y por la libreta de confianza: renombrarse como alguien
ya visto con otra clave da `⚠ CLAVE CAMBIADA`. Al servidor llegan `rename` (para la lista de salas, como ya
veía el nombre) y `delete-room`, que solo borra salas creadas y sin nadie más dentro: no sirve para echar a
nadie. Ambos son mensajes al servidor, no entre peers, y van sin sellar como `join`.

**Imágenes, voz y archivo local (2026-11-05):**
- **Imágenes:** van por el DataChannel, solo entre peers demostrados: una cabecera (`img`) y trozos base64 en orden
  (`imgc`), máx. 2 MB y dos a medias por peer. Quien envía repinta la imagen y la recodifica (WebP o JPEG): se
  pierden EXIF y GPS. Quien recibe exige el formato por los primeros bytes (PNG, JPEG o WebP, nunca SVG), la
  decodifica antes de enseñarla y la muestra como `blob:` local. Los trozos no gastan el cubo de mensajes, sino uno
  de bytes (8 M de capacidad, 2 M/s), y el emisor se frena para no pasarse. Prueba: `extras.e2e.mjs` y `images.test.mjs`.
- **Dictado:** Whisper corre en el navegador de quien habla; el audio no sale de ahí y a la sala solo llega el texto,
  como un mensaje más, con el autor fijado por la conexión. El modelo es una revisión fija de Hugging Face que
  `web/scripts/stt-assets.mjs` comprueba por SHA-256 al compilar; en uso lo sirve el binario y nadie más se entera.
- **Texto a voz:** solo voces con `localService`. Las «Google …» de Chrome leen en servidores de Google.
- **Archivo local:** SQLite en el OPFS del navegador, por origen. Ni el servidor ni los demás lo ven, pero **sí
  quien tenga acceso a ese perfil del navegador**: guarda en claro lo dicho, las imágenes y las transcripciones,
  sin caducidad. Se apaga o se borra en `voz/archivo`. El historial que se pasa a quien llega sigue siendo solo
  texto de la sesión: ni imágenes ni lo sacado del archivo.
- **CSP:** se añaden `'wasm-unsafe-eval'` (compilar WebAssembly, no `eval` de JS) y `blob:` en `img-src`. Workers y
  worklet solo se crean con URLs del propio origen pasadas por Trusted Types (`tt.ts`).

Revisado sin problema: XSS (React escapa, sin `innerHTML`), inyección SQL (consultas parametrizadas), secretos en
el historial de git (ninguno; las `.db` y los `.exe` están ignorados), `npm audit` (0).

## Límites conocidos

- **Página servida por el servidor:** sin `-join`, un servidor o túnel activo puede cambiar el código.
- **Metadatos:** el servidor ve nombres visibles, salas, IPs y horas. Cifrarlos rompería la lista de salas tal como está.
- **STUN:** por defecto usa los de Google, que ven tu IP pública. Se cambia con `-stun`, y se evita con `-relay-only`.
- **Clave de grupo:** expulsar a alguien exige cambiar la clave y repartirla. Quien la tuvo puede volver a entrar hasta entonces.
- **Historial reenviado:** va sin firma por mensaje, por eso se marca como `[vía X]`. El emisor podría inventarlo.
- **Medio antes de la firma:** las pistas se negocian antes de terminar la comprobación, unos milisegundos. Una firma falsa corta la conexión.
- **Binarios sin firmar:** SmartScreen avisará. Firmar requiere un certificado de pago, y no se ha hecho.

## Comprobaciones

```powershell
go test .                                              # señalización, límites, cabeceras, -join
go test -tags desktop,production -run 'Settings|OpenURL' .   # guardado cifrado del panel
cd web; npm test                                       # criptografía y vector común con Go
cd web; npm run test:e2e                               # incluye security.e2e.mjs: ataques en Chrome real
cd web; npm run test:e2e:firefox
cd web; npm run test:e2e:docker                        # coturn real + WebKit y Chromium de Linux, solo por relay
cd android; ./gradlew testDebugUnitTest lintDebug       # parser de invitaciones y lint
cd web; npm run test:e2e:android                       # app en emulador ↔ Chrome, pantalla por el puente
govulncheck .; govulncheck -tags desktop,production .
```

**Probado el 2026-11-02:**

- **Sala llena:** 6 Chrome (`mesh.e2e.mjs`): los 15 pares conectan con identidad y códigos simétricos y distintos, el
  chat llega con su autor, y la séptima persona no entra.
- **TURN:** contra coturn 4.18 con `use-auth-secret` y `-relay-only`. El par elegido es relay-relay en ambos lados,
  no se ofrece ningún candidato propio, y el vídeo se decodifica en los dos sentidos.
- **Motor de Safari:** WebKit 26.6 de Linux ↔ Chromium, dentro de esa misma prueba. El WebKit de Playwright para
  Windows no trae WebRTC: ahí la app avisa de que no puede conectar.
- **Panel en pantalla** (instancia aislada, manejada con UI Automation): genera y cifra la clave con DPAPI,
  arranca y para el servidor, y registra los logs.
- **`Entrar a la llamada`:** `ShellExecute` entrega el `#k=` intacto al navegador por defecto, y el servidor solo
  ve `/`. La clave se codifica con `inviteFragment`, porque Wails no abre URLs con `~ ! ( ) *` y `+` llegaba como `+`.

**Sin probar:** el Funnel embebido del panel (`tsnet`) y `-join` por internet real (exige iniciar sesión en Tailscale y publicar el
equipo), Safari real de macOS/iOS (la pila de media de Apple no es la de WebKit para Linux), y TURN con NAT reales.
