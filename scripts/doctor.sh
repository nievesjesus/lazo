#!/usr/bin/env bash
# Checks that the tools and files Lazo needs are in place.
cd "$(dirname "$0")/.."
ok=0
check() { # check "name" command "how to install"
  if eval "$2" >/dev/null 2>&1; then printf "  \033[32m✓\033[0m %s\n" "$1"; else printf "  \033[31m✗\033[0m %s — %s\n" "$1" "$3"; ok=1; fi
}
warn() {
  if eval "$2" >/dev/null 2>&1; then printf "  \033[32m✓\033[0m %s\n" "$1"; else printf "  \033[33m!\033[0m %s — %s\n" "$1" "$3"; fi
}
echo "Tools"
check "Node ≥ 20.19"   'node -e "const [a,b]=process.versions.node.split(\".\").map(Number);process.exit(a>20||(a===20&&b>=19)?0:1)"' "nvm install (see .nvmrc)"
check "npm"            'command -v npm' "ships with Node"
check "uv"             'command -v uv' "brew install uv"
warn  "Google Chrome (e2e)" 'test -x "${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"' "only needed for make e2e"
warn  "Android Studio" 'test -d "/Applications/Android Studio.app"' "only needed for the Android app"
echo "Files"
warn  "Python environment (.venv)" 'test -x .venv/bin/python' "make venv"
warn  "Web dependencies"           'test -d web/node_modules' "make web-deps"
warn  "Face models"                'test -f models/det_500m.onnx -a -f models/w600k_mbf.onnx' "make models"
warn  "Voice model (Whisper)"      'test -f models/whisper-base/onnx/encoder_model_quantized.onnx' "make models"
exit $ok
