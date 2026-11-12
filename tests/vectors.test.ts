import { describe, it, expect } from 'vitest';
import { cosine, normalize, quantize } from '../src/vectors';

/** Deterministic pseudo-random vector (mulberry32), roughly like a model embedding. */
function randomVector(dim: number, seed: number): Float32Array {
    let t = seed;
    const rand = () => {
        t = (t + 0x6d2b79f5) | 0;
        let r = Math.imul(t ^ (t >>> 15), 1 | t);
        r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
        return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };
    return Float32Array.from({ length: dim }, () => rand() * 2 - 1);
}

const exactCosine = (a: Float32Array, b: Float32Array) => {
    const ua = normalize(a), ub = normalize(b);
    return ua.reduce((s, x, i) => s + x * ub[i], 0);
};

describe('normalize', () => {
    it('produces a unit vector and leaves a zero vector at zero', () => {
        const u = normalize([3, 4]);
        expect(u[0]).toBeCloseTo(0.6);
        expect(u[1]).toBeCloseTo(0.8);
        expect(Array.from(normalize([0, 0]))).toEqual([0, 0]);
    });
});

describe('quantize', () => {
    it('uses the full int8 range for the largest component', () => {
        const { q } = quantize(randomVector(768, 1));
        expect(Math.max(...Array.from(q, Math.abs))).toBe(127);
    });

    it('is scale-invariant (normalises first)', () => {
        const v = randomVector(64, 2);
        const a = quantize(v), b = quantize(v.map((x) => x * 1000));
        expect(Array.from(a.q)).toEqual(Array.from(b.q));
        expect(a.scale).toBeCloseTo(b.scale, 12);
    });

    it('approximates cosine similarity much better than fixed x127 scaling', () => {
        const dim = 768;
        let perVectorErr = 0, fixedErr = 0;
        for (let i = 0; i < 50; i++) {
            const a = randomVector(dim, 100 + i), b = randomVector(dim, 200 + i);
            const exact = exactCosine(a, b);
            perVectorErr = Math.max(perVectorErr, Math.abs(cosine(normalize(a), quantize(b)) - exact));
            // v1's scheme: round(unit * 127), cosine computed from the int8 values alone
            const fixedA = Array.from(normalize(a), (x) => Math.round(x * 127));
            const fixedB = Array.from(normalize(b), (x) => Math.round(x * 127));
            const dot = fixedA.reduce((s, x, k) => s + x * fixedB[k], 0);
            const norm = Math.sqrt(fixedA.reduce((s, x) => s + x * x, 0) * fixedB.reduce((s, x) => s + x * x, 0));
            fixedErr = Math.max(fixedErr, Math.abs(dot / norm - exact));
        }
        expect(perVectorErr).toBeLessThan(0.01);
        expect(perVectorErr).toBeLessThan(fixedErr / 3);
    });
});

describe('cosine', () => {
    it('is ~1 for the same direction and ~-1 for the opposite', () => {
        const v = randomVector(384, 3);
        expect(cosine(normalize(v), quantize(v))).toBeCloseTo(1, 2);
        expect(cosine(normalize(v.map((x) => -x)), quantize(v))).toBeCloseTo(-1, 2);
    });
});
