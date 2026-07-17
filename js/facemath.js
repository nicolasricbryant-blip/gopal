// facemath.js — pure landmark math shared by detector.js and the test suite.
// No DOM/MediaPipe dependency so it can be unit tested directly under Node.

// Landmark index groups per PLAN.md.
export const LEFT_EYE = [33, 160, 158, 133, 153, 144];   // p1..p6
export const RIGHT_EYE = [362, 385, 387, 263, 373, 380]; // p1..p6
export const MOUTH = { upper: 13, lower: 14, leftCorner: 78, rightCorner: 308 };

export function dist(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

export function computeEAR(lm, idx) {
  const [p1, p2, p3, p4, p5, p6] = idx.map((i) => lm[i]);
  return (dist(p2, p6) + dist(p3, p5)) / (2 * dist(p1, p4));
}

export function computeMAR(lm) {
  const upper = lm[MOUTH.upper];
  const lower = lm[MOUTH.lower];
  const left = lm[MOUTH.leftCorner];
  const right = lm[MOUTH.rightCorner];
  return dist(upper, lower) / dist(left, right);
}
