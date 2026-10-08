# MNEMO · tareas de desarrollo.  `make` (o `make help`) lista todo.
# Compatible con GNU Make 3.81 (el que trae macOS).

SHELL := /bin/bash
.DEFAULT_GOAL := help

VENV      := .venv
PY        := $(VENV)/bin/python
PORT      ?= 5173
E2E_PORT  ?= 5199
TARGET_FPIR ?= 0.01

# --------------------------------------------------------------------------- ayuda
.PHONY: help
help: ## Lista las tareas disponibles
	@echo "MNEMO · tareas"
	@echo
	@grep -hE '^[a-zA-Z0-9_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[1m%-14s\033[0m %s\n", $$1, $$2}'
	@echo
	@echo "Primera vez:  make setup && make dev"

# --------------------------------------------------------------------------- instalación
.PHONY: setup doctor models venv web-deps
setup: doctor venv web-deps models ## Instala todo: entorno Python, dependencias web y modelos
	@echo; echo "✓ Listo. Ahora: make dev"

doctor: ## Verifica herramientas y archivos necesarios
	@scripts/doctor.sh

venv: $(PY) ## Entorno Python (core + voz + dev) con uv
$(PY): core/pyproject.toml
	@command -v uv >/dev/null || { echo "Falta uv: https://docs.astral.sh/uv/ (brew install uv)"; exit 1; }
	uv venv -q --allow-existing -p 3.11 $(VENV)
	uv pip install -q -p $(VENV) -e "core[dev,voice]"
	@touch $(PY)

web-deps: web/node_modules/.package-lock.json ## Dependencias de la web (npm ci)
web/node_modules/.package-lock.json: web/package-lock.json
	cd web && npm ci --no-audit --no-fund

models: ## Descarga los modelos (InsightFace buffalo_sc + Whisper base, ~95 MB)
	@scripts/download_models.sh

# --------------------------------------------------------------------------- levantar
.PHONY: dev dev-phone preview live enroll
dev: web-deps ## Demo web en http://localhost:5173 (cambiar con PORT=…)
	cd web && npm run dev -- --port $(PORT)

dev-phone: web-deps ## Demo web por HTTPS en la red local, para abrir desde el celular
	@IP=$$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || hostname -I 2>/dev/null | cut -d' ' -f1); \
	  echo; echo "  Abrí en el celular (misma Wi-Fi):  https://$$IP:$(PORT)"; echo "  Aceptá el certificado autofirmado una vez."; echo; \
	  cd web && npm run dev:phone -- --port $(PORT)

preview: build ## Sirve el build de producción
	cd web && npx vite preview --port $(PORT)

live: venv ## Banco de pruebas Python con la webcam (q sale, w = «¿quién es?»)
	$(VENV)/bin/mnemo live $(ARGS)

enroll: venv ## Alta por webcam desde Python: make enroll NAME=Marta REL="tu hija"
	@test -n "$(NAME)" -a -n "$(REL)" || { echo 'Uso: make enroll NAME=Marta REL="tu hija"'; exit 1; }
	$(VENV)/bin/mnemo enroll --name "$(NAME)" --relation "$(REL)"

# --------------------------------------------------------------------------- calidad
.PHONY: test test-core test-web typecheck e2e build check
test: test-core test-web ## Tests unitarios (Python + web)

test-core: venv
	cd core && ../$(PY) -m pytest -q

test-web: web-deps
	cd web && npx vitest run

typecheck: web-deps ## Chequeo de tipos de la web
	cd web && npx tsc --noEmit

e2e: venv web-deps ## E2E en Chrome headless con cámara y micrófono falsos (levanta su propio server)
	@E2E_PORT=$(E2E_PORT) PY=$(PY) scripts/e2e.sh

build: web-deps ## Build de producción de la web (web/dist)
	cd web && npm run build

check: typecheck test build ## Todo lo que corre antes de un commit

# --------------------------------------------------------------------------- evaluación
.PHONY: eval data-lfw
data-lfw: venv
	@test -d data/lfw || $(PY) scripts/prepare_lfw.py

eval: data-lfw ## Evaluación FPIR/FNIR sobre LFW + gráficos en docs/eval/
	$(VENV)/bin/mnemo-eval data/lfw --target-fpir $(TARGET_FPIR) --out docs/eval/eval_report_lfw.json
	$(PY) scripts/plot_threshold.py docs/eval/eval_report_lfw.json docs/eval/umbral_lfw.png
	$(PY) scripts/plot_det.py docs/eval/eval_report_lfw.json docs/eval/det_lfw.png

# --------------------------------------------------------------------------- android
.PHONY: android
android: ## Abre la app Android en Android Studio
	@open -a "Android Studio" android 2>/dev/null || echo "Instalá Android Studio (JDK 17, SDK 36) y abrí la carpeta android/"

# --------------------------------------------------------------------------- limpieza
.PHONY: clean distclean
clean: ## Borra builds y archivos temporales
	rm -rf web/dist web/e2e/.tmp core/.pytest_cache
	find . -name __pycache__ -type d -prune -exec rm -rf {} +

distclean: clean ## Además borra el entorno, node_modules, modelos y datos
	rm -rf $(VENV) web/node_modules web/public/models models/*.onnx models/whisper-* data
