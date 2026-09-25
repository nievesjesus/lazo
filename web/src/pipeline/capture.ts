// Interfaz de captura abstracta (sección 7.3). El pipeline sólo ve `CaptureSource`.
//
// - WebcamSource: webcam del equipo o cámara del teléfono (frontal o trasera) vía getUserMedia.
//   La trasera, con el teléfono a la altura de los ojos, es el sustituto de las gafas del banco de pruebas.
// - Las Ray-Ban Meta NO son accesibles desde el navegador: el Meta Wearables Device Access Toolkit
//   es nativo (Android/iOS). Ver android/ — ahí `GlassesCameraSource` implementa esta misma interfaz.

export interface CaptureSource {
  readonly name: string;
  readonly element: HTMLVideoElement;
  start(): Promise<void>;
  stop(): void;
  /** Dibuja el cuadro actual en el canvas y devuelve sus dimensiones, o null si no hay cuadro. */
  grab(target: HTMLCanvasElement): { width: number; height: number } | null;
}

export type Facing = 'user' | 'environment';

export class WebcamSource implements CaptureSource {
  readonly element: HTMLVideoElement;
  private stream: MediaStream | null = null;

  constructor(
    private facing: Facing = 'user',
    element?: HTMLVideoElement,
  ) {
    this.element = element ?? document.createElement('video');
    this.element.playsInline = true;
    this.element.muted = true;
  }

  get name() {
    return this.facing === 'user' ? 'cámara frontal' : 'cámara trasera (altura de los ojos)';
  }

  async start() {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Este navegador no permite acceder a la cámara (¿falta HTTPS?).');
    }
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: this.facing, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    this.element.srcObject = this.stream;
    await this.element.play();
  }

  stop() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.element.srcObject = null;
  }

  grab(target: HTMLCanvasElement) {
    const v = this.element;
    if (v.readyState < 2 || !v.videoWidth) return null;
    if (target.width !== v.videoWidth || target.height !== v.videoHeight) {
      target.width = v.videoWidth;
      target.height = v.videoHeight;
    }
    target.getContext('2d', { willReadFrequently: true })!.drawImage(v, 0, 0);
    return { width: v.videoWidth, height: v.videoHeight };
  }
}
