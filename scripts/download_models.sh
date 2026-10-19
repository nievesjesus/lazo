#!/usr/bin/env bash
# Downloads InsightFace's buffalo_sc package (SCRFD-500MF + MobileFaceNet, ~16 MB).
# Weights licence: non-commercial research purposes only (see README).
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p models
if [[ ! -f models/det_500m.onnx || ! -f models/w600k_mbf.onnx ]]; then
  curl -fL -o models/buffalo_sc.zip https://github.com/deepinsight/insightface/releases/download/v0.7/buffalo_sc.zip
  unzip -o models/buffalo_sc.zip -d models
  rm models/buffalo_sc.zip
fi

# Whisper base (quantized ONNX, ~77 MB) to listen for «¿quién es?» ("who is it?") in the web demo without sending audio to the cloud.
W=models/whisper-base
HF=https://huggingface.co/onnx-community/whisper-base/resolve/main
mkdir -p "$W/onnx"
for f in config.json generation_config.json preprocessor_config.json tokenizer.json tokenizer_config.json \
         onnx/encoder_model_quantized.onnx onnx/decoder_model_merged_quantized.onnx; do
  [[ -f "$W/$f" ]] || curl -fL -o "$W/$f" "$HF/$f"
done
shasum -a 256 models/*.onnx "$W"/onnx/*.onnx
