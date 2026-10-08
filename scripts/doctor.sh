#!/usr/bin/env bash
# Verifica que estén las herramientas y archivos que necesita MNEMO.
cd "$(dirname "$0")/.."
ok=0
check() { # check "nombre" comando "cómo instalar"
  if eval "$2" >/dev/null 2>&1; then printf "  \033[32m✓\033[0m %s\n" "$1"; else printf "  \033[31m✗\033[0m %s — %s\n" "$1" "$3"; ok=1; fi
}
warn() {
  if eval "$2" >/dev/null 2>&1; then printf "  \033[32m✓\033[0m %s\n" "$1"; else printf "  \033[33m!\033[0m %s — %s\n" "$1" "$3"; fi
}
echo "Herramientas"
check "Node ≥ 20.19"   'node -e "const [a,b]=process.versions.node.split(\".\").map(Number);process.exit(a>20||(a===20&&b>=19)?0:1)"' "nvm install (ver .nvmrc)"
check "npm"            'command -v npm' "viene con Node"
check "uv"             'command -v uv' "brew install uv"
warn  "Google Chrome (e2e)" 'test -x "${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"' "necesario sólo para make e2e"
warn  "Android Studio" 'test -d "/Applications/Android Studio.app"' "necesario sólo para la app Android"
echo "Archivos"
warn  "Entorno Python (.venv)"    'test -x .venv/bin/python' "make venv"
warn  "Dependencias web"          'test -d web/node_modules' "make web-deps"
warn  "Modelos faciales"          'test -f models/det_500m.onnx -a -f models/w600k_mbf.onnx' "make models"
warn  "Modelo de voz (Whisper)"   'test -f models/whisper-base/onnx/encoder_model_quantized.onnx' "make models"
exit $ok
