/**
 * Tests for database service functionality
 * Uses COMPLETELY MOCKED database adapter - NO REAL DATABASE ACCESS
 */

import { describe, it, expect, beforeEach, afterEach, vi, MockedFunction } from 'vitest';
import { DatabaseService, DatabaseAdapter, VectorType } from '../src/database_service';
import { logger } from '../src/logger';

// Complete mock implementation that NEVER touches real database
class MockDatabaseAdapter implements DatabaseAdapter {
    // In-memory storage for tests only
    private mockData = {
        notes: new Map<string, any>(),
        chunks: new Map<string, any>(),
        vectors: new Map<string, any>()
    };

    // All methods are mocked and tracked
    initialize = vi.fn().mockResolvedValue(undefined);
    close = vi.fn().mockResolvedValue(undefined);
    createNotesTable = vi.fn().mockResolvedValue(undefined);
    createChunksTable = vi.fn().mockResolvedValue(undefined);
    createVectorsTable = vi.fn().mockResolvedValue(undefined);
    createBlocksTable = vi.fn().mockResolvedValue(undefined);
    createFTSTable = vi.fn().mockResolvedValue(undefined);
    searchFTS = vi.fn().mockResolvedValue([]);
    insertFTSContent = vi.fn().mockResolvedValue(undefined);
    deleteFTSContentForNote = vi.fn().mockResolvedValue(undefined);
    dropAllTables = vi.fn().mockResolvedValue(undefined);
    generateVectorIndex = vi.fn().mockResolvedValue(undefined);
    getSimilarVectors = vi.fn().mockResolvedValue([]);
    isVectorIndexAvailable = vi.fn().mockResolvedValue(false);
    save = vi.fn().mockResolvedValue(undefined);
    load = vi.fn().mockResolvedValue(undefined);

    execute = vi.fn().mockImplementation(async (sql: string, params?: any[]) => {
        // Mock INSERT/DELETE operations for testing
        if (sql.includes('INSERT INTO notes')) {
            const [id] = params!;
            this.mockData.notes.set(id, { id, ...params });
        } else if (sql.includes('INSERT INTO vectors')) {
            const [id] = params!;
            this.mockData.vectors.set(id, { id, ...params });
        }
        // DELETE operations are mocked but don't need to actually delete
    });

    query = vi.fn().mockImplementation(async (sql: string, params?: any[]) => {
        // Return mock data based on query type
        if (sql.includes('SELECT * FROM notes')) {
            return Array.from(this.mockData.notes.values());
        }
        if (sql.includes('GROUP BY type')) {
            return [
                { type: 'note', count: 5 },
                { type: 'chunk', count: 10 }
            ];
        }
        return [];
    });

    get = vi.fn().mockImplementation(async (sql: string, params?: any[]) => {
        if (sql.includes('SELECT * FROM notes WHERE id = ?')) {
            return this.mockData.notes.get(params![0]) || null;
        }
        if (sql.includes('COUNT(*)')) {
            return { count: 0 };
        }
        return null;
    });

    // Test helper methods
    setMockQueryResult(sql: string, result: any) {
        (this.query as MockedFunction<any>).mockImplementation(async (querySql: string) => {
            if (querySql.includes(sql)) return result;
            return [];
        });
    }

    setMockGetResult(sql: string, result: any) {
        (this.get as MockedFunction<any>).mockImplementation(async (querySql: string) => {
            if (querySql.includes(sql)) return result;
            return null;
        });
    }

    reset() {
        this.mockData.notes.clear();
        this.mockData.chunks.clear();
        this.mockData.vectors.clear();
        vi.clearAllMocks();
    }
}

describe('DatabaseService', () => {
    let mockAdapter: MockDatabaseAdapter;
    let databaseService: DatabaseService;

    beforeEach(() => {
        mockAdapter = new MockDatabaseAdapter();
        databaseService = new DatabaseService(mockAdapter, logger);
    });

    afterEach(() => {
        mockAdapter.reset();
    });

    describe('Note operations', () => {
        it('creates a note with generated ID', async () => {
            const noteData = {
                path: '/test/note.md',
                name: 'Test Note',
                base_name: 'Test Note',
                text: 'This is test content'
            };

            const noteId = await databaseService.createNote(noteData);

            expect(noteId).toBeDefined();
            expect(typeof noteId).toBe('string');
            expect(mockAdapter.execute).toHaveBeenCalledWith(
                expect.stringContaining('INSERT INTO notes'),
                expect.arrayContaining([
                    noteId,
                    expect.any(String), // created_at
                    expect.any(String), // updated_at
                    noteData.path,
                    noteData.name,
                    noteData.base_name,
                    noteData.text
                ])
            );
            expect(mockAdapter.save).toHaveBeenCalled();
        });

        it('retrieves a note by ID', async () => {
            const mockNote = {
                id: 'test-id',
                path: '/test/note.md',
                name: 'Test Note'
            };

            mockAdapter.setMockGetResult('WHERE id = ?', mockNote);

            const result = await databaseService.getNote('test-id');

            expect(result).toEqual(mockNote);
            expect(mockAdapter.get).toHaveBeenCalledWith(
                'SELECT * FROM notes WHERE id = ?',
                ['test-id']
            );
        });

        it('updates a note', async () => {
            const updates = { text: 'Updated content' };

            await databaseService.updateNote('test-id', updates);

            expect(mockAdapter.execute).toHaveBeenCalledWith(
                expect.stringContaining('UPDATE notes SET'),
                expect.arrayContaining(['Updated content', expect.any(String), 'test-id'])
            );
            expect(mockAdapter.save).toHaveBeenCalled();
        });
    });

    describe('Vector operations', () => {
        it('creates a vector with int8 quantization', async () => {
            const vectorData = {
                note_id: 'test-note-id',
                type: VectorType.NOTE as VectorType,
                vector: new Int8Array([127, -128, 0, 64, -64])
            };

            const vectorId = await databaseService.createVector(vectorData);

            expect(vectorId).toBeDefined();
            expect(mockAdapter.execute).toHaveBeenCalledWith(
                expect.stringContaining('INSERT INTO vectors'),
                expect.arrayContaining([
                    vectorId,
                    vectorData.note_id,
                    null, // chunk_id
                    vectorData.type,
                    expect.any(String), // created_at
                    expect.any(String), // updated_at
                    expect.any(Int8Array) // original int8 vector
                ])
            );
            expect(mockAdapter.save).toHaveBeenCalled();
        });

        it('stores vector as Int8Array directly', async () => {
            const originalVector = new Int8Array([127, -128, 0, 64, -64]);
            const vectorData = {
                note_id: 'test-note-id',
                type: VectorType.NOTE as VectorType,
                vector: originalVector
            };

            await databaseService.createVector(vectorData);

            const calls = (mockAdapter.execute as MockedFunction<any>).mock.calls;
            const insertCall = calls.find((call: [string, any[]?]) => call[0].includes('INSERT INTO vectors'));
            expect(insertCall).toBeDefined();
            expect(insertCall![1]).toBeDefined();
            
            const storedVector = (insertCall![1] as any[])[7] as Int8Array; // vector parameter (now at index 7)
            expect(storedVector).toBeInstanceOf(Int8Array);
            expect(Array.from(storedVector)).toEqual(Array.from(originalVector));
        });

        it('gets vector count by type', async () => {
            const mockResults = [
                { type: 'note', count: 10 },
                { type: 'block', count: 25 }
            ];

            mockAdapter.setMockQueryResult('GROUP BY type', mockResults);

            const result = await databaseService.getVectorCountByType();

            expect(result).toEqual({
                note: 10,
                block: 25
            });
        });

        it('handles missing vector types in count', async () => {
            const mockResults = [{ type: 'note', count: 5 }];
            mockAdapter.setMockQueryResult('GROUP BY type', mockResults);

            const result = await databaseService.getVectorCountByType();

            expect(result).toEqual({
                note: 5,
                block: 0
            });
        });
    });

    describe('Change detection', () => {
        it('identifies files needing vector processing', async () => {
            const mockOutdatedFiles = [
                { path: '/outdated1.md', note_updated: '2024-01-02T00:00:00.000Z' },
                { path: '/outdated2.md', note_updated: '2024-01-03T00:00:00.000Z' }
            ];

            mockAdapter.setMockQueryResult('SELECT DISTINCT', mockOutdatedFiles);

            const result = await databaseService.getFilesModifiedSinceLastVectorCreation();

            expect(result).toHaveLength(2);
            expect(result[0]).toEqual({
                path: '/outdated1.md',
                lastModified: new Date('2024-01-02T00:00:00.000Z').getTime()
            });
        });

        it('identifies files without vectors', async () => {
            const mockFiles = [
                { note_id: 'note1', path: '/new1.md' },
                { note_id: 'note2', path: '/new2.md' }
            ];

            mockAdapter.setMockQueryResult('WHERE v.id IS NULL', mockFiles);

            const result = await databaseService.getFilesWithoutVectors();

            expect(result).toEqual([
                { path: '/new1.md', noteId: 'note1' },
                { path: '/new2.md', noteId: 'note2' }
            ]);
        });
    });

    describe('Cleanup operations', () => {
        it('cleans up orphaned vectors', async () => {
            await databaseService.cleanupOrphanedVectors();

            expect(mockAdapter.execute).toHaveBeenCalledWith(
                expect.stringContaining('DELETE FROM vectors')
            );
            expect(mockAdapter.save).toHaveBeenCalled();
        });

        it('gets orphaned data counts', async () => {
            const mockCounts = [5, 3, 2];
            let callIndex = 0;
            
            (mockAdapter.get as MockedFunction<any>).mockImplementation(async () => {
                return { count: mockCounts[callIndex++] || 0 };
            });

            const result = await databaseService.getOrphanedDataCounts();

            expect(result).toEqual({
                orphanedVectors: 5,
                orphanedChunks: 3,
                orphanedChunkVectors: 2
            });
        });

        it('performs full cleanup', async () => {
            await databaseService.performFullCleanup();

            expect(mockAdapter.execute).toHaveBeenCalledTimes(3); // 3 cleanup operations
            expect(mockAdapter.save).toHaveBeenCalledTimes(3);
        });
    });

    describe('Chunk operations', () => {
        it('creates a chunk', async () => {
            const chunkData = {
                note_id: 'test-note-id',
                chunk_index: 0,
                text: 'This is chunk text'
            };

            const chunkId = await databaseService.createChunk(chunkData);

            expect(chunkId).toBeDefined();
            expect(mockAdapter.execute).toHaveBeenCalledWith(
                expect.stringContaining('INSERT INTO chunks'),
                expect.arrayContaining([
                    chunkId,
                    chunkData.note_id,
                    expect.any(String), // created_at
                    expect.any(String), // updated_at
                    chunkData.chunk_index,
                    chunkData.text
                ])
            );
        });

        it('deletes chunks for a note', async () => {
            await databaseService.deleteChunksForNote('test-note-id');

            expect(mockAdapter.execute).toHaveBeenCalledWith(
                'DELETE FROM chunks WHERE note_id = ?',
                ['test-note-id']
            );
        });
    });
});