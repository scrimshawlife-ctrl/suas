import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { paths } from '../../app/paths';
import { Button } from '../../components/Button';
import { CrisisPanel } from '../../components/CrisisPanel';
import { Page } from '../../components/Page';
import { RadioCardGroup } from '../../components/RadioCardGroup';
import { cn } from '../../lib/cn';
import { useSingleFlight } from '../../lib/single-flight';
import {
  useCheckIn,
  useCompleteCheckIn,
  useResumableCheckIn,
  useSaveCheckInAnswer,
  useStartCheckIn,
  type CheckInCompleted,
  type CheckInWithQuestions,
} from './api';
import {
  previousQuestion,
  recordAnswer,
  resumePosition,
  skipQuestion,
  START,
  type Position,
  type Question,
} from './check-in-flow';
import { INCOMPLETE_TEXT, NOT_A_DIAGNOSIS, resultCopy } from './check-in-result';
import { ErrorNotice } from './errors';

function Segments({ total, index }: { total: number; index: number }) {
  return (
    <ol
      aria-hidden="true"
      className="grid gap-1.5"
      style={{ gridTemplateColumns: `repeat(${total}, minmax(0, 1fr))` }}
    >
      {Array.from({ length: total }, (_, i) => (
        <li
          key={i}
          className={cn(
            'h-2 rounded-4 bg-line',
            i < index && 'bg-service-blue',
            i === index && 'bg-[#8DB5F2]',
          )}
        />
      ))}
    </ol>
  );
}

function Disclaimer() {
  return <p className="rounded-8 bg-mist px-4.5 py-4 text-16 text-slate">{NOT_A_DIAGNOSIS}</p>;
}

/** Neutral result. A RED signal adds the crisis panel straight after the two lines. */
function Result({ result }: { result: CheckInCompleted }) {
  const copy = resultCopy(result);
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    window.scrollTo(0, 0);
    headingRef.current?.focus({ preventScroll: true });
  }, []);
  return (
    <Page width="narrow" className="max-w-[760px] gap-5 pt-8 max-sm:pt-4">
      <div className="flex flex-col gap-1.5">
        <h1
          ref={headingRef}
          tabIndex={-1}
          className={cn(
            'heading',
            copy.crisis ? 'text-30 max-sm:text-24' : 'text-40 max-sm:text-30',
          )}
        >
          {copy.heading}
        </h1>
        <p>{copy.body}</p>
      </div>
      {copy.crisis ? <CrisisPanel /> : null}
      <div className="flex flex-wrap gap-3">
        <Button size="form" href={paths.request}>
          Ask for help
        </Button>
        <Button size="form" variant="secondary" href={paths.home}>
          Back to home
        </Button>
      </div>
      <Disclaimer />
    </Page>
  );
}

/** The steps and the result for one Check-In, opened at `initial`. Remount it to change either. */
function CheckInFlow({
  checkIn,
  initial,
  onStartAgain,
}: {
  checkIn: CheckInWithQuestions;
  initial: Position;
  onStartAgain: () => void;
}) {
  const save = useSaveCheckInAnswer(checkIn.check_in_id);
  const complete = useCompleteCheckIn(checkIn.check_in_id);
  const flight = useSingleFlight();
  const [position, setPosition] = useState<Position>(initial);
  const [choice, setChoice] = useState<string | undefined>(undefined);
  const [result, setResult] = useState<CheckInCompleted | null>(null);
  const [incomplete, setIncomplete] = useState(false);
  const questionRef = useRef<HTMLHeadingElement>(null);

  const questions: readonly Question[] = checkIn.questions;
  const question = questions[position.index];
  const busy = save.isPending || complete.isPending;
  const selected = choice ?? (question ? position.answers[question.question_id] : undefined);

  function goTo(next: Position) {
    setPosition(next);
    setChoice(undefined);
    save.reset();
    complete.reset();
    queueMicrotask(() => questionRef.current?.focus());
  }

  async function finish() {
    const done = await complete.mutateAsync();
    if (done.incomplete) setIncomplete(true);
    else setResult(done);
  }

  async function onSave() {
    if (!question || selected === undefined) return;
    await save.mutateAsync({ questionId: question.question_id, answerOptionId: selected });
    const next = recordAnswer(questions, position, selected);
    if (next.done) {
      setPosition(next.position);
      await finish();
    } else {
      goTo(next.position);
    }
  }

  async function onSkip() {
    const next = skipQuestion(questions, position);
    if (next.done) await finish();
    else goTo(next.position);
  }

  if (result) return <Result result={result} />;

  if (incomplete) {
    return (
      <Page width="narrow" className="max-w-[760px] gap-5 pt-12">
        <p role="alert" className="text-20 font-bold">
          {INCOMPLETE_TEXT}
        </p>
        <div className="flex flex-wrap gap-3">
          <Button size="form" onClick={onStartAgain}>
            Start again
          </Button>
          <Button size="form" variant="secondary" href={paths.home}>
            Back to home
          </Button>
        </div>
        <Disclaimer />
      </Page>
    );
  }

  if (!question) {
    return (
      <Page width="narrow">
        <p role="status" className="text-slate">
          No questions are available right now.
        </p>
      </Page>
    );
  }

  const failure = save.error ?? complete.error;
  const isFirst = position.index === 0;

  return (
    <Page width="narrow" className="max-w-[760px] gap-7 pt-12">
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
          <h1 className="text-20 font-bold">Check-In</h1>
          <Link to={paths.home} className="inline-flex min-h-11 items-center font-bold">
            Save and finish later
          </Link>
        </div>
        <p role="status" className="font-bold text-slate">
          Question {position.index + 1} of {questions.length}
        </p>
        <Segments total={questions.length} index={position.index} />
      </div>

      <form
        className="flex flex-col gap-7"
        onSubmit={(event) => {
          event.preventDefault();
          flight(onSave);
        }}
      >
        <h2
          ref={questionRef}
          tabIndex={-1}
          className="heading text-40 outline-offset-8 max-sm:text-28"
        >
          {question.prompt}
        </h2>
        <RadioCardGroup
          key={question.question_id}
          name="answer"
          legend={<span className="sr-only">{question.prompt}</span>}
          options={question.options.map((option) => ({
            value: option.answer_option_id,
            title: option.label,
          }))}
          value={selected ?? ''}
          onValueChange={setChoice}
        />
        {failure ? <ErrorNotice error={failure} doing="save your answer" /> : null}
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" size="form" disabled={busy || selected === undefined}>
            {busy ? 'Saving…' : 'Save answer'}
          </Button>
          {isFirst ? null : (
            <Button
              variant="ghost"
              size="form"
              className="underline underline-offset-4"
              disabled={busy}
              onClick={() => goTo(previousQuestion(position))}
            >
              Previous question
            </Button>
          )}
          {question.required ? null : (
            <Button
              variant="ghost"
              size="form"
              className="underline underline-offset-4"
              disabled={busy}
              onClick={() => flight(onSkip)}
            >
              Skip this question
            </Button>
          )}
        </div>
      </form>

      <Disclaimer />
    </Page>
  );
}

/**
 * Check-In board. Opens the caller's unfinished Check-In when there is one (answers are saved
 * per answer, so it resumes at the first unanswered question), otherwise starts a new one.
 */
export default function CheckInPage() {
  const resumable = useResumableCheckIn();
  const start = useStartCheckIn();
  // undefined: not decided yet. null: start a new one. Set once from the first list read,
  // so a later refetch (after complete) can neither swap the Check-In nor start another.
  const [resumeId, setResumeId] = useState<string | null | undefined>(undefined);
  if (resumeId === undefined && resumable.isSuccess) {
    setResumeId(resumable.data?.check_in_id ?? null);
  }
  const resumed = useCheckIn(resumeId ?? undefined);
  const started = useRef(false);

  useEffect(() => {
    if (resumeId !== null || started.current) return;
    started.current = true;
    start.mutate();
  }, [resumeId, start]);

  function startAgain() {
    started.current = false;
    setResumeId(null);
    start.reset();
  }

  const checkIn = start.data ?? resumed.data;
  if (checkIn) {
    const initial =
      start.data === undefined && resumed.data
        ? resumePosition(resumed.data.questions, resumed.data.answered_question_ids)
        : START;
    return (
      <CheckInFlow
        key={checkIn.check_in_id}
        checkIn={checkIn}
        initial={initial}
        onStartAgain={startAgain}
      />
    );
  }

  const failed = start.isError
    ? { error: start.error, doing: 'start your Check-In', retry: () => start.mutate() }
    : resumable.isError
      ? {
          error: resumable.error,
          doing: 'open your Check-In',
          retry: () => void resumable.refetch(),
        }
      : resumed.isError
        ? { error: resumed.error, doing: 'open your Check-In', retry: () => void resumed.refetch() }
        : null;
  return (
    <Page width="narrow">
      {failed ? (
        <ErrorNotice error={failed.error} doing={failed.doing} onRetry={failed.retry} />
      ) : (
        <p role="status" className="text-slate">
          Opening your Check-In…
        </p>
      )}
    </Page>
  );
}
