export type VaState =
  | "IDLE"
  | "ACCUMULATING"
  | "THINKING"
  | "SPEAKING"
  | "COOLDOWN";

export function canAccept(state: VaState): boolean {
  return state === "IDLE";
}

export function suppressesAction(state: VaState): boolean {
  // During SPEAKING and COOLDOWN, do not act on incoming captions (no new
  // wake-word capture). They can still be observed for meeting memory.
  return state === "SPEAKING" || state === "COOLDOWN";
}
