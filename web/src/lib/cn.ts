import { extendTailwindMerge } from 'tailwind-merge';

/**
 * Tailwind-aware class joiner: later classes win over earlier ones in the same group, so a
 * caller's `className` overrides a component default. The extension teaches it this
 * project's px named font sizes (`text-18`) and radii (`rounded-8`, `rounded-pill`), which
 * it would otherwise mistake for a text colour and an unknown radius.
 */
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      text: [
        '16',
        '17',
        '18',
        '19',
        '20',
        '21',
        '22',
        '24',
        '26',
        '28',
        '30',
        '32',
        '34',
        '40',
        '44',
        '48',
        '52',
        '54',
        '56',
        '60',
        '64',
        '72',
        '96',
      ],
      radius: ['6', '8', '10', '12', '14', 'pill'],
    },
  },
});

export function cn(...parts: (string | false | null | undefined)[]): string {
  return twMerge(parts.filter(Boolean).join(' '));
}
