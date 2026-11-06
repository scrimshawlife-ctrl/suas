import type { ComponentType } from 'react';
import type { IconProps } from './Icon';
import { CarIcon, HouseIcon, SoupIcon, UsersIcon } from './icons';

/** The four request categories the API accepts. */
export type NeedCategory = 'FOOD' | 'TRANSPORTATION' | 'SHELTER' | 'PEER_SUPPORT';

export interface NeedMeta {
  /** Plain label used on tiles and request rows. */
  label: string;
  Icon: ComponentType<IconProps>;
  /** Filled background for the need colour. */
  fill: string;
  /** Border colour for the filled tile. */
  border: string;
}

/** Need colours are fills behind white icons and labels; never text on white. */
export const NEEDS: Record<NeedCategory, NeedMeta> = {
  FOOD: { label: 'Food', Icon: SoupIcon, fill: 'bg-need-food', border: 'border-need-food' },
  TRANSPORTATION: {
    label: 'Transportation',
    Icon: CarIcon,
    fill: 'bg-need-transportation',
    border: 'border-need-transportation',
  },
  SHELTER: {
    label: 'Housing',
    Icon: HouseIcon,
    fill: 'bg-need-shelter',
    border: 'border-need-shelter',
  },
  PEER_SUPPORT: {
    label: 'Peer support',
    Icon: UsersIcon,
    fill: 'bg-need-peer',
    border: 'border-need-peer',
  },
};
