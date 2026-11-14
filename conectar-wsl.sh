#!/usr/bin/env bash
# Abre cryptopo desde WSL contra el servidor que corre en Windows.
# Uso: ./conectar-wsl.sh [--fake]
#   --fake  micro y cámara simulados, si WSL no tiene dispositivos (pita).
set -euo pipefail

PORT=8080

# En WSL con NAT, localhost no llega a Windows: la IP del host es la puerta de enlace.
HOST_IP=$(ip route show default | awk '{print $3; exit}')
if [ -z "$HOST_IP" ]; then
  echo "No encuentro la puerta de enlace; ¿estás dentro de WSL?" >&2
  exit 1
fi
URL="http://$HOST_IP:$PORT"

if ! timeout 3 bash -c "exec 3<>/dev/tcp/$HOST_IP/$PORT" 2>/dev/null; then
  echo "Sin respuesta en $URL." >&2
  echo "En Windows: ./cryptopo-server.exe -addr :$PORT -insecure-http -password-file clave.txt (y revisa el firewall)." >&2
  exit 1
fi

BROWSER=$(command -v chromium || command -v chromium-browser || command -v google-chrome || true)
if [ -z "$BROWSER" ]; then
  echo "$URL responde, pero falta Chromium: sudo apt install -y chromium" >&2
  exit 1
fi

# Por HTTP esa IP no es contexto seguro: sin este flag fallan micro, cámara y chat.
ARGS=(
  "--unsafely-treat-insecure-origin-as-secure=$URL"
  "--user-data-dir=/tmp/cryptopo-wsl"
  "--use-fake-ui-for-media-stream"
)
if [ "${1:-}" = "--fake" ]; then
  ARGS+=("--use-fake-device-for-media-stream")
fi

echo "Conectando a $URL"
exec "$BROWSER" "${ARGS[@]}" "$URL"
