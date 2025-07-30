/**
 * Tests for vector processing utilities
 * Run with: npm test
 */

import { describe, it, expect } from 'vitest';
import { VectorUtils } from '../src/embedding_service';

describe('VectorUtils', () => {
    describe('L2 normalization', () => {
        it('creates unit vector', () => {
            const vector = [3, 4, 0]; // Magnitude = 5
            const normalized = VectorUtils.l2Normalize(vector);
            
            // Check magnitude is 1
            const magnitude = Math.sqrt(normalized.reduce((sum, val) => sum + val * val, 0));
            expect(magnitude).toBeCloseTo(1.0, 10);
            
            // Check values are correct
            expect(normalized).toEqual([0.6, 0.8, 0]);
        });

        it('handles zero vector', () => {
            const vector = [0, 0, 0];
            const normalized = VectorUtils.l2Normalize(vector);
            
            expect(normalized).toEqual([0, 0, 0]);
        });

        it('preserves direction', () => {
            const vector = [1, 2, 3];
            const normalized = VectorUtils.l2Normalize(vector);
            
            // All ratios should be preserved
            const ratio1 = normalized[1] / normalized[0];
            const ratio2 = normalized[2] / normalized[0];
            
            expect(ratio1).toBeCloseTo(2, 10);
            expect(ratio2).toBeCloseTo(3, 10);
        });
    });

    describe('Int8 quantization', () => {
        it('maps [-1, 1] to [-127, 127]', () => {
            const vector = [-1, -0.5, 0, 0.5, 1];
            const quantized = VectorUtils.quantizeToInt8(vector);
            
            expect(quantized).toBeInstanceOf(Int8Array);
            expect(quantized.length).toBe(5);
            
            // Check specific mappings
            expect(quantized[0]).toBe(-127);
            expect(quantized[1]).toBe(-63); // Math.round(-0.5 * 127) = -63
            expect(quantized[2]).toBe(0);
            expect(quantized[3]).toBe(64); // Math.round(0.5 * 127) = 64
            expect(quantized[4]).toBe(127);
        });

        it('clamps out-of-range values', () => {
            const vector = [-2, -1.5, 1.5, 2];
            const quantized = VectorUtils.quantizeToInt8(vector);
            
            expect(quantized[0]).toBe(-127);
            expect(quantized[1]).toBe(-127);
            expect(quantized[2]).toBe(127);
            expect(quantized[3]).toBe(127);
        });
    });


    describe('Complete processing pipeline', () => {
        it('processes vector correctly', () => {
            const vector = [3, 4, 5]; // Not normalized
            const processed = VectorUtils.processVector(vector);
            
            expect(processed).toBeInstanceOf(Int8Array);
            expect(processed.length).toBe(3);
            
            // Verify the vector was normalized then quantized
            const normalized = VectorUtils.l2Normalize(vector);
            const expectedQuantized = VectorUtils.quantizeToInt8(normalized);
            
            for (let i = 0; i < processed.length; i++) {
                expect(processed[i]).toBe(expectedQuantized[i]);
            }
        });

        it('handles realistic 768-dim vector', () => {
            // Generate a realistic-looking embedding vector (random values around [-1, 1])
            const originalVector = Array.from({ length: 768 }, () => (Math.random() - 0.5) * 2);
            
            // Process: normalize + quantize
            const processed = VectorUtils.processVector(originalVector);
            
            // Verify it's quantized correctly
            expect(processed).toBeInstanceOf(Int8Array);
            expect(processed.length).toBe(768);
            expect(processed.every(val => val >= -128 && val <= 127)).toBe(true);
            
            // Verify the processing pipeline works correctly
            expect(processed.every(val => val >= -128 && val <= 127)).toBe(true);
        });
    });

    describe('BLOB storage compatibility', () => {
        it('preserves data through Int8Array to Uint8Array conversion', () => {
            const vector = [-128, -1, 0, 1, 127];
            const int8Array = new Int8Array(vector);
            
            // Simulate what the database service does
            const uint8Array = new Uint8Array(int8Array);
            
            // Convert back
            const restored = new Int8Array(uint8Array);
            
            // Should be identical
            for (let i = 0; i < vector.length; i++) {
                expect(restored[i]).toBe(int8Array[i]);
            }
        });
    });
});