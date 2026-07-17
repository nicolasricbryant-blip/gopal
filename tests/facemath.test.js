// facemath.test.js — EAR/MAR on hand-computed landmark fixtures.

import { describe, it, expect } from 'vitest';
import { dist, computeEAR, computeMAR, LEFT_EYE, RIGHT_EYE, MOUTH } from '../js/facemath.js';

describe('dist', () => {
  it('computes euclidean distance', () => {
    expect(dist({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
  });
});

describe('computeEAR', () => {
  it('computes 1.0 for a symmetric eye whose vertical spans equal its width', () => {
    // p1..p6 (LEFT_EYE order): left corner, top-left, top-right, right corner, bottom-right, bottom-left.
    const lm = {};
    lm[LEFT_EYE[0]] = { x: 0, y: 0 };  // p1 left corner
    lm[LEFT_EYE[1]] = { x: 1, y: 2 };  // p2 top-left
    lm[LEFT_EYE[2]] = { x: 3, y: 2 };  // p3 top-right
    lm[LEFT_EYE[3]] = { x: 4, y: 0 };  // p4 right corner
    lm[LEFT_EYE[4]] = { x: 3, y: -2 }; // p5 bottom-right
    lm[LEFT_EYE[5]] = { x: 1, y: -2 }; // p6 bottom-left
    // dist(p2,p6) = 4, dist(p3,p5) = 4, dist(p1,p4) = 4 -> (4+4)/(2*4) = 1.0
    expect(computeEAR(lm, LEFT_EYE)).toBeCloseTo(1.0, 10);
  });

  it('computes 0.5 for an eye half as tall as it is wide', () => {
    const lm = {};
    lm[RIGHT_EYE[0]] = { x: 0, y: 0 };
    lm[RIGHT_EYE[1]] = { x: 1, y: 1 };
    lm[RIGHT_EYE[2]] = { x: 3, y: 1 };
    lm[RIGHT_EYE[3]] = { x: 4, y: 0 };
    lm[RIGHT_EYE[4]] = { x: 3, y: -1 };
    lm[RIGHT_EYE[5]] = { x: 1, y: -1 };
    // dist(p2,p6) = 2, dist(p3,p5) = 2, dist(p1,p4) = 4 -> (2+2)/(2*4) = 0.5
    expect(computeEAR(lm, RIGHT_EYE)).toBeCloseTo(0.5, 10);
  });
});

describe('computeMAR', () => {
  it('computes the mouth-opening ratio from vertical / horizontal spans', () => {
    const lm = {};
    lm[MOUTH.upper] = { x: 2, y: 1 };
    lm[MOUTH.lower] = { x: 2, y: -1 };
    lm[MOUTH.leftCorner] = { x: 0, y: 0 };
    lm[MOUTH.rightCorner] = { x: 4, y: 0 };
    // dist(upper,lower) = 2, dist(left,right) = 4 -> 2/4 = 0.5
    expect(computeMAR(lm)).toBeCloseTo(0.5, 10);
  });

  it('returns 0 for a fully closed mouth', () => {
    const lm = {};
    lm[MOUTH.upper] = { x: 2, y: 0 };
    lm[MOUTH.lower] = { x: 2, y: 0 };
    lm[MOUTH.leftCorner] = { x: 0, y: 0 };
    lm[MOUTH.rightCorner] = { x: 4, y: 0 };
    expect(computeMAR(lm)).toBe(0);
  });
});
