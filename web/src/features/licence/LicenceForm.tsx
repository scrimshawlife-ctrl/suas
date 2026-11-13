import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Button } from '../../components/Button';
import { AlertCircleIcon } from '../../components/icons';
import { useFocusFirstInvalid } from '../../lib/focus-invalid';
import { LicenceImageError, toLicenceJpeg } from './licence-image';
import { PhotoPicker } from './PhotoPicker';
import { SelfieCamera, type GrabFrame, type OpenCamera } from './SelfieCamera';

export interface LicencePhotos {
  front: Blob;
  back: Blob;
  selfie: Blob;
}

type Capture = keyof LicencePhotos;

interface CaptureState {
  blob: Blob | null;
  url: string | null;
  preparing: boolean;
  error: string | undefined;
}

const EMPTY: CaptureState = { blob: null, url: null, preparing: false, error: undefined };

const SIDES: readonly { side: 'front' | 'back'; label: string; helper: string }[] = [
  { side: 'front', label: 'Front of your licence', helper: 'The side with your photo and name.' },
  { side: 'back', label: 'Back of your licence', helper: 'The side with the barcode.' },
];

const MISSING: Readonly<Record<Capture, string>> = {
  front: 'Add a photo of the front of your licence.',
  back: 'Add a photo of the back of your licence.',
  selfie: 'Take a selfie with your camera.',
};

function prepareError(error: unknown): string {
  if (error instanceof LicenceImageError && error.reason === 'too_large') {
    return 'That photo is too large. Please try again.';
  }
  return "We couldn't open that photo. Try another one.";
}

export interface LicenceFormProps {
  sending: boolean;
  /** A send failure that is not about one capture (connection, server). */
  sendError: string | null;
  onSubmit: (photos: LicencePhotos) => void;
  /** Shown beside "Send for review" with equal weight: the self-attestation choice. */
  alternative?: ReactNode;
  /** Turns a picked file into the JPEG to send; tests pass a fake (jsdom cannot decode images). */
  prepare?: (file: File) => Promise<Blob>;
  openCamera?: OpenCamera;
  grabFrame?: GrabFrame;
}

/**
 * Front and back photos (camera or files) and a live selfie (camera only), each shrunk in the
 * browser before anything is sent (L2.2). The captures live only in this component's memory.
 */
export function LicenceForm({
  sending,
  sendError,
  onSubmit,
  alternative,
  prepare = toLicenceJpeg,
  openCamera,
  grabFrame,
}: LicenceFormProps) {
  const [captures, setCaptures] = useState<Record<Capture, CaptureState>>({
    front: EMPTY,
    back: EMPTY,
    selfie: EMPTY,
  });
  const [attempt, setAttempt] = useState(0);
  const formRef = useRef<HTMLFormElement>(null);
  // The newest pick per side; a slower earlier pick that finishes later is dropped.
  const picks = useRef<Record<Capture, number>>({ front: 0, back: 0, selfie: 0 });
  const urls = useRef<Set<string>>(new Set());
  useFocusFirstInvalid(formRef, String(attempt));

  useEffect(() => {
    const owned = urls.current;
    return () => owned.forEach((url) => URL.revokeObjectURL(url));
  }, []);

  const update = (capture: Capture, next: CaptureState) =>
    setCaptures((current) => {
      const old = current[capture].url;
      if (old !== null && old !== next.url) {
        URL.revokeObjectURL(old);
        urls.current.delete(old);
      }
      return { ...current, [capture]: next };
    });

  const keep = (capture: Capture, blob: Blob) => {
    const url = URL.createObjectURL(blob);
    urls.current.add(url);
    update(capture, { blob, url, preparing: false, error: undefined });
  };

  const pick = async (side: 'front' | 'back', file: File) => {
    const ticket = ++picks.current[side];
    setCaptures((current) => ({
      ...current,
      [side]: { ...current[side], preparing: true, error: undefined },
    }));
    try {
      const blob = await prepare(file);
      if (picks.current[side] === ticket) keep(side, blob);
    } catch (error) {
      if (picks.current[side] === ticket) update(side, { ...EMPTY, error: prepareError(error) });
    }
  };

  const clear = (capture: Capture) => {
    picks.current[capture] += 1;
    update(capture, EMPTY);
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setAttempt((count) => count + 1);
    const { front, back, selfie } = captures;
    if (front.blob !== null && back.blob !== null && selfie.blob !== null) {
      onSubmit({ front: front.blob, back: back.blob, selfie: selfie.blob });
      return;
    }
    setCaptures((current) => {
      const next = { ...current };
      for (const capture of ['front', 'back', 'selfie'] as const) {
        if (next[capture].blob === null && !next[capture].preparing) {
          next[capture] = { ...next[capture], error: next[capture].error ?? MISSING[capture] };
        }
      }
      return next;
    });
  };

  const preparing = captures.front.preparing || captures.back.preparing;

  return (
    <form
      ref={formRef}
      noValidate
      aria-label="Photos of your licence and a selfie"
      className="flex flex-col gap-6"
      onSubmit={submit}
    >
      {SIDES.map(({ side, label, helper }) => (
        <PhotoPicker
          key={side}
          id={`licence-${side}`}
          label={label}
          helper={helper}
          previewUrl={captures[side].url}
          preparing={captures[side].preparing}
          error={captures[side].error}
          onPick={(file) => void pick(side, file)}
          onClear={() => clear(side)}
        />
      ))}
      <SelfieCamera
        id="licence-selfie"
        previewUrl={captures.selfie.url}
        error={captures.selfie.error}
        onCapture={(blob) => {
          picks.current.selfie += 1;
          keep('selfie', blob);
        }}
        onClear={() => clear('selfie')}
        {...(openCamera ? { openCamera } : {})}
        {...(grabFrame ? { grabFrame } : {})}
      />
      <div aria-live="polite" className="empty:hidden">
        {sendError ? (
          <p className="flex items-start gap-2 font-bold">
            <AlertCircleIcon className="mt-1 shrink-0" />
            {sendError}
          </p>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-4">
        <Button type="submit" size="form" disabled={sending || preparing}>
          {sending ? 'Sending for review…' : 'Send for review'}
        </Button>
        {alternative}
      </div>
    </form>
  );
}
