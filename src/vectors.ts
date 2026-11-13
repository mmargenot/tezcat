/**
 * An int8-quantised unit vector with its own scale: value[i] ≈ q[i] * scale.
 *
 * Scaling each vector by its largest component keeps ~8 bits of precision. Multiplying
 * every component by a fixed 127 (as v1 did) maps a 768-d unit vector's components,
 * which are around ±0.04, to roughly ±5: about 3 bits.
 */
export interface QVec {
	q: Int8Array;
	scale: number;
}

export function normalize(v: ArrayLike<number>): Float32Array {
	let norm = 0;
	for (let i = 0; i < v.length; i++) norm += v[i] * v[i];
	norm = Math.sqrt(norm) || 1;
	const out = new Float32Array(v.length);
	for (let i = 0; i < v.length; i++) out[i] = v[i] / norm;
	return out;
}

/** Normalise to unit length, then quantise to int8 with a per-vector scale. */
export function quantize(v: ArrayLike<number>): QVec {
	const unit = normalize(v);
	let maxAbs = 0;
	for (let i = 0; i < unit.length; i++) maxAbs = Math.max(maxAbs, Math.abs(unit[i]));
	const scale = maxAbs / 127 || 1;
	const q = new Int8Array(unit.length);
	for (let i = 0; i < unit.length; i++) q[i] = Math.round(unit[i] / scale);
	return { q, scale };
}

/** Cosine similarity between a unit-length float query and a quantised unit vector. */
export function cosine(query: Float32Array, v: QVec): number {
	const q = v.q;
	let dot = 0;
	for (let i = 0; i < q.length; i++) dot += query[i] * q[i];
	return dot * v.scale;
}
