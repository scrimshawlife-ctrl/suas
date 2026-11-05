import { useId } from 'react';

export interface PillGroupProps<T extends string> {
  legend: string;
  name: string;
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
}

/** A fieldset of radio pills, drawn as on the Case board: filled Service Blue when chosen. */
export function PillGroup<T extends string>({
  legend,
  name,
  options,
  value,
  onChange,
}: PillGroupProps<T>) {
  const prefix = useId();
  return (
    <fieldset className="flex flex-col gap-2.5">
      <legend className="mb-2.5 font-bold">{legend}</legend>
      <div className="flex flex-wrap gap-2">
        {options.map((option) => {
          const id = `${prefix}-${option.value}`;
          const chosen = option.value === value;
          return (
            <label
              key={option.value}
              htmlFor={id}
              className={`relative inline-flex min-h-11 cursor-pointer items-center rounded-pill border-2 px-4 text-16 font-bold has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-service-blue has-focus-visible:shadow-[0_0_0_2px_#fff] ${
                chosen
                  ? 'border-service-blue bg-service-blue text-white'
                  : 'border-line bg-white text-ink hover:border-slate'
              }`}
            >
              <input
                id={id}
                type="radio"
                name={name}
                value={option.value}
                checked={chosen}
                onChange={() => onChange(option.value)}
                className="absolute size-px opacity-0"
              />
              {option.label}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
