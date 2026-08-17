// Score formatting the golf hub's boards had all agreed on by copying each
// other: `fmtToPar` existed verbatim in `GolfDaily`, `GolfTournaments` and
// `GolfProfile`, and `MEDALS` in those first two plus `GolfLeaderboard`. Four
// copies of a colour triple is how one board eventually gets a different bronze,
// and each copy carried its own comment explaining that it was a copy.
//
// Pure: no api, no state, no `three`, no randomness.

/**
 * Medal colours for the top three — gold / silver / bronze. Literal values, not
 * CSS variables, deliberately: the boards render both INSIDE the `.golf-hub`
 * layer and on the standalone results screens, which are not wrapped in it.
 */
export const MEDALS = ['#C9A227', '#9AA0A6', '#B0763A'];

/**
 * ± to-par label: null/undefined → "—", 0 → "E", otherwise "+n" / "−n" with a
 * true minus sign (U+2212), which is what lines up under tabular numerals.
 */
export function fmtToPar(n: number | null | undefined): string {
  if (n == null) return '—';
  if (n === 0) return 'E';
  return n > 0 ? `+${n}` : `−${Math.abs(n)}`;
}
