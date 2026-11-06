import type { AnchorHTMLAttributes, ButtonHTMLAttributes, MouseEvent, ReactNode } from 'react';
import { Link } from 'react-router';
import { cn } from '../lib/cn';
import { PhoneIcon } from './icons';

export type ButtonVariant =
  | 'primary'
  | 'secondary'
  | 'sos'
  | 'disabled'
  | 'peer'
  | 'teal'
  | 'onHarborOutline'
  | 'onHarborWhite'
  | 'ghost'
  | 'icon';

/** `default` is 52 px, `form` 56 px, `small` 44 px (the minimum target). */
export type ButtonSize = 'default' | 'form' | 'small';

const base =
  'inline-flex items-center justify-center gap-2.5 rounded-8 border-2 font-bold no-underline select-none';

const variants: Record<ButtonVariant, string> = {
  primary: 'border-transparent bg-service-blue text-white hover:bg-harbor hover:text-white',
  secondary: 'bg-white text-ink border-ink hover:bg-mist hover:text-ink',
  // SOS red is the crisis entry only. The white edge keeps it distinct on Harbor.
  sos: 'bg-sos text-white border-white hover:text-white hover:underline hover:underline-offset-4',
  disabled: 'bg-mist text-slate border-line cursor-not-allowed',
  peer: 'border-transparent bg-white text-ink font-display text-26 min-h-18 px-9 gap-3.5 hover:bg-mist hover:text-ink max-sm:min-h-16.5 max-sm:w-full max-sm:px-5 max-sm:text-24',
  // Peer Support teal marks QRF and the "Request essentials" button.
  teal: 'border-transparent bg-need-peer text-white hover:bg-harbor hover:text-white',
  onHarborOutline: 'bg-transparent text-white border-white hover:bg-service-blue hover:text-white',
  onHarborWhite: 'border-transparent bg-white text-ink hover:bg-mist hover:text-ink',
  ghost: 'border-transparent bg-transparent text-ink hover:bg-mist hover:text-ink',
  icon: 'border-transparent bg-transparent text-ink min-h-11 min-w-11 p-0 hover:bg-mist hover:text-ink',
};

const sizes: Record<ButtonSize, string> = {
  default: 'min-h-13 px-5.5 text-18',
  form: 'min-h-14 px-6 text-18',
  small: 'min-h-11 px-4.5 text-17',
};

interface CommonProps {
  size?: ButtonSize;
  /** Leading icon. The `sos` variant always gets the phone icon. */
  icon?: ReactNode;
  className?: string;
  children?: ReactNode;
}

type VariantProps =
  { variant?: Exclude<ButtonVariant, 'icon'> } | { variant: 'icon'; 'aria-label': string };

type ButtonElementProps = Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'children' | 'className'
> & {
  href?: undefined;
};
type LinkElementProps = Omit<
  AnchorHTMLAttributes<HTMLAnchorElement>,
  'children' | 'className' | 'href'
> & {
  /** Internal paths (start with "/") use the router; tel:, sms: and absolute URLs use a plain anchor. */
  href: string;
  disabled?: boolean;
};

type Flat = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'className'> &
  Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'children' | 'className' | 'href' | 'onClick'> & {
    href?: string;
    disabled?: boolean;
  };

export type ButtonProps = CommonProps & VariantProps & (ButtonElementProps | LinkElementProps);

function isInternal(href: string): boolean {
  return href.startsWith('/') && !href.startsWith('//');
}

/**
 * The one button. Pass `href` to render a link ("as link"); otherwise it is a `<button>`.
 * Disabled buttons keep focus and use `aria-disabled` (the board's "Unavailable" button).
 */
export function Button(props: ButtonProps) {
  const { variant = 'primary', size = 'default', icon, className, children, ...rest } = props;
  const { href, disabled, onClick, ...element } = rest as Flat;
  const isDisabled = disabled === true || variant === 'disabled';
  const shown: ButtonVariant = isDisabled ? 'disabled' : variant;
  const classes = cn(
    base,
    variants[shown],
    variant === 'icon' || variant === 'peer' ? undefined : sizes[size],
    className,
  );
  const glyph = variant === 'sos' ? <PhoneIcon /> : icon;
  const content = (
    <>
      {glyph}
      {children}
    </>
  );

  if (href !== undefined) {
    if (isDisabled) {
      return (
        <span className={classes} aria-disabled="true">
          {content}
        </span>
      );
    }
    const anchor = element as AnchorHTMLAttributes<HTMLAnchorElement>;
    return isInternal(href) ? (
      <Link to={href} className={classes} {...anchor}>
        {content}
      </Link>
    ) : (
      <a href={href} className={classes} {...anchor}>
        {content}
      </a>
    );
  }

  const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
    if (isDisabled) event.preventDefault();
    else onClick?.(event);
  };
  const { type = 'button', ...buttonProps } = element as ButtonHTMLAttributes<HTMLButtonElement>;
  return (
    <button
      type={type}
      className={cn(classes, !isDisabled && 'cursor-pointer')}
      aria-disabled={isDisabled ? true : undefined}
      onClick={handleClick}
      {...buttonProps}
    >
      {content}
    </button>
  );
}
