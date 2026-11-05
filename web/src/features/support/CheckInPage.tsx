import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { paths } from '../../app/paths';
import { Button } from '../../components/Button';
import { CrisisPanel } from '../../components/CrisisPanel';
import { Page } from '../../components/Page';
import { RadioCardGroup } from '../../components/RadioCardGroup';
import { cn } from '../../lib/cn';
import {
  useCompleteCheckIn,
  useSaveCheckInAnswer,
  useStartCheckIn,
  type CheckInCompleted,
} from './api';
import {
  firstMissingRequired,
  previousQuestion,
  recordAnswer,
  skipQuestion,
  START,
  type Position,
  type Question,
} from './check-in-flow';
import { NOT_A_DIAGNOSIS, resultCopy } from './check-in-result';
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

function Result({ result }: { result: CheckInCompleted }) {
  const copy = resultCopy(result);
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => headingRef.current?.focus(), []);
  return (
    <Page width="narrow" className="max-w-[760px] gap-6 pt-12">
      {copy.crisis ? <CrisisPanel /> : null}
      <div className="flex flex-col gap-3">
        <h1 ref={headingRef} tabIndex={-1} className="heading text-40 max-sm:text-30">
          {copy.heading}
        </h1>
        <p>{copy.body}</p>
      </div>
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

/** Check-In board: one question per step, then a plain result. */
export default function CheckInPage() {
  const start = useStartCheckIn();
  const checkIn = start.data;
  const save = useSaveCheckInAnswer(checkIn?.check_in_id);
  const complete = useCompleteCheckIn(checkIn?.check_in_id);
  const [position, setPosition] = useState<Position>(START);
  const [choice, setChoice] = useState<string | undefined>(undefined);
  const [result, setResult] = useState<CheckInCompleted | null>(null);
  const [missing, setMissing] = useState(false);
  const started = useRef(false);
  const headingRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    start.mutate();
  }, [start]);

  const questions: readonly Question[] = checkIn?.questions ?? [];
  const question = questions[position.index];
  const busy = save.isPending || complete.isPending;
  const selected = choice ?? (question ? position.answers[question.question_id] : undefined);

  function goTo(next: Position) {
    setPosition(next);
    setChoice(undefined);
    setMissing(false);
    save.reset();
    complete.reset();
    queueMicrotask(() => headingRef.current?.focus());
  }

  async function finish(answers: Position['answers']) {
    const done = await complete.mutateAsync();
    if (done.incomplete) {
      const index = firstMissingRequired(questions, answers);
      goTo({ index: index ?? 0, answers });
      setMissing(true);
      return;
    }
    setResult(done);
  }

  async function onSave() {
    if (!question || selected === undefined) return;
    await save.mutateAsync({ questionId: question.question_id, answerOptionId: selected });
    const next = recordAnswer(questions, position, selected);
    if (next.done) {
      setPosition(next.position);
      await finish(next.position.answers);
    } else {
      goTo(next.position);
    }
  }

  async function onSkip() {
    const next = skipQuestion(questions, position);
    if (next.done) await finish(next.position.answers);
    else goTo(next.position);
  }

  if (result) return <Result result={result} />;

  if (start.isError) {
    return (
      <Page width="narrow">
        <ErrorNotice
          error={start.error}
          doing="start your Check-In"
          onRetry={() => start.mutate()}
        />
      </Page>
    );
  }
  if (!checkIn || !question) {
    return (
      <Page width="narrow">
        <p role="status" className="text-slate">
          {checkIn ? 'No questions are available right now.' : 'Starting your Check-In…'}
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
          void onSave().catch(() => undefined);
        }}
      >
        {missing ? (
          <p role="alert" className="font-bold">
            This question needs an answer before we can finish.
          </p>
        ) : null}
        <div ref={headingRef} tabIndex={-1} className="outline-offset-8">
          <RadioCardGroup
            key={question.question_id}
            name="answer"
            legend={<span className="heading block text-40 max-sm:text-28">{question.prompt}</span>}
            options={question.options.map((option) => ({
              value: option.answer_option_id,
              title: option.label,
            }))}
            value={selected ?? ''}
            onValueChange={setChoice}
          />
        </div>
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
              onClick={() => void onSkip().catch(() => undefined)}
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
