/** Schedules canvas repaints for texture-backed 2D patterns: repaints every
 *  dirty frame while cheap, and throttles adaptively — based on the LAST
 *  measured repaint cost — once a repaint proves expensive, instead of a
 *  fixed wall-clock interval that stutters the same whether the scene is
 *  light or heavy. Also caps how much motion-time a single repaint can
 *  "catch up" on, so a throttled period never produces one oversized jump. */
export function createRepaintScheduler() {
  let accum = 0;
  let lastCostMs = 0;
  const BUDGET_MS = 6;         // repaint should cost at most ~1 frame's worth
  const DUTY_CYCLE = 4;        // once over budget, cap its CPU share at ~1/4
  const MAX_INTERVAL = 1 / 10; // hard ceiling: never withhold a repaint past 100ms
  const MAX_STEP = 1 / 30;     // cap the motion-time a single repaint catches up on

  return {
    /** Call once per rAF frame with this frame's dt. Returns true iff
     *  repaint() should run now. */
    shouldRepaint(dt: number, dirty: boolean): boolean {
      if (!dirty) { accum = 0; return false; }
      accum += dt;
      const required = lastCostMs <= BUDGET_MS
        ? 0
        : Math.min(MAX_INTERVAL, (lastCostMs / 1000) * DUTY_CYCLE);
      return accum >= required;
    },
    /** Real elapsed time (seconds) to advance motion by for the repaint
     *  that's about to happen, capped so a throttled catch-up never
     *  produces an oversized single jump. Resets the accumulator. */
    consumeStep(): number {
      const step = Math.min(accum, MAX_STEP);
      accum = 0;
      return step;
    },
    /** Call right after repaint() with its performance.now() cost in ms. */
    reportCost(ms: number) { lastCostMs = ms; },
  };
}
