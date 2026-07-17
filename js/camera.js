// camera.js — front camera stream management via getUserMedia.
// Keeps the <video> element mirrored (CSS transform, see main.css .camera-feed)
// and exposes lifecycle helpers app.js/detector.js drive.

export class CameraManager {
  /** @param {HTMLVideoElement} videoEl */
  constructor(videoEl) {
    this.video = videoEl;
    this.stream = null;
  }

  static isSupported() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  }

  /**
   * Requests the front-facing camera. Throws with a descriptive Error on
   * denial/unavailability so callers can show a plain-language message.
   */
  async start() {
    if (!CameraManager.isSupported()) {
      throw new Error('Camera API not supported on this browser.');
    }
    if (this.stream) return this.stream;

    const constraints = {
      audio: false,
      video: {
        facingMode: { ideal: 'user' },
        width: { ideal: 640 },
        height: { ideal: 480 },
        frameRate: { ideal: 24, max: 30 },
      },
    };

    try {
      this.stream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (err) {
      // Re-throw with a normalized message app.js can display verbatim.
      if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
        throw new Error('Camera permission denied. Enable camera access in browser settings to use Monitor.');
      }
      if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
        throw new Error('No camera found on this device.');
      }
      if (err.name === 'NotReadableError') {
        throw new Error('Camera is already in use by another application.');
      }
      throw new Error(`Camera error: ${err.message || err.name}`);
    }

    this.video.srcObject = this.stream;
    await this.video.play().catch(() => {
      // Autoplay can be blocked until user gesture; session start is itself
      // a user gesture so this should not normally happen.
    });
    return this.stream;
  }

  stop() {
    if (this.stream) {
      this.stream.getTracks().forEach((track) => track.stop());
      this.stream = null;
    }
    if (this.video) {
      this.video.srcObject = null;
    }
  }

  get isActive() {
    return !!this.stream && this.stream.getVideoTracks().some((t) => t.readyState === 'live');
  }
}
