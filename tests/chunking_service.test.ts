/**
 * Tests for chunking service functionality
 * Uses mocked tiktoken encoder to avoid memory issues
 */

import { vi } from 'vitest';

// Mock tiktoken BEFORE any imports - this must be hoisted
vi.mock('tiktoken', () => ({
  get_encoding: () => ({
    encode: (text: string) => {
      console.log('MOCK: encoding', text);
      if (!text) return [];
      return text.split(/\s+/).filter(word => word.length > 0).map((_, i) => i);
    },
    decode: (tokens: number[]) => {
      console.log('MOCK: decoding', tokens);
      return tokens.map(i => `word${i}`).join(' ');
    },
    free: () => {
      console.log('MOCK: freeing encoder');
    }
  })
}));

import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { ChunkingService } from '../src/chunking_service';
import { logger } from '../src/logger';

// Mock encoder for all tests
const createMockEncoder = () => ({
    encode: (text: string) => {
        if (!text) return [];
        const words = text.split(/\s+/).filter(word => word.length > 0);
        // Create realistic token count - don't limit for this test
        return words.map((_, i) => i);
    },
    decode: (tokens: number[]) => {
        // Create realistic text that varies based on tokens
        if (tokens.length === 0) return '';
        const baseText = tokens.map(i => `word${i}`).join(' ');
        // Keep it reasonably short to prevent memory issues
        return baseText.length > 100 ? baseText.substring(0, 100) + '...' : baseText;
    },
    free: () => {
        // No-op for tests
    }
});

// Mock plugin for testing
const mockPlugin = {
    app: {
        vault: {
            adapter: {
                readBinary: vi.fn()
            }
        }
    }
} as any;

// Helper to create patched ChunkingService
const createMockedChunkingService = (chunkSize: number, overlap: number) => {
    const service = new ChunkingService(chunkSize, overlap, mockPlugin, logger);
    (service as any).ensureEncoder = async () => {
        (service as any).encoder = createMockEncoder();
    };
    return service;
};

describe('ChunkingService', () => {
    let chunkingService: ChunkingService;

    beforeEach(() => {
        chunkingService = createMockedChunkingService(5, 2); // 5 tokens per chunk, 2 token overlap
    });

    afterEach(() => {
        chunkingService.dispose();
    });

    describe('Basic chunking functionality', () => {
        it('creates single chunk for very short text', async () => {
            const shortText = 'Hello world';
            
            const chunks = await chunkingService.chunkText(shortText);
            
            expect(chunks).toHaveLength(1);
            expect(chunks[0].text).toBe(shortText);
            expect(chunks[0].startIndex).toBe(0);
            expect(chunks[0].endIndex).toBe(shortText.length);
            expect(chunks[0].tokenCount).toBeGreaterThan(0);
        });

        it('handles empty text gracefully', async () => {
            const chunks = await chunkingService.chunkText('');
            
            expect(chunks).toHaveLength(1);
            expect(chunks[0].text).toBe('');
            expect(chunks[0].startIndex).toBe(0);
            expect(chunks[0].endIndex).toBe(0);
        });

        it('creates multiple chunks for longer text', async () => {
            // Create text that should definitely exceed our 5-token limit
            const longText = 'This is a much longer piece of text that should definitely be split into multiple chunks because it contains many more words than our token limit allows for a single chunk.';
            
            const chunks = await chunkingService.chunkText(longText);
            
            expect(chunks.length).toBeGreaterThan(1);
            
            // Each chunk should respect the token limit
            for (const chunk of chunks) {
                expect(chunk.tokenCount).toBeLessThanOrEqual(5);
                expect(chunk.text).toBeTruthy();
                expect(chunk.startIndex).toBeGreaterThanOrEqual(0);
                expect(chunk.endIndex).toBeGreaterThan(chunk.startIndex);
            }
        });
    });

    describe('Chunk size and overlap configuration', () => {
        it('respects custom chunk size', async () => {
            const smallChunkService = createMockedChunkingService(3, 1); // 3 tokens max
            try {
                const text = 'One two three four five six seven eight nine ten eleven twelve';
                
                const chunks = await smallChunkService.chunkText(text);
                
                for (const chunk of chunks) {
                    expect(chunk.tokenCount).toBeLessThanOrEqual(3);
                }
            } finally {
                smallChunkService.dispose();
            }
        });

        it('handles zero overlap correctly', async () => {
            const noOverlapService = createMockedChunkingService(4, 0); // No overlap
            try {
                const text = 'Word one two three four five six seven eight nine ten';
                
                const chunks = await noOverlapService.chunkText(text);
                
                // With no overlap, chunks should not share content
                expect(chunks.length).toBeGreaterThan(1);
            } finally {
                noOverlapService.dispose();
            }
        });

        it('handles large overlap gracefully', async () => {
            const largeOverlapService = createMockedChunkingService(5, 8); // Overlap > chunk size
            try {
                const text = 'One two three four five six seven eight nine ten eleven twelve thirteen';
                
                // Should not hang or throw errors
                const chunks = await largeOverlapService.chunkText(text);
                
                expect(chunks.length).toBeGreaterThan(0);
            } finally {
                largeOverlapService.dispose();
            }
        });
    });

    describe('Token counting utility functions', () => {
        it('counts tokens for simple text', async () => {
            const text = 'Hello world test';
            
            const tokenCount = await chunkingService.getTokenCount(text);
            
            expect(tokenCount).toBeGreaterThan(0);
            expect(typeof tokenCount).toBe('number');
        });

        it('returns zero tokens for empty text', async () => {
            const tokenCount = await chunkingService.getTokenCount('');
            
            expect(tokenCount).toBe(0);
        });

        it('correctly identifies when text needs chunking', async () => {
            const veryShortText = 'Hi';
            const longText = 'This is definitely a much longer text that contains many words and should exceed our token limit for a single chunk and therefore require chunking into multiple pieces';
            
            const shortNeedsChunking = await chunkingService.needsChunking(veryShortText);
            const longNeedsChunking = await chunkingService.needsChunking(longText);
            
            expect(shortNeedsChunking).toBe(false);
            expect(longNeedsChunking).toBe(true);
        });
    });

    describe('Chunk properties and ordering', () => {
        it('maintains correct chunk ordering', async () => {
            const text = 'First chunk content then second chunk content then third chunk content and finally fourth chunk content';
            
            const chunks = await chunkingService.chunkText(text);
            
            // Chunks should be in order
            for (let i = 1; i < chunks.length; i++) {
                expect(chunks[i].startIndex).toBeGreaterThanOrEqual(chunks[i-1].startIndex);
            }
        });

        it('sets reasonable chunk boundaries', async () => {
            const text = 'Some sample text for testing chunk boundary detection and validation';
            
            const chunks = await chunkingService.chunkText(text);
            
            for (const chunk of chunks) {
                expect(chunk.startIndex).toBeGreaterThanOrEqual(0);
                expect(chunk.endIndex).toBeLessThanOrEqual(text.length);
                expect(chunk.endIndex).toBeGreaterThan(chunk.startIndex);
            }
        });

        it('produces non-empty chunks for non-empty text', async () => {
            const text = 'Testing that all chunks contain actual content and are not empty strings';
            
            const chunks = await chunkingService.chunkText(text);
            
            for (const chunk of chunks) {
                expect(chunk.text.trim()).toBeTruthy();
                expect(chunk.tokenCount).toBeGreaterThan(0);
            }
        });
    });

    describe('Edge cases and error handling', () => {
        it('handles single word input', async () => {
            const chunks = await chunkingService.chunkText('Word');
            
            expect(chunks).toHaveLength(1);
            expect(chunks[0].text).toBe('Word');
            expect(chunks[0].tokenCount).toBeGreaterThan(0);
        });

        it('handles whitespace-heavy text', async () => {
            const text = '   Word1    Word2    Word3   ';
            
            const chunks = await chunkingService.chunkText(text);
            
            expect(chunks.length).toBeGreaterThan(0);
            // Should handle whitespace without crashing
        });

        it('handles very long words', async () => {
            const text = 'Supercalifragilisticexpialidocious antidisestablishmentarianism pneumonoultramicroscopicsilicovolcanoconiosisword';
            
            const chunks = await chunkingService.chunkText(text);
            
            expect(chunks.length).toBeGreaterThan(0);
            // Should not crash on long words
        });
    });

    describe('Resource management', () => {
        it('allows multiple dispose calls safely', () => {
            const service = createMockedChunkingService(10, 2);
            
            try {
                // Should not throw
                service.dispose();
                service.dispose(); // Second dispose should be safe
            } finally {
                // Ensure cleanup even if test fails
                service.dispose();
            }
        });

        it('can be used after creation', async () => {
            const service = createMockedChunkingService(8, 3);
            
            try {
                // Should work immediately after creation
                const chunks = await service.chunkText('Test text for new service');
                expect(chunks.length).toBeGreaterThan(0);
            } finally {
                service.dispose();
            }
        });
    });

    describe('Standard configuration service', () => {
        it('provides a working standard configuration', async () => {
            const standardService = createMockedChunkingService(128, 16);
            const text = 'Testing the standard chunking service with a moderately long text that should exercise the standard parameters and produce multiple chunks if the text is long enough to exceed the standard chunk size limit';
            
            try {
                const chunks = await standardService.chunkText(text);
                
                expect(chunks).toBeDefined();
                expect(chunks.length).toBeGreaterThan(0);
                
                // Standard service uses 128 token chunks
                for (const chunk of chunks) {
                    expect(chunk.tokenCount).toBeLessThanOrEqual(128);
                    expect(chunk.tokenCount).toBeGreaterThan(0);
                }
            } finally {
                standardService.dispose();
            }
        });

        it('handles various text lengths with standard settings', async () => {
            const standardService = createMockedChunkingService(128, 16);
            const shortText = 'Short';
            const mediumText = 'This is a medium length text that might or might not need chunking depending on the tokenization';
            const longText = 'This is a very long text that should definitely require chunking because it contains many words and phrases that will exceed the token limit for a single chunk when processed by the tokenizer and therefore should result in multiple chunks being created by the chunking service to properly handle the content length and maintain reasonable chunk sizes for processing. ' +
                'Furthermore, this extended text continues with additional sentences to ensure we have enough content to trigger the chunking mechanism in our standard service configuration which uses 128 tokens per chunk. ' +
                'We need to include many more words here to simulate a realistic document that would naturally be broken down into smaller, more manageable pieces for vector processing and search functionality. ' +
                'This approach allows us to test the chunking behavior under conditions that closely resemble real-world usage scenarios where documents contain substantial amounts of text content that must be properly segmented. ' +
                'The chunking service plays a crucial role in preparing text for vector embedding generation and subsequent similarity search operations in our remembrance agent system for Obsidian notes and documents. ' +
                'Additional content follows to ensure we exceed any reasonable token limit for a single chunk. This text needs to be sufficiently long to trigger multiple chunks even with a generous 128 token limit per chunk. ' +
                'We continue adding more sentences and words to create a substantial amount of text content that will definitely require chunking into multiple smaller pieces for proper processing by our vector embedding system. ' +
                'Each chunk should contain a reasonable amount of text that can be effectively processed by the embedding model while maintaining semantic coherence and contextual integrity throughout the chunking process. ' +
                'The system must handle various types of content including technical documentation, research papers, meeting notes, project specifications, and other forms of knowledge that users typically store in their Obsidian vaults. ' +
                'By testing with this extended text sample, we ensure that our chunking implementation can handle real-world scenarios where documents contain hundreds or thousands of words that need to be properly segmented for vector search and retrieval operations.';
            
            try {
                const shortChunks = await standardService.chunkText(shortText);
                const mediumChunks = await standardService.chunkText(mediumText);
                const longChunks = await standardService.chunkText(longText);
                
                expect(shortChunks.length).toBe(1);
                expect(mediumChunks.length).toBeGreaterThanOrEqual(1);
                expect(longChunks.length).toBeGreaterThan(1);
            } finally {
                standardService.dispose();
            }
        });
    });
});