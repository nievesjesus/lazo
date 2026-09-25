#!/usr/bin/env bash
# Descarga el paquete buffalo_sc de InsightFace (RetinaFace-500MF + MobileFaceNet, ~16 MB).
# Licencia de los pesos: sólo investigación no comercial (ver README).
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p models
if [[ ! -f models/det_500m.onnx || ! -f models/w600k_mbf.onnx ]]; then
  curl -fL -o models/buffalo_sc.zip https://github.com/deepinsight/insightface/releases/download/v0.7/buffalo_sc.zip
  unzip -o models/buffalo_sc.zip -d models
  rm models/buffalo_sc.zip
fi

# Whisper base (ONNX cuantizado, ~77 MB) para escuchar «¿quién es?» en el demo web sin enviar audio a la nube.
W=models/whisper-base
HF=https://huggingface.co/onnx-community/whisper-base/resolve/main
mkdir -p "$W/onnx"
for f in config.json generation_config.json preprocessor_config.json tokenizer.json tokenizer_config.json \
         onnx/encoder_model_quantized.onnx onnx/decoder_model_merged_quantized.onnx; do
  [[ -f "$W/$f" ]] || curl -fL -o "$W/$f" "$HF/$f"
done
shasum -a 256 models/*.onnx "$W"/onnx/*.onnx
