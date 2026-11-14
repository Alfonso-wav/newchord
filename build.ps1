# Compila el frontend y genera cryptopo.exe (panel), cryptopo-server.exe (consola) y, si hay
# Android Studio, cryptopo.apk.
$ErrorActionPreference = 'Stop'
Push-Location web
npm ci
if ($LASTEXITCODE -ne 0) { throw 'npm ci falló' }
npm run build
if ($LASTEXITCODE -ne 0) { throw 'la compilación del frontend falló' }
Pop-Location
# go:embed exige que exista antes de que Wails genere los bindings.
New-Item -ItemType Directory -Force frontend/dist | Out-Null
if (-not (Test-Path frontend/dist/*)) { New-Item frontend/dist/.keep | Out-Null }
wails build -trimpath
if ($LASTEXITCODE -ne 0) { throw 'wails build falló' }
# Lo embebido es solo la web: logs, bases, ajustes o turn.json no deben viajar en el exe.
$web = '.html', '.js', '.css', '.ico', '.png', '.svg', '.woff', '.woff2', '.webmanifest', '.txt'
# Excepciones, cada una en su carpeta: el WebAssembly de SQLite y ONNX, y el modelo del dictado
# (web/scripts/stt-assets.mjs, comprobado por SHA-256). Un .json suelto podría ser un settings.json.
$dist = (Resolve-Path web/dist).Path
$leaks = Get-ChildItem -Recurse -File web/dist, frontend/dist |
  Where-Object {
    $ext = $_.Extension.ToLower()
    $rel = $_.FullName.Substring([Math]::Min($dist.Length + 1, $_.FullName.Length)).Replace('', '/')
    $ok = ($ext -in $web) -or ($_.Name -in '.keep', '.gitkeep') -or
      ($ext -eq '.wasm' -and $_.FullName.StartsWith($dist) -and $rel.StartsWith('assets/')) -or
      ($ext -in '.json', '.onnx' -and $_.FullName.StartsWith($dist) -and $rel.StartsWith('stt/models/'))
    -not $ok
  }
if ($leaks) { throw "el exe llevaría ficheros que no son la web: $($leaks.FullName -join ', ')" }
Copy-Item build/bin/cryptopo.exe cryptopo.exe -Force
if (-not (Test-Path web/dist/index.html)) { throw 'wails ha vaciado web/dist: el binario serviría una página equivocada' }
go build -trimpath -ldflags '-s -w -buildid=' -o cryptopo-server.exe .

# APK: usa el JDK y el SDK de Android Studio. Si no están, se salta y el resto del build vale igual.
$bins = @('cryptopo.exe', 'cryptopo-server.exe')
$jbr = 'C:\Program Files\Android\Android Studio\jbr'
$sdk = if ($env:ANDROID_HOME) { $env:ANDROID_HOME } else { Join-Path $env:LOCALAPPDATA 'Android\Sdk' }
if (-not $env:JAVA_HOME -and (Test-Path $jbr)) { $env:JAVA_HOME = $jbr }
if ($env:JAVA_HOME -and (Test-Path $sdk)) {
  $env:ANDROID_HOME = $sdk
  Push-Location android
  # Sin demonio: tras el build no queda un Java de 2 GB ocupando memoria.
  ./gradlew.bat --no-daemon -q assembleRelease
  $ok = $LASTEXITCODE -eq 0
  Pop-Location
  if (-not $ok) { throw 'gradle assembleRelease falló' }
  Copy-Item android/app/build/outputs/apk/release/app-release.apk cryptopo.apk -Force
  $bins += 'cryptopo.apk'
} else {
  Write-Warning 'Sin Android Studio (JDK o SDK): no se genera cryptopo.apk'
  # Uno viejo no debe parecer de este build ni entrar en las huellas.
  if (Test-Path cryptopo.apk) { Write-Warning 'cryptopo.apk es de un build anterior' }
}

# Quien reciba los binarios compara estas huellas por un canal distinto al de la descarga.
Get-FileHash $bins -Algorithm SHA256 |
  ForEach-Object { '{0}  {1}' -f $_.Hash.ToLower(), (Split-Path $_.Path -Leaf) } |
  Set-Content -Encoding ascii SHA256SUMS.txt
Get-Content SHA256SUMS.txt
Write-Host 'Listo: doble clic en cryptopo.exe (panel), o .\cryptopo-server.exe -new-key para empezar en consola'
