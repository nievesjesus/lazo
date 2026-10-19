// Abstract capture interface. The pipeline only sees `CaptureSource`.
//
// - WebcamSource: computer webcam or phone camera (front or rear) via getUserMedia.
//   The rear camera, with the phone held at eye level, stands in for the glasses on the test bench.
// - The Ray-Ban Meta glasses are NOT reachable from the browser: the Meta Wearables Device Access
//   Toolkit is native (Android/iOS). See android/ — there `GlassesCameraSource` implements this same interface.

export interface CaptureSource {
  readonly name: string;
  readonly element: HTMLVideoElement;
  start(): Promise<void>;
  stop(): void;
  /** Draws the current frame onto the canvas and returns its dimensions, or null if there is no frame. */
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
