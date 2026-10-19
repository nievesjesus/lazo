# Lazo (MNEMO) · development tasks.  `make` (or `make help`) lists everything.
# Compatible with GNU Make 3.81 (the one macOS ships).

SHELL := /bin/bash
.DEFAULT_GOAL := help

VENV      := .venv
PY        := $(VENV)/bin/python
PORT      ?= 5173
E2E_PORT  ?= 5199
TARGET_FPIR ?= 0.01

# --------------------------------------------------------------------------- help
.PHONY: help
help: ## Lists the available tasks
	@echo "Lazo (MNEMO) · tasks"
	@echo
	@grep -hE '^[a-zA-Z0-9_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[1m%-14s\033[0m %s\n", $$1, $$2}'
	@echo
	@echo "First time:  make setup && make dev"

# --------------------------------------------------------------------------- setup
.PHONY: setup doctor models venv web-deps
setup: doctor venv web-deps models ## Installs everything: Python environment, web dependencies and models
	@echo; echo "✓ Done. Now: make dev"

doctor: ## Checks required tools and files
	@scripts/doctor.sh

venv: $(PY) ## Python environment (core + voice + dev) with uv
$(PY): core/pyproject.toml
	@command -v uv >/dev/null || { echo "uv is missing: https://docs.astral.sh/uv/ (brew install uv)"; exit 1; }
	uv venv -q --allow-existing -p 3.11 $(VENV)
	uv pip install -q -p $(VENV) -e "core[dev,voice]"
	@touch $(PY)

web-deps: web/node_modules/.package-lock.json ## Web dependencies (npm ci)
web/node_modules/.package-lock.json: web/package-lock.json
	cd web && npm ci --no-audit --no-fund

models: ## Downloads the models (InsightFace buffalo_sc + Whisper base, ~95 MB)
	@scripts/download_models.sh

# --------------------------------------------------------------------------- run
.PHONY: dev dev-phone preview live enroll
dev: web-deps ## Web demo at http://localhost:5173 (change with PORT=…)
	cd web && npm run dev -- --port $(PORT)

dev-phone: web-deps ## Web demo over HTTPS on the local network, to open from your phone
	@IP=$$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || hostname -I 2>/dev/null | cut -d' ' -f1); \
	  echo; echo "  Open on your phone (same Wi-Fi):  https://$$IP:$(PORT)"; echo "  Accept the self-signed certificate once."; echo; \
	  cd web && npm run dev:phone -- --port $(PORT)

preview: build ## Serves the production build
	cd web && npx vite preview --port $(PORT)

live: venv ## Python test bench with the webcam (q quits, w asks «¿quién es?», "who is it?")
	$(VENV)/bin/mnemo live $(ARGS)

enroll: venv ## Enroll via webcam from Python: make enroll NAME=Marta REL="tu hija"
	@test -n "$(NAME)" -a -n "$(REL)" || { echo 'Usage: make enroll NAME=Marta REL="tu hija"'; exit 1; }
	$(VENV)/bin/mnemo enroll --name "$(NAME)" --relation "$(REL)"

# --------------------------------------------------------------------------- quality
.PHONY: test test-core test-web typecheck e2e build check
test: test-core test-web ## Unit tests (Python + web)

test-core: venv
	cd core && ../$(PY) -m pytest -q

test-web: web-deps
	cd web && npx vitest run

typecheck: web-deps ## Type checking for the web app
	cd web && npx tsc --noEmit

e2e: venv web-deps ## E2E in headless Chrome with a fake camera and microphone (starts its own server)
	@E2E_PORT=$(E2E_PORT) PY=$(PY) scripts/e2e.sh

build: web-deps ## Production build of the web app (web/dist)
	cd web && npm run build

check: typecheck test build ## Everything that runs before a commit

# --------------------------------------------------------------------------- evaluation
.PHONY: eval data-lfw
data-lfw: venv
	@test -d data/lfw || $(PY) scripts/prepare_lfw.py

eval: data-lfw ## FPIR/FNIR evaluation on LFW + plots in docs/eval/
	$(VENV)/bin/mnemo-eval data/lfw --target-fpir $(TARGET_FPIR) --dump-scores --out docs/eval/eval_report_lfw.json
	$(PY) scripts/plot_threshold.py docs/eval/eval_report_lfw.json docs/eval/umbral_lfw.png
	$(PY) scripts/plot_det.py docs/eval/eval_report_lfw.json docs/eval/det_lfw.png
	$(PY) scripts/plot_scores.py docs/eval/eval_report_lfw.json docs/eval/distribuciones_lfw.png

# --------------------------------------------------------------------------- android
.PHONY: android
android: ## Opens the Android app in Android Studio
	@open -a "Android Studio" android 2>/dev/null || echo "Install Android Studio (JDK 17, SDK 36) and open the android/ folder"

# --------------------------------------------------------------------------- cleanup
.PHONY: clean distclean
clean: ## Deletes builds and temporary files
	rm -rf web/dist web/e2e/.tmp core/.pytest_cache
	find . -name __pycache__ -type d -prune -exec rm -rf {} +

distclean: clean ## Also deletes the environment, node_modules, models and data
	rm -rf $(VENV) web/node_modules web/public/models models/*.onnx models/whisper-* data
