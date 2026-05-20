// PIN rendering: always mono, uppercase, formatted as XXXX·XXXX.

export function formatPin(pin: string): string {
  const clean = pin.replace(/[^0-9A-Za-z]/g, '').toUpperCase();
  if (clean.length !== 8) return clean;
  return `${clean.slice(0, 4)}·${clean.slice(4)}`;
}

export function stripPin(s: string): string {
  return s.replace(/[^0-9A-Za-z]/g, '').toUpperCase();
}
