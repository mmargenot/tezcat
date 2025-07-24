/**
 * Tests for SearchService cosine similarity calculation
 * Uses COMPLETELY MOCKED dependencies - NO REAL DATABASE OR EXTERNAL DEPENDENCIES
 * Run with: npm test
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SearchService } from '../src/search_service';

// Mock logger
const mockLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    setLevel: vi.fn()
};

// Mock database service with minimal interface
const mockDatabaseService = {
    adapter: {
        getLSHConfig: vi.fn().mockResolvedValue(null)
    },
    isVectorIndexAvailable: vi.fn().mockResolvedValue(false)
};

// Mock embedding service
const mockEmbeddingService = {
    embedText: vi.fn(),
    embedTexts: vi.fn(),
    embeddingProvider: {
        embed_one: vi.fn(),
        embed_many: vi.fn(),
        validate: vi.fn()
    }
};

describe('SearchService', () => {
    let searchService: SearchService;

    beforeEach(() => {
        vi.clearAllMocks();
        searchService = new SearchService(
            mockDatabaseService as any,
            mockEmbeddingService as any,
            mockLogger as any
        );
    });

    describe('cosine similarity calculation', () => {
        it('calculates perfect similarity for identical vectors', () => {
            const vector1 = new Int8Array([127, 64, -32]);
            const vector2 = new Int8Array([127, 64, -32]);
            
            // Access private method for testing
            const similarity = (searchService as any).calculateCosineSimilarity(vector1, vector2);
            
            expect(similarity).toBeCloseTo(1.0, 5);
        });

        it('calculates similarity for orthogonal vectors', () => {
            const vector1 = new Int8Array([127, 0, 0]);
            const vector2 = new Int8Array([0, 127, 0]);
            
            const similarity = (searchService as any).calculateCosineSimilarity(vector1, vector2);
            
            // SearchService normalizes cosine similarity to 0-1 range using (cosineSim + 1) / 2
            // For orthogonal vectors, cosineSim = 0, so result = (0 + 1) / 2 = 0.5
            expect(similarity).toBeCloseTo(0.5, 5);
        });

        it('calculates similarity for opposite vectors', () => {
            const vector1 = new Int8Array([127, 64]);
            const vector2 = new Int8Array([-127, -64]);
            
            const similarity = (searchService as any).calculateCosineSimilarity(vector1, vector2);
            
            // For opposite vectors, cosineSim = -1, so result = (-1 + 1) / 2 = 0
            expect(similarity).toBeCloseTo(0.0, 5);
        });

        it('handles zero vectors gracefully', () => {
            const vector1 = new Int8Array([0, 0, 0]);
            const vector2 = new Int8Array([127, 64, -32]);
            
            const similarity = (searchService as any).calculateCosineSimilarity(vector1, vector2);
            
            expect(similarity).toBe(0);
        });

        it('throws error for vectors of different lengths', () => {
            const vector1 = new Int8Array([1, 2, 3]);
            const vector2 = new Int8Array([1, 2]);
            
            expect(() => {
                (searchService as any).calculateCosineSimilarity(vector1, vector2);
            }).toThrow('Vector dimension mismatch: 3 vs 2');
        });

        it('handles various vector combinations correctly', () => {
            // Test with realistic embeddings-like values
            const vector1 = new Int8Array([100, -50, 25, -10]);
            const vector2 = new Int8Array([80, -40, 20, -8]);
            
            const similarity = (searchService as any).calculateCosineSimilarity(vector1, vector2);
            
            // These are similar vectors, should have high similarity (close to 1.0)
            expect(similarity).toBeGreaterThan(0.8);
            expect(similarity).toBeLessThanOrEqual(1.0);
        });

        it('similarity calculation is symmetric', () => {
            const vector1 = new Int8Array([50, -25, 100]);
            const vector2 = new Int8Array([30, -15, 60]);
            
            const similarity1 = (searchService as any).calculateCosineSimilarity(vector1, vector2);
            const similarity2 = (searchService as any).calculateCosineSimilarity(vector2, vector1);
            
            expect(similarity1).toBeCloseTo(similarity2, 10);
        });

        it('handles edge case with maximum and minimum values', () => {
            const vector1 = new Int8Array([127, 127, 127]);
            const vector2 = new Int8Array([-128, -128, -128]);
            
            const similarity = (searchService as any).calculateCosineSimilarity(vector1, vector2);
            
            // Complete opposites should give minimum similarity (0)
            expect(similarity).toBeCloseTo(0.0, 5);
        });
    });

    describe('initialization', () => {
        it('creates SearchService instance with mocked dependencies', () => {
            expect(searchService).toBeDefined();
            expect(searchService).toBeInstanceOf(SearchService);
        });

        it('has access to vector index availability check', async () => {
            // Test that the private method exists and can be called
            const isAvailable = await (searchService as any).isVectorIndexAvailable();
            
            // Should return false with our mocked database
            expect(isAvailable).toBe(false);
            expect(mockDatabaseService.isVectorIndexAvailable).toHaveBeenCalled();
        });
    });
});