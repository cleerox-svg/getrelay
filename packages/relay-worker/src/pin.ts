const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function generatePin(length = 8): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < length; i++) {
    out += ALPHABET[bytes[i]! % ALPHABET.length];
  }
  return out;
}

export function formatPin(pin: string): string {
  if (pin.length !== 8) return pin;
  return `${pin.slice(0, 4)}·${pin.slice(4)}`;
}

export function normalizePin(input: string): string {
  return input.replace(/[·\s-]/g, '').toUpperCase();
}
