// Particle Field — Adaptive Baseline detector.
// Separates person motion from pattern motion by building a rolling average of
// "normal" motion (~1 s window). Sudden spikes above baseline = people.

import { AdaptiveBaselineDetector } from "../motionDetector";
import { makeParticleFieldPattern } from "../particleFieldBase";

export const particleFieldBaseline = makeParticleFieldPattern(
  "particleFieldBaseline",
  "Particle Field · Baseline",
  () => new AdaptiveBaselineDetector(),
);
