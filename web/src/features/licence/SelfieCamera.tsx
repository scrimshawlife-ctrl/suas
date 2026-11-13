import { useEffect, useRef, useState } from 'react';
import { Button } from '../../components/Button';
import { AlertCircleIcon } from '../../components/icons';
import { drawToJpeg } from './licence-image';

/** Opens the front camera. Tests pass a fake; jsdom has no camera. */
export type OpenCamera = () => Promise<MediaStream>;
/** Turns the current camera frame into the JPEG to send. */
export type GrabFrame = (video: HTMLVideoElement) => Promise<Blob>;

export const openFrontCamera: OpenCamera = () => {
  if (navigator.mediaDevices?.getUserMedia === undefined) {
    return Promise.reject(new Error('no camera API'));
  }
  return navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: false });
};

export const grabVideoFrame: GrabFrame = (video) =>
  drawToJpeg(video, video.videoWidth, video.videoHeight);

const CAMERA_NEEDED =
  'We need your camera for the selfie. Allow camera access in your browser, then turn the camera on again. If this device has no camera, use a phone.';

export interface SelfieCameraProps {
  id: string;
  /** Object URL of the taken selfie, or null before one is taken. */
  previewUrl: string | null;
  error?: string | undefined;
  onCapture: (blob: Blob) => void;
  onClear: () => void;
  openCamera?: OpenCamera;
  grabFrame?: GrabFrame;
}

/**
 * The live selfie (L2.2): from the camera only, never from files. A file input with
 * `capture="user"` still opens a file picker on desktop browsers, so this uses getUserMedia and
 * offers no other way in. It discourages, but cannot prevent, a substituted image (for example
 * a virtual camera); it is not a liveness check. No face template is computed.
 */
export function SelfieCamera({
  id,
  previewUrl,
  error,
  onCapture,
  onClear,
  openCamera = openFrontCamera,
  grabFrame = grabVideoFrame,
}: SelfieCameraProps) {
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const [state, setState] = useState<'off' | 'starting' | 'live' | 'taking'>('off');
  const [cameraError, setCameraError] = useState<string | null>(null);

  const stop = () => {
    stream.current?.getTracks().forEach((track) => track.stop());
    stream.current = null;
  };
  // The camera never stays on after the page leaves.
  useEffect(() => stop, []);

  useEffect(() => {
    if (state !== 'live' || video.current === null || stream.current === null) return;
    video.current.srcObject = stream.current;
    // Some browsers return no promise; a refused autoplay still leaves the Take selfie button.
    void Promise.resolve(video.current.play()).catch(() => undefined);
  }, [state]);

  const start = async () => {
    setCameraError(null);
    setState('starting');
    try {
      stream.current = await openCamera();
      setState('live');
    } catch {
      setState('off');
      setCameraError(CAMERA_NEEDED);
    }
  };

  const take = async () => {
    if (video.current === null) return;
    setState('taking');
    try {
      const blob = await grabFrame(video.current);
      stop();
      setState('off');
      onCapture(blob);
    } catch {
      setState('live');
      setCameraError("We couldn't take the selfie. Try again.");
    }
  };

  const shownError = cameraError ?? error;
  const describedBy = [`${id}-helper`, shownError ? `${id}-error` : null].filter(Boolean).join(' ');

  return (
    <div className="flex flex-col gap-2.5" role="group" aria-labelledby={`${id}-label`}>
      <p id={`${id}-label`} className="text-17 font-bold">
        A selfie, taken now
      </p>
      <p id={`${id}-helper`} className="text-16 text-slate">
        Face the camera in good light. An admin compares it with the photo on your licence, by eye.
        It is taken with your camera only, so a saved photo can't be used.
      </p>
      {previewUrl !== null && state === 'off' ? (
        <img
          src={previewUrl}
          alt="Your selfie, as it will be sent"
          className="max-h-60 w-auto self-start rounded-8 border border-line"
        />
      ) : null}
      {state === 'live' || state === 'taking' ? (
        <video
          ref={video}
          muted
          playsInline
          aria-label="Camera preview"
          className="max-h-72 w-auto self-start rounded-8 border border-line"
        />
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        {state === 'live' || state === 'taking' ? (
          <Button
            id={id}
            variant="secondary"
            aria-describedby={describedBy}
            disabled={state === 'taking'}
            onClick={() => void take()}
          >
            {state === 'taking' ? 'Taking selfie…' : 'Take selfie'}
          </Button>
        ) : (
          <Button
            id={id}
            variant="secondary"
            aria-describedby={describedBy}
            aria-invalid={shownError ? true : undefined}
            disabled={state === 'starting'}
            onClick={() => void start()}
          >
            {state === 'starting'
              ? 'Turning on the camera…'
              : previewUrl === null
                ? 'Turn on the camera'
                : 'Take it again'}
          </Button>
        )}
        {previewUrl !== null && state === 'off' ? (
          <Button variant="ghost" size="small" onClick={onClear}>
            Remove selfie
          </Button>
        ) : null}
      </div>
      {shownError ? (
        <p id={`${id}-error`} className="flex items-center gap-2 text-16 font-bold">
          <AlertCircleIcon size={20} />
          {shownError}
        </p>
      ) : null}
    </div>
  );
}
