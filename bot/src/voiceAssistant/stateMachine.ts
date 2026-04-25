export type VaState =
  | "IDLE"
  | "ACCUMULATING"
  | "THINKING"
  | "SPEAKING"
  | "COOLDOWN";

export function canAccept(state: VaState): boolean {
  return state === "IDLE";
}

export function suppressesCaptions(state: VaState): boolean {
  // During SPEAKING and COOLDOWN, ignore ALL incoming captions — not just
  // ones attributed to the bot — because Meet's caption carry-forward can
  // mis-attribute the bot's own voice to a human speaker.
  return state === "SPEAKING" || state === "COOLDOWN";
}
