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

/**
 * Grid cell. On a phone the NeedTileOff chip may wrap, so two columns fit at 390 px.
 */
const TILE_ITEM =
  'flex [&>a]:min-w-0 [&>a]:grow max-sm:[&_.rounded-pill]:px-2.5 max-sm:[&_.rounded-pill]:whitespace-normal max-sm:[&_.rounded-pill]:text-center max-sm:[&_.rounded-pill]:leading-tight';

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
      <ul className="grid grid-cols-3 gap-3.5 max-md:grid-cols-2 max-sm:gap-2.5">
        {categories.map((card) => {
          if (card.disposition === 'OPERATIONAL') {
            if (card.category === null) return null;
            return (
              <li key={card.label} className={TILE_ITEM}>
                <NeedTile
                  category={card.category}
                  title={card.label}
                  to={`/resources/${card.category.toLowerCase()}`}
                  description={card.note ?? DESCRIPTIONS[card.category]}
                />
              </li>
            );
          }
          return (
            <li key={card.label} className={TILE_ITEM}>
              <NeedTileOff
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
