import { paths } from '../../app/paths';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { useResumableCheckIn } from './api';

/**
 * Home's Check-In card. "Continue Check-In" while an unfinished one can still be resumed,
 * else "Start Check-In". The list needs the VA check, so it is only read for a verified person.
 */
export function CheckInCard({ verified }: { verified: boolean }) {
  const resumable = useResumableCheckIn(verified);
  const resuming = Boolean(resumable.data);
  // Hold the button until the answer is known, so the label never flips under the person.
  const settled = !verified || resumable.isSuccess || resumable.isError;
  return (
    <Card aria-labelledby="check-in" className="flex flex-col gap-3 p-6">
      <h2 id="check-in" className="text-20 font-bold">
        Check-In
      </h2>
      <p className="text-slate">
        A few short questions about how things are going. This is not a diagnosis.
      </p>
      <div className="flex">
        {settled ? (
          <Button variant="secondary" href={paths.checkIn} size="small" className="min-h-12">
            {resuming ? 'Continue Check-In' : 'Start Check-In'}
          </Button>
        ) : (
          <p role="status" className="min-h-12 py-3 text-slate">
            Loading…
          </p>
        )}
      </div>
    </Card>
  );
}
