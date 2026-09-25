#!/usr/bin/env bash
# Descarga el paquete buffalo_sc de InsightFace (RetinaFace-500MF + MobileFaceNet, ~16 MB).
# Licencia de los pesos: sólo investigación no comercial (ver README).
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p models
if [[ -f models/det_500m.onnx && -f models/w600k_mbf.onnx ]]; then
  echo "Modelos ya presentes en models/"; exit 0
fi
curl -fL -o models/buffalo_sc.zip https://github.com/deepinsight/insightface/releases/download/v0.7/buffalo_sc.zip
unzip -o models/buffalo_sc.zip -d models
rm models/buffalo_sc.zip
shasum -a 256 models/*.onnx
