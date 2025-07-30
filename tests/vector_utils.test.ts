/**
 * Comprehensive tests for VectorUtils class focusing on LSH functionality
 * Uses COMPLETELY MOCKED components - NO REAL DATABASE OR EXTERNAL DEPENDENCIES
 * Run with: npm test
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { VectorUtils, LSHHashFunction } from '../src/embedding_service';

// Mock logger to prevent any external dependencies
const mockLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    setLevel: vi.fn()
};

describe('VectorUtils LSH Functions', () => {
    let vectorUtils: VectorUtils;

    beforeEach(() => {
        // Clear all mocks before each test
        vi.clearAllMocks();
        vectorUtils = new VectorUtils(mockLogger as any);
    });

    describe('createHashFunctions', () => {
        it('creates correct number of hash functions', () => {
            const vectorCount = 100;
            const vectorDimensions = 768;
            
            const result = vectorUtils.createHashFunctions(vectorCount, vectorDimensions);
            
            // Number of hash functions should be ceil(log2(vectorCount))
            const expectedNumFunctions = Math.ceil(Math.log2(vectorCount)); // ceil(log2(100)) = 7
            expect(result.numHashFunctions).toBe(expectedNumFunctions);
            expect(result.hashFunctions).toHaveLength(expectedNumFunctions);
            
            // Verify logging calls
            expect(mockLogger.info).toHaveBeenCalledWith('VectorUtils', expect.stringContaining('Creating hash functions'));
        });

        it('creates hash functions with correct dimensions', () => {
            const vectorCount = 50;
            const vectorDimensions = 384;
            
            const result = vectorUtils.createHashFunctions(vectorCount, vectorDimensions);
            
            result.hashFunctions.forEach((hashFunction, index) => {
                expect(hashFunction.hashIndex).toBe(index);
                expect(hashFunction.projectionMatrix).toBeInstanceOf(Float32Array);
                expect(hashFunction.projectionMatrix.length).toBe(vectorDimensions);
                
                // Verify projection matrix contains reasonable values (should be normally distributed)
                const values = Array.from(hashFunction.projectionMatrix);
                const hasVariation = values.some(v => Math.abs(v) > 0.1);
                expect(hasVariation).toBe(true); // Should not be all zeros
            });
        });

        it('generates different projection matrices for each hash function', () => {
            const vectorCount = 10;
            const vectorDimensions = 100;
            
            const result = vectorUtils.createHashFunctions(vectorCount, vectorDimensions);
            
            // Each projection matrix should be different
            for (let i = 0; i < result.hashFunctions.length - 1; i++) {
                for (let j = i + 1; j < result.hashFunctions.length; j++) {
                    const matrix1 = result.hashFunctions[i].projectionMatrix;
                    const matrix2 = result.hashFunctions[j].projectionMatrix;
                    
                    // Matrices should be different (check first few values)
                    let isDifferent = false;
                    for (let k = 0; k < Math.min(10, vectorDimensions); k++) {
                        if (Math.abs(matrix1[k] - matrix2[k]) > 0.001) {
                            isDifferent = true;
                            break;
                        }
                    }
                    expect(isDifferent).toBe(true);
                }
            }
        });

        it('handles edge cases', () => {
            // Very small vector count
            const result1 = vectorUtils.createHashFunctions(1, 768);
            expect(result1.numHashFunctions).toBe(0); // ceil(log2(1)) = 0
            
            // Large vector count  
            const result2 = vectorUtils.createHashFunctions(10000, 768);
            expect(result2.numHashFunctions).toBe(14); // ceil(log2(10000)) = 14
        });
    });

    describe('computeHashVector', () => {
        it('computes hash vector with known projection matrices', () => {
            const vectorDimensions = 4;
            const vector = new Int8Array([100, -100, 50, -50]);
            
            // Create mock hash functions with predictable projection matrices
            const hashFunctions: LSHHashFunction[] = [
                {
                    id: 'mock1',
                    configId: 'mock_config',
                    hashIndex: 0,
                    projectionMatrix: new Float32Array([1, 0, 0, 0]), // dot product = 100 > 0 -> bit 1
                    createdAt: new Date()
                },
                {
                    id: 'mock2', 
                    configId: 'mock_config',
                    hashIndex: 1,
                    projectionMatrix: new Float32Array([0, 1, 0, 0]), // dot product = -100 < 0 -> bit 0
                    createdAt: new Date()
                },
                {
                    id: 'mock3',
                    configId: 'mock_config', 
                    hashIndex: 2,
                    projectionMatrix: new Float32Array([1, 1, 0, 0]), // dot product = 100 + (-100) = 0 -> bit 0
                    createdAt: new Date()
                }
            ];
            
            const result = vectorUtils.computeHashVector(vector, hashFunctions, vectorDimensions);
            
            expect(result).toEqual([1, 0, 0]);
        });

        it('handles all positive and negative cases', () => {
            const vectorDimensions = 3;
            const vector = new Int8Array([127, 64, -32]);
            
            const hashFunctions: LSHHashFunction[] = [
                {
                    id: 'mock1',
                    configId: 'mock_config',
                    hashIndex: 0,
                    projectionMatrix: new Float32Array([1, 1, 1]), // All positive weights
                    createdAt: new Date()
                },
                {
                    id: 'mock2',
                    configId: 'mock_config', 
                    hashIndex: 1,
                    projectionMatrix: new Float32Array([-1, -1, -1]), // All negative weights
                    createdAt: new Date()
                }
            ];
            
            const result = vectorUtils.computeHashVector(vector, hashFunctions, vectorDimensions);
            
            // First: 127*1 + 64*1 + (-32)*1 = 159 > 0 -> bit 1
            // Second: 127*(-1) + 64*(-1) + (-32)*(-1) = -127 - 64 + 32 = -159 < 0 -> bit 0
            expect(result).toEqual([1, 0]);
        });

        it('throws error for dimension mismatch', () => {
            const vector = new Int8Array([1, 2, 3]);
            const hashFunctions: LSHHashFunction[] = [
                {
                    id: 'mock1',
                    configId: 'mock_config',
                    hashIndex: 0,
                    projectionMatrix: new Float32Array([1, 0]), // Wrong dimension (2 instead of 3)
                    createdAt: new Date()
                }
            ];
            
            expect(() => {
                vectorUtils.computeHashVector(vector, hashFunctions, 3);
            }).toThrow('Vectors must have the same length');
        });

        it('throws error for no hash functions', () => {
            const vector = new Int8Array([1, 2, 3]);
            const hashFunctions: LSHHashFunction[] = [];
            
            expect(() => {
                vectorUtils.computeHashVector(vector, hashFunctions, 3);
            }).toThrow('No hash functions provided');
        });

        it('works with realistic 768-dimension vectors', () => {
            const vectorDimensions = 768;
            
            // Create a realistic vector with mocked data
            const vectorData = Array.from({ length: vectorDimensions }, (_, i) => 
                Math.floor(Math.sin(i * 0.1) * 127) // Deterministic but varied data
            );
            const vector = new Int8Array(vectorData);
            
            // Create hash functions using the tested method
            const { hashFunctions } = vectorUtils.createHashFunctions(100, vectorDimensions);
            
            // Convert to LSHHashFunction format (pure data transformation, no DB)
            const lshHashFunctions: LSHHashFunction[] = hashFunctions.map((hf, index) => ({
                id: `mock_hash_${index}`,
                configId: 'mock_test_config',
                hashIndex: hf.hashIndex,
                projectionMatrix: hf.projectionMatrix,
                createdAt: new Date()
            }));
            
            const result = vectorUtils.computeHashVector(vector, lshHashFunctions, vectorDimensions);
            
            expect(result).toHaveLength(lshHashFunctions.length);
            expect(result.every(bit => bit === 0 || bit === 1)).toBe(true);
            
            // Verify consistency - same input should give same output
            const result2 = vectorUtils.computeHashVector(vector, lshHashFunctions, vectorDimensions);
            expect(result2).toEqual(result);
        });
    });

    describe('hammingDistance', () => {
        it('calculates correct hamming distance', () => {
            const hash1 = [1, 0, 1, 0, 1];
            const hash2 = [1, 1, 1, 0, 0];
            
            const distance = VectorUtils.hammingDistance(hash1, hash2);
            
            // Differences at positions 1 and 4: distance = 2
            expect(distance).toBe(2);
        });

        it('returns 0 for identical hashes', () => {
            const hash1 = [1, 0, 1, 0, 1];
            const hash2 = [1, 0, 1, 0, 1];
            
            const distance = VectorUtils.hammingDistance(hash1, hash2);
            
            expect(distance).toBe(0);
        });

        it('returns max distance for completely different hashes', () => {
            const hash1 = [1, 1, 1, 1, 1];
            const hash2 = [0, 0, 0, 0, 0];
            
            const distance = VectorUtils.hammingDistance(hash1, hash2);
            
            expect(distance).toBe(5);
        });

        it('throws error for different length hashes', () => {
            const hash1 = [1, 0, 1];
            const hash2 = [1, 0, 1, 0];
            
            expect(() => {
                VectorUtils.hammingDistance(hash1, hash2);
            }).toThrow('Hash vectors must have the same length');
        });

        it('handles empty hashes', () => {
            const hash1: number[] = [];
            const hash2: number[] = [];
            
            const distance = VectorUtils.hammingDistance(hash1, hash2);
            
            expect(distance).toBe(0);
        });

        it('handles single bit hashes', () => {
            expect(VectorUtils.hammingDistance([0], [0])).toBe(0);
            expect(VectorUtils.hammingDistance([0], [1])).toBe(1);
            expect(VectorUtils.hammingDistance([1], [0])).toBe(1);
            expect(VectorUtils.hammingDistance([1], [1])).toBe(0);
        });
    });

    describe('Random projection properties', () => {
        it('generates vectors with normal distribution properties', () => {
            // Test statistical properties without external dependencies
            const numTests = 100;
            const dimensions = 50;
            
            const allValues: number[] = [];
            
            // Generate multiple hash function sets to collect projection matrix values
            for (let i = 0; i < numTests; i++) {
                const { hashFunctions } = vectorUtils.createHashFunctions(10, dimensions);
                const projectionMatrix = hashFunctions[0].projectionMatrix;
                
                // Collect first 10 values from each matrix
                for (let j = 0; j < Math.min(10, dimensions); j++) {
                    allValues.push(projectionMatrix[j]);
                }
            }
            
            // Basic statistical checks (mean should be close to 0)
            const mean = allValues.reduce((sum, val) => sum + val, 0) / allValues.length;
            expect(Math.abs(mean)).toBeLessThan(0.2); // Relaxed bound for test stability
            
            // Check that we have reasonable variation (not all zeros)
            const hasPositive = allValues.some(v => v > 0.1);
            const hasNegative = allValues.some(v => v < -0.1);
            expect(hasPositive).toBe(true);
            expect(hasNegative).toBe(true);
        });
    });

    describe('Integration tests (pure computation)', () => {
        it('complete LSH workflow produces deterministic results', () => {
            const vectorDimensions = 100;
            const vectorCount = 50;
            
            // Create hash functions (deterministic for same input)
            const { hashFunctions } = vectorUtils.createHashFunctions(vectorCount, vectorDimensions);
            
            // Convert to LSH format (pure data transformation)
            const lshHashFunctions: LSHHashFunction[] = hashFunctions.map((hf, index) => ({
                id: `test_hash_${index}`,
                configId: 'test_config',
                hashIndex: hf.hashIndex,
                projectionMatrix: hf.projectionMatrix,
                createdAt: new Date()
            }));
            
            // Create deterministic test vectors
            const vector1 = new Int8Array(Array.from({ length: vectorDimensions }, (_, i) => 
                Math.floor(Math.sin(i * 0.1) * 127)
            ));
            const vector2 = new Int8Array(Array.from({ length: vectorDimensions }, (_, i) => 
                Math.floor(Math.cos(i * 0.1) * 127)
            ));
            
            // Compute hash vectors
            const hash1 = vectorUtils.computeHashVector(vector1, lshHashFunctions, vectorDimensions);
            const hash2 = vectorUtils.computeHashVector(vector2, lshHashFunctions, vectorDimensions);
            
            // Calculate Hamming distance
            const distance = VectorUtils.hammingDistance(hash1, hash2);
            
            // Basic validity checks
            expect(distance).toBeGreaterThanOrEqual(0);
            expect(distance).toBeLessThanOrEqual(hash1.length);
            
            // Determinism check - same vector should always give same hash
            const hash1Again = vectorUtils.computeHashVector(vector1, lshHashFunctions, vectorDimensions);
            expect(hash1Again).toEqual(hash1);
            
            // Different vectors should generally give different hashes
            expect(hash1).not.toEqual(hash2);
        });

        it('bit distribution is reasonable for different inputs', () => {
            const vectorDimensions = 50;
            const { hashFunctions } = vectorUtils.createHashFunctions(10, vectorDimensions);
            
            const lshHashFunctions: LSHHashFunction[] = hashFunctions.map((hf, index) => ({
                id: `bit_test_${index}`,
                configId: 'bit_test_config', 
                hashIndex: hf.hashIndex,
                projectionMatrix: hf.projectionMatrix,
                createdAt: new Date()
            }));
            
            // Test multiple different vectors
            const hashResults: number[][] = [];
            for (let i = 0; i < 20; i++) {
                const vector = new Int8Array(Array.from({ length: vectorDimensions }, (_, j) => 
                    Math.floor(Math.sin((i + 1) * (j + 1) * 0.1) * 127)
                ));
                
                const hash = vectorUtils.computeHashVector(vector, lshHashFunctions, vectorDimensions);
                hashResults.push(hash);
            }
            
            // Check that we get reasonable bit distribution across different inputs
            const numHashFunctions = hashResults[0].length;
            for (let bitPos = 0; bitPos < numHashFunctions; bitPos++) {
                const onesCount = hashResults.reduce((count, hash) => count + hash[bitPos], 0);
                const zerosCount = hashResults.length - onesCount;
                
                // Both 0s and 1s should appear (not all one value)
                expect(onesCount).toBeGreaterThan(0);
                expect(zerosCount).toBeGreaterThan(0);
            }
        });
    });

    describe('Error handling and edge cases', () => {
        it('handles extreme vector values correctly', () => {
            const vectorDimensions = 5;
            
            // Test with extreme values
            const extremeVector = new Int8Array([127, -128, 127, -128, 0]);
            const { hashFunctions } = vectorUtils.createHashFunctions(10, vectorDimensions);
            
            const lshHashFunctions: LSHHashFunction[] = hashFunctions.map((hf, index) => ({
                id: `extreme_test_${index}`,
                configId: 'extreme_test_config',
                hashIndex: hf.hashIndex,
                projectionMatrix: hf.projectionMatrix,
                createdAt: new Date()
            }));
            
            // Should not throw error
            expect(() => {
                const result = vectorUtils.computeHashVector(extremeVector, lshHashFunctions, vectorDimensions);
                expect(result.every(bit => bit === 0 || bit === 1)).toBe(true);
            }).not.toThrow();
        });

        it('validates input parameters correctly', () => {
            // Test with invalid vector count
            expect(() => {
                vectorUtils.createHashFunctions(0, 100);
            }).not.toThrow(); // Should handle gracefully
            
            // Test with zero dimensions
            expect(() => {
                vectorUtils.createHashFunctions(10, 0);
            }).not.toThrow(); // Should handle gracefully
        });
    });
});