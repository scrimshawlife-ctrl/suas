/**
 * How often screens refetch on their own. Dependency-free so the e2e suite imports the same
 * numbers when it steps the fake clock past one poll.
 */

/** Unread numbers stay fresh on any screen: refetch about every minute while the tab is visible. */
export const UNREAD_REFETCH_MS = 60_000;

/** Detail polling while a request is open: "every ~15 s" (sprint 2 brief). */
export const REQUEST_POLL_MS = 15_000;

/** The open board refreshes about every 30 seconds so taken requests drop off. */
export const BOARD_REFRESH_MS = 30_000;

/** The same 30 s the Serve Alerts card polls this endpoint at, so a new notice shows unprompted. */
export const NOTIFICATION_REFRESH_MS = 30_000;
