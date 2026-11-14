# cryptopo

Discord en navegador, malla WebRTC P2P (2–6 personas). Binario Go solo de señalización que embebe
el frontend Vite/React de `web/`. No añadir SFU ni servicios de terceros sin preguntar.

**Leer `docs/HALLAZGOS.md` antes de depurar conexión o media**: errores conocidos, qué está
medido y qué es hipótesis, guía de prueba Windows ↔ WSL y volcado de diagnóstico.

**Leer `docs/SEGURIDAD.md` antes de tocar autenticación, señalización o lo que se registra.** Cualquier
mensaje nuevo que pase por el servidor va sellado (`seal`/`open` en `web/src/e2e.ts`); la derivación debe
coincidir con `crypto.go` (vector común en `auth_test.go` y `web/test/e2e.test.mjs`).

## Comandos

```powershell
./build.ps1                # frontend + cryptopo.exe (panel Wails) + cryptopo-server.exe (consola) + cryptopo.apk si hay Android Studio
go test .                  # señalización (requiere web/dist)
cd web; npm test           # unitarios de SDP y criptografía
cd web; npm run test:e2e   # dos Chrome reales, incluidos ataques; compila antes
cd web; npm run test:e2e:firefox   # Firefox + Chrome; compila antes
cd web; npm run test:e2e:docker    # coturn + WebKit/Chromium de Linux por relay; requiere Docker
cd android; ./gradlew assembleDebug testDebugUnitTest   # APK (JAVA_HOME = jbr de Android Studio)
cd web; npm run test:e2e:android   # emulador + Chrome; requiere adb, el APK y `npm run build` antes
```

## A tener en cuenta

- El binario embebe `web/dist` al compilar; para iterar usar `-static web/dist`.
- El servidor exige clave de 16+ caracteres incluso en local: `CRYPTOPO_PASSWORD` o `-password`. El E2E entra
  con `/#k=<clave>`, y hay que esperar a `myId && auth === 'ok'` antes de recargar. `auth` vale `'ok'` desde el
  principio, y `myId` solo se fija cuando la clave ya está guardada.
- La consola registra en `cryptopo.db` por defecto y sin caducidad, por decisión del dueño. Los E2E usan `-db ""`.
- El WebKit de Playwright para Windows no tiene WebRTC: Safari se prueba con `test:e2e:docker`.
- El panel vive en `frontend/`; no renombrarlo: ver H9 en `docs/HALLAZGOS.md`.
- `panel.go` solo compila con los tags de Wails (`desktop`, `bindings`, `dev`). `go build`, `go test` y
  los E2E usan `panel_stub.go`. El Funnel del panel es Tailscale embebido (`tsnet`,
  `runFunnel`), sin la CLI. Solo se ha compilado: falta probarlo con una cuenta real.
- `window.cryptopo` expone el `Mesh`, incluidos campos privados como `peers`; `window.cryptopoVoice`, el dictado y la síntesis.
- Antes se llamaba newchord. Los literales `newchord-*` de `e2e.ts`/`crypto.go`/`invite.go`, la IndexedDB
  `newchord-keys` y las claves `newchord.*` de `localStorage` **no se renombran**: cambiarlos invalida claves,
  identidades y códigos de seguridad guardados.
- `npm run build` baja el modelo del dictado a `web/public/stt/` (SHA-256 fijo en `web/scripts/stt-assets.mjs`).
  Imágenes, TTS, dictado y archivo SQLite del navegador: `e2e/extras.e2e.mjs` (H12 en `docs/HALLAZGOS.md`).
- Cualquier E2E que necesite ver fichas debe entrar por la UI: `Stage` solo se monta con nombre
  guardado.
- Sprites en `assets/` (raíz), compartidos por web y panel: se referencian desde CSS con `../../assets/...`
  (`server.fs.allow: ['..']` en ambos `vite.config.ts`). `assets/originales/` guarda lo recibido sin limpiar.
- Probar siempre con el navegador real implicado: un fallo de Firefox no se reproduce con Chrome.
- App Android en `android/`: WebView + puente nativo de pantalla (H11 en `docs/HALLAZGOS.md`). El WebView no tiene
  `getDisplayMedia`: la pantalla entra por `web/src/android.ts`. `media.ts` no puede importar `android.ts`, porque
  `npm test` lo carga en node; la elección se hace en `Controls`/`App`.
- No correr `test:e2e:android` a la vez que la malla de 6 ni que Gradle: no hay memoria para todo (H11).
