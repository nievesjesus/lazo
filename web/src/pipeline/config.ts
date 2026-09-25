// Mismos valores por defecto que core/mnemo/config.py (secciones 5 y 7 de la pre-entrega).

export const QUALITY = {
  minFacePx: 80,
  minSharpness: 60,
  minBrightness: 40,
  maxBrightness: 220,
  minDetScore: 0.5,
  maxYawRatio: 0.35,
};

export interface DecisionConfig {
  tauLow: number;
  tauHigh: number;
  weakTemplatePenalty: number;
  confirmWindow: number;
  confirmHits: number;
  dwellMs: number;
  encounterGapMs: number;
  maxFailedFrames: number;
}

export const DEFAULT_DECISION: DecisionConfig = {
  tauLow: 0.3,
  tauHigh: 0.38,
  weakTemplatePenalty: 0.05,
  confirmWindow: 4,
  confirmHits: 3,
  dwellMs: 1500,
  encounterGapMs: 8000,
  maxFailedFrames: 3,
};

export const ABSTAIN_BAND = 0.08; // τ_alta − τ_baja

export const ENROLLMENT = {
  shots: [
    { key: 'frontal', label: 'Frontal', hint: 'Mirá a la cámara de frente' },
    { key: 'sonrisa', label: 'Sonrisa', hint: 'Ahora sonreí' },
    { key: 'perfil-izq', label: 'Perfil izq.', hint: 'Girá despacio la cabeza a la izquierda' },
    { key: 'perfil-der', label: 'Perfil der.', hint: 'Girá despacio la cabeza a la derecha' },
    { key: 'luz-baja', label: 'Luz baja', hint: 'Alejate un poco de la luz' },
  ],
  minValidShots: 3,
  consentMonths: 12,
  inviteTtlHours: 24,
};

export const MAX_GALLERY = 50;
export const HISTORY_DAYS = 7;
export const DET_SIZE = 640;
export const ABSTAIN_PHRASE = 'Hay alguien, pero no lo reconozco.';
