import { AppHeader, type AppHeaderProps } from './AppHeader';

/** Light header for Need support mode: Home and Chat, mode switch, avatar menu. */
export function VeteranHeader(props: Omit<AppHeaderProps, 'mode'>) {
  return <AppHeader {...props} mode="support" />;
}
