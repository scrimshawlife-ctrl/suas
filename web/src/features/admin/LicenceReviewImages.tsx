import { useEffect, useRef } from 'react';
import { useLicenceImage, type LicenceImageSide } from './api';
import { QueryNotice } from './QueryNotice';

const LABELS: Readonly<Record<LicenceImageSide, string>> = {
  front: 'Front of the licence',
  back: 'Back of the licence',
  selfie: 'Selfie',
};

/**
 * One review image, fetched with the admin's token and shown from memory only. There is no
 * download link or button (L5.2); the object URL lives only as long as the img shows it.
 */
function LicenceImage({
  id,
  side,
  stored,
}: {
  id: string;
  side: LicenceImageSide;
  stored: boolean;
}) {
  const image = useLicenceImage(id, side, stored);
  const img = useRef<HTMLImageElement>(null);
  useEffect(() => {
    if (image.data === undefined || img.current === null) return;
    const url = URL.createObjectURL(image.data);
    img.current.src = url;
    return () => URL.revokeObjectURL(url);
  }, [image.data]);
  const label = LABELS[side];

  return (
    <figure className="flex flex-col gap-2">
      <figcaption className="text-17 font-bold">{label}</figcaption>
      {!stored ? (
        <p className="text-slate">No image. It was deleted or never stored.</p>
      ) : image.data !== undefined ? (
        <img
          ref={img}
          alt={label}
          draggable={false}
          className="w-full rounded-8 border border-line"
        />
      ) : image.isError ? (
        <QueryNotice error={image.error} what="this image" onRetry={() => void image.refetch()} />
      ) : (
        <p role="status" className="text-slate">
          Loading…
        </p>
      )}
    </figure>
  );
}

/** The front, back and selfie, shown before any reading, flag or check (L5.2). */
export function LicenceReviewImages({
  id,
  images,
}: {
  id: string;
  images: Record<LicenceImageSide, boolean>;
}) {
  return (
    <div className="grid grid-cols-3 items-start gap-5 max-[900px]:grid-cols-1">
      {(['front', 'back', 'selfie'] as const).map((side) => (
        <LicenceImage key={side} id={id} side={side} stored={images[side]} />
      ))}
    </div>
  );
}
