import type { ComponentType } from 'react';
import type { Me, ServiceCategory } from '../../../api/types';
import { ChatIcon, BriefcaseIcon, FlagIcon } from '../../../components/icons';
import type { IconProps } from '../../../components/Icon';
import { NeedTile } from '../../../components/NeedTile';
import { NeedTileOff } from '../../../components/NeedTileOff';

type CategoryCard = Me['categories'][number];

/** Board words for released tiles that have no note from the API. */
const DESCRIPTIONS: Partial<Record<ServiceCategory, string>> = {
  FOOD: 'Pantries, meals and essential supplies.',
  TRANSPORTATION: 'Rides to appointments and errands.',
};

/** Icons for tiles that are not released; the API sends a label, not an icon. */
const OFF_ICONS: Record<string, ComponentType<IconProps>> = {
  Counseling: ChatIcon,
  Activities: FlagIcon,
  'Job Training': BriefcaseIcon,
};

const OFF_STATUS: Record<CategoryCard['disposition'], string> = {
  OPERATIONAL: 'Coming soon',
  COMING_SOON: 'Coming soon',
  INFORMATION_ONLY: 'Info only',
};

/** First sentence of the API note: the short line the Phone board shows under the title. */
export function phoneTag(note: string): string {
  return (note.split(/(?<=\.)\s/)[0] ?? note).replace(/\.$/, '');
}

function slug(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

/**
 * "Find help" tiles from `me.categories`. A released category is a filled NeedTile; the rest
 * are dashed tiles that say plainly they create no request. Availability is whatever the
 * API sent, never a list kept here.
 */
export function FindHelp({ categories }: { categories: readonly CategoryCard[] }) {
  return (
    <section aria-labelledby="find-help" className="flex flex-col gap-4">
      <h2 id="find-help" className="heading text-28 leading-[1.1]">
        Find help
      </h2>
      <ul className="grid grid-cols-3 gap-3.5 max-md:grid-cols-[repeat(2,minmax(0,1fr))] max-sm:gap-2.5 max-[359px]:grid-cols-1!">
        {categories.map((card) => {
          if (card.disposition === 'OPERATIONAL') {
            if (card.category === null) return null;
            return (
              <li key={card.label} className="flex">
                <NeedTile
                  category={card.category}
                  title={card.label}
                  to={`/resources/${card.category.toLowerCase()}`}
                  description={
                    card.note ?? (card.category ? DESCRIPTIONS[card.category] : undefined)
                  }
                  {...(card.note ? { phoneTag: phoneTag(card.note) } : {})}
                  className="grow"
                />
              </li>
            );
          }
          return (
            <li key={card.label} className="flex">
              <NeedTileOff
                className="grow"
                icon={OFF_ICONS[card.label] ?? FlagIcon}
                title={card.label}
                status={OFF_STATUS[card.disposition]}
                to={`/resources/${slug(card.label)}`}
                description={card.note ?? 'Not available yet. This does not create a request.'}
              />
            </li>
          );
        })}
      </ul>
    </section>
  );
}
