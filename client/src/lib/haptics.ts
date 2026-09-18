/**
 * A kick from the phone's own vibrator.
 *
 * In a pub you often cannot hear a tap land and you are not always looking at
 * the screen, so buzzing and scoring get a physical acknowledgement wherever
 * the browser offers one. iOS Safari does not implement this at all, which is
 * why every call is optional and every one of them is paired with a visible
 * change on screen.
 */
export function vibrate(pattern: number | number[]): void {
  try {
    navigator.vibrate?.(pattern);
  } catch {
    // Some browsers throw instead of returning false. Nothing to do either way.
  }
}

/** Your tap on BUZZ! registered locally — not yet that you got in first. */
export const TAP = 18;

/** The floor is yours: long enough to feel through a pocket or a table. */
export const YOUR_TURN = [0, 70, 55, 70];

/** The question master pressed +1, 0 or -1. */
export const JUDGED = 14;
