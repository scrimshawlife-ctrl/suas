import { AppHeader, type AppHeaderProps } from './AppHeader';

/** Harbor header for Serve mode, so the person always knows which side they are on. */
export function ServeHeader(props: Omit<AppHeaderProps, 'mode'>) {
  return <AppHeader {...props} mode="serve" />;
}
