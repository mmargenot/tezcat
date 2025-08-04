import { DatabaseService, Vector, VectorType, FTSResult } from './database_service';
import { EmbeddingService } from './embedding_service';
import { Logger } from './logger';
import { Position } from './note_processor';

export type SearchResult = {
    noteId: string;
    chunkId?: string;
    blockId?: string;
    type: VectorType;
    score: number;
    text: string;
    notePath: string;
    noteName: string;
    blockStartPosition?: Position;
    blockEndPosition?: Position;
};

export type SearchOptions = {
    topK?: number;
    minScore?: number;
    includeNoteVectors?: boolean;
    includeChunkVectors?: boolean;
    includeBlockVectors?: boolean;
    excludeNotePaths?: string[];
    useVectorIndex?: boolean;
    useHybridSearch?: boolean;
    hybridWeight?: number; // Weight for combining vector and FTS scores (0.0 = only FTS, 1.0 = only vector)
};


export class SearchService {
    private databaseService: DatabaseService;
    private embeddingService: EmbeddingService;
    private logger: Logger;

    constructor(databaseService: DatabaseService, embeddingService: EmbeddingService, logger: Logger) {
        this.databaseService = databaseService;
        this.embeddingService = embeddingService;
        this.logger = logger;
    }

    private async isVectorIndexAvailable(): Promise<boolean> {
        try {
            return await this.databaseService.isVectorIndexAvailable();
        } catch (error) {
            this.logger.warn('SearchService', 'Vector index availability check failed', error);
            return false;
        }
    }

    /**
     * Perform vector similarity search against all stored vectors
     */
    async vectorSearch(query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
        const {
            topK = 10,
            minScore = 0.0,
            includeNoteVectors = true,
            includeChunkVectors = false,
            includeBlockVectors = true,
            excludeNotePaths = [],
            useVectorIndex = true
        } = options;

        const searchStartTime = performance.now();
        this.logger.info('SearchService', `Starting vector search for query: "${query.substring(0, 50)}${query.length > 50 ? '...' : ''}"`);

        // Embed the query
        const queryVector = await this.embeddingService.embedText(query);

        // Get vectors from database - use index if requested and available
        let allVectors: Vector[];
        if (useVectorIndex && await this.isVectorIndexAvailable()) {
            this.logger.info('SearchService', 'Using vector index for candidate selection');
            try {
                allVectors = await this.databaseService.getSimilarVectors(queryVector, topK);
            } catch (error) {
                this.logger.warn('SearchService', 'Vector index failed, falling back to linear search', error);
                allVectors = await this.databaseService.getAllVectors();
            }
        } else {
            if (useVectorIndex) {
                this.logger.warn('SearchService', 'Vector index requested but not available, using linear search');
            }
            allVectors = await this.databaseService.getAllVectors();
        }

        // Get excluded note IDs if we have excluded paths
        let excludedNoteIds: string[] = [];
        if (excludeNotePaths.length > 0) {
            for (const path of excludeNotePaths) {
                try {
                    const note = await this.databaseService.getNoteByPath(path);
                    if (note) {
                        excludedNoteIds.push(note.id);
                    }
                } catch (error) {
                    this.logger.warn('SearchService', `Could not find note for path: ${path}`);
                }
            }
        }

        // Filter by type and excluded notes
        let vectors = allVectors.filter(vector => {
            // Filter by type if specified
            if (!includeNoteVectors && vector.type === VectorType.NOTE) return false;
            if (!includeChunkVectors && vector.type === VectorType.CHUNK) return false;
            if (!includeBlockVectors && vector.type === VectorType.BLOCK) return false;
            
            // Filter out excluded notes (both note vectors and chunk vectors from those notes)
            if (excludedNoteIds.length > 0 && excludedNoteIds.includes(vector.note_id)) return false;
            
            return true;
        });
        

        // Calculate similarities
        const results: SearchResult[] = [];
        for (const vector of vectors) {
            const similarity = this.calculateCosineSimilarity(queryVector, vector.vector);
            
            if (similarity >= minScore) {
                // Get the note info
                const note = await this.databaseService.getNote(vector.note_id);
                if (!note) continue; // Skip if note not found

                let text: string;
                
                if (vector.type === VectorType.NOTE) {
                    // For note vectors, return note path and name (not full text)
                    text = `${note.path} - ${note.name}`;
                } else if (vector.type === VectorType.CHUNK && vector.chunk_id) {
                    // For chunk vectors, get the chunk text
                    const chunks = await this.databaseService.getChunksForNote(vector.note_id);
                    const chunk = chunks.find(c => c.id === vector.chunk_id);
                    if (!chunk) continue; // Skip if chunk not found
                    text = chunk.text;
                } else if (vector.type === VectorType.BLOCK && vector.block_id) {
                    // For block vectors, get the block text and position
                    const blocks = await this.databaseService.getBlocksForNote(vector.note_id);
                    const block = blocks.find(b => b.id === vector.block_id);
                    if (!block) continue; // Skip if block not found
                    text = block.content;
                    
                    // Add block result with position data
                    results.push({
                        noteId: vector.note_id,
                        chunkId: vector.chunk_id,
                        blockId: vector.block_id,
                        type: vector.type,
                        score: similarity,
                        text,
                        notePath: note.path,
                        noteName: note.name,
                        blockStartPosition: block.start_position,
                        blockEndPosition: block.end_position
                    });
                    continue; // Skip the generic result push below
                } else {
                    continue; // Skip invalid vectors
                }

                // For non-block results, add without position data
                results.push({
                    noteId: vector.note_id,
                    chunkId: vector.chunk_id,
                    blockId: vector.block_id,
                    type: vector.type,
                    score: similarity,
                    text,
                    notePath: note.path,
                    noteName: note.name
                });
            }
        }

        // Sort by similarity score (highest first) and take top K
        results.sort((a, b) => b.score - a.score);
        const topResults = results.slice(0, topK);

        const searchEndTime = performance.now();
        const totalSearchTime = searchEndTime - searchStartTime;
        
        this.logger.info('SearchService', `Search completed in ${totalSearchTime.toFixed(2)}ms`);

        return topResults;
    }

    /**
     * Perform hybrid search using Reciprocal Rank Fusion (RRF) to combine vector and FTS results
     */
    async hybridSearch(query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
        const {
            topK = 10,
            minScore = 0.0,
            includeNoteVectors = true,
            includeChunkVectors = false,
            includeBlockVectors = true,
            excludeNotePaths = [],
            hybridWeight = 0.5 // Weight for vector vs FTS in RRF (0.5 = 50% vector, 50% FTS)
        } = options;

        const searchStartTime = performance.now();
        this.logger.info('SearchService', `Starting RRF hybrid search for query: "${query.substring(0, 50)}${query.length > 50 ? '...' : ''}"`);

        // Perform both vector and FTS searches in parallel
        const [vectorResults, ftsResults] = await Promise.all([
            this.vectorSearch(query, { ...options, useHybridSearch: false }),
            this.databaseService.searchFTS(query, topK * 2)
        ]);

        // Create maps for RRF processing
        const vectorRankMap = new Map<string, number>(); // key -> rank
        const ftsRankMap = new Map<string, number>(); // key -> rank
        const allResultsMap = new Map<string, SearchResult>(); // key -> SearchResult

        // Build vector rank map and results map
        vectorResults.forEach((result, index) => {
            const key = result.blockId || result.noteId;
            vectorRankMap.set(key, index + 1);
            allResultsMap.set(key, result);
        });

        // Build FTS rank map and add FTS-only results to results map
        for (let i = 0; i < ftsResults.length; i++) {
            const ftsResult = ftsResults[i];
            const key = ftsResult.blockId || ftsResult.noteId;
            ftsRankMap.set(key, i + 1);
            
            // If not already in results map from vector search, add it
            if (!allResultsMap.has(key)) {
                const searchResult: SearchResult = {
                    noteId: ftsResult.noteId,
                    blockId: ftsResult.blockId,
                    type: ftsResult.type as VectorType,
                    score: 0, // Will be set by RRF
                    text: ftsResult.content,
                    notePath: ftsResult.notePath,
                    noteName: ftsResult.noteName
                };
                
                // Add position data for blocks if available
                if (ftsResult.blockId && ftsResult.type === 'block') {
                    try {
                        const blocks = await this.databaseService.getBlocksForNote(ftsResult.noteId);
                        const block = blocks.find(b => b.id === ftsResult.blockId);
                        if (block) {
                            searchResult.blockStartPosition = block.start_position;
                            searchResult.blockEndPosition = block.end_position;
                        }
                    } catch (error) {
                        this.logger.warn('SearchService', `Failed to get block position for ${ftsResult.blockId}`, error);
                    }
                }
                
                allResultsMap.set(key, searchResult);
            }
        }

        // Apply Reciprocal Rank Fusion (RRF) with hybrid weighting
        const k = 60; // RRF constant
        const rrfScores = new Map<string, number>();

        // Calculate RRF scores for all results
        for (const [key, result] of allResultsMap) {
            let rrfScore = 0;
            
            // Add vector ranking contribution
            if (vectorRankMap.has(key)) {
                rrfScore += hybridWeight * (1 / (k + vectorRankMap.get(key)!));
            }
            
            // Add FTS ranking contribution
            if (ftsRankMap.has(key)) {
                rrfScore += (1 - hybridWeight) * (1 / (k + ftsRankMap.get(key)!));
            }
            
            if (rrfScore > 0) {
                rrfScores.set(key, rrfScore);
            }
        }

        // Create final results with RRF scores
        const fusedResults: SearchResult[] = [];
        for (const [key, rrfScore] of rrfScores) {
            if (rrfScore >= minScore) {
                const result = allResultsMap.get(key)!;
                fusedResults.push({
                    ...result,
                    score: rrfScore
                });
            }
        }

        // Sort by RRF score and take top K
        fusedResults.sort((a, b) => b.score - a.score);
        let finalResults = fusedResults.slice(0, topK);

        // Apply exclusion filters
        if (excludeNotePaths.length > 0) {
            finalResults = finalResults.filter(result => !excludeNotePaths.includes(result.notePath));
        }

        const searchEndTime = performance.now();
        const totalSearchTime = searchEndTime - searchStartTime;
        
        this.logger.info('SearchService', `RRF hybrid search completed in ${totalSearchTime.toFixed(2)}ms`);

        return finalResults;
    }

    /**
     * Calculate cosine similarity between two quantized int8 vectors
     */
    private calculateCosineSimilarity(vecA: Int8Array, vecB: Int8Array): number {
        if (vecA.length !== vecB.length) {
            throw new Error(`Vector dimension mismatch: ${vecA.length} vs ${vecB.length}`);
        }

        let dotProduct = 0;
        let normA = 0;
        let normB = 0;

        for (let i = 0; i < vecA.length; i++) {
            const a = vecA[i];
            const b = vecB[i];
            
            dotProduct += a * b;
            normA += a * a;
            normB += b * b;
        }

        const magnitude = Math.sqrt(normA) * Math.sqrt(normB);
        
        if (magnitude === 0) {
            return 0; // Handle zero vectors
        }

        // Cosine similarity ranges from -1 to 1
        // We normalize to 0-1 range for easier interpretation
        const cosineSim = dotProduct / magnitude;
        return (cosineSim + 1) / 2;
    }

}
