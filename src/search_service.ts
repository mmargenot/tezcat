import { DatabaseService, Vector, VectorType } from './database_service';
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
        const embeddingStartTime = performance.now();
        this.logger.debug('SearchService', 'Beginning query embedding...');
        const queryVector = await this.embeddingService.embedText(query);
        const embeddingEndTime = performance.now();
        this.logger.debug('SearchService', `Query embedding completed in ${(embeddingEndTime - embeddingStartTime).toFixed(2)}ms`);

        // Get vectors from database - use index if requested and available
        let allVectors: Vector[];
        if (useVectorIndex && await this.isVectorIndexAvailable()) {
            this.logger.info('SearchService', 'Using vector index for candidate selection');
            try {
                allVectors = await this.databaseService.getSimilarVectors(queryVector, topK);
                this.logger.debug('SearchService', `Vector index returned ${allVectors.length} candidates`);
            } catch (error) {
                this.logger.warn('SearchService', 'Vector index failed, falling back to linear search', error);
                allVectors = await this.databaseService.getAllVectors();
            }
        } else {
            if (useVectorIndex) {
                this.logger.warn('SearchService', 'Vector index requested but not available, using linear search');
            } else {
                this.logger.debug('SearchService', 'Using linear search as requested');
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
        
        if (vectors.length !== allVectors.length) {
            this.logger.debug('SearchService', `Filtered to ${vectors.length} vectors (excluded ${allVectors.length - vectors.length} vectors)`);
        }

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
        this.logger.debug('SearchService', `Found ${results.length} matches above threshold, returning top ${topResults.length}`);
        this.logger.debug('SearchService', `Results served - Score range: ${topResults.length > 0 ? `${topResults[topResults.length - 1].score.toFixed(3)} - ${topResults[0].score.toFixed(3)}` : 'N/A'}`);

        return topResults;
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
