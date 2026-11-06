/** "Good morning/afternoon/evening, {first name}." by the viewer's local time. */
export function greeting(displayName: string | null | undefined, now: Date = new Date()): string {
  const hour = now.getHours();
  const part = hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening';
  const first = displayName?.trim().split(/\s+/)[0] ?? '';
  return first === '' ? `Good ${part}.` : `Good ${part}, ${first}.`;
}
