// We'll load tiktoken with WASM binary directly
import { Plugin } from 'obsidian';
import { Logger } from './logger';
import type { Tiktoken } from 'tiktoken';
import { get_encoding } from 'tiktoken';

export interface TextChunk {
    text: string;
    startIndex: number;
    endIndex: number;
    tokenCount: number;
}

export class ChunkingService {
    private encoder: Tiktoken | null = null;
    private readonly chunkSize: number;
    private readonly overlap: number;
    private plugin: Plugin;
    private logger: Logger;

    constructor(chunkSize: number = 128, overlap: number = 16, plugin: Plugin, logger: Logger) {
        this.chunkSize = chunkSize;
        this.overlap = overlap; // Overlap between chunks to maintain context
        this.plugin = plugin;
        this.logger = logger;
    }

    private async ensureEncoder(): Promise<void> {
        if (!this.encoder) {
            try {
                this.logger.info('ChunkingService', 'Loading tiktoken with WASM binary...');
                
                // Use cl100k_base encoding (used by GPT-3.5/4)
                this.encoder = get_encoding('cl100k_base');
                
            } catch (error) {
                this.logger.error('ChunkingService', 'Failed to load tiktoken encoder:', error);
                throw new Error('Tiktoken encoder failed to load.');
            }
        }
    }

    /**
     * Split text into chunks based on token count
     */
    async chunkText(text: string): Promise<TextChunk[]> {
        await this.ensureEncoder();
        
        // Encode the entire text to get tokens
        if (!this.encoder) {
            throw new Error('Encoder not initialized');
        }
        const tokens = this.encoder.encode(text);
        
        if (tokens.length <= this.chunkSize) {
            // Text is small enough to fit in one chunk
            return [{
                text,
                startIndex: 0,
                endIndex: text.length,
                tokenCount: tokens.length
            }];
        }

        const chunks: TextChunk[] = [];
        let startTokenIndex = 0;
        
        // Calculate scaling factor: characters per token (approximate)
        const charToTokenRatio = text.length / tokens.length;

        while (startTokenIndex < tokens.length) {
            // Calculate end token index for this chunk
            const endTokenIndex = Math.min(startTokenIndex + this.chunkSize, tokens.length);
            
            // Extract tokens for this chunk
            const chunkTokens = tokens.slice(startTokenIndex, endTokenIndex);
            
            // Decode tokens back to text
            // Note: In browser environments, tiktoken.decode() may return Uint8Array instead of string
            if (!this.encoder) {
                throw new Error('Encoder not initialized');
            }
            const decoded = this.encoder.decode(chunkTokens);
            let chunkText: string;
            
            if (decoded instanceof Uint8Array) {
                // Convert UTF-8 bytes to string
                chunkText = new TextDecoder().decode(decoded);
            } else if (typeof decoded === 'string') {
                // Already a string
                chunkText = decoded;
            } else {
                // Unexpected type - fallback with warning
                this.logger.warn('ChunkingService', `Unexpected decode result type: ${typeof decoded}`, decoded);
                chunkText = String(decoded);
            }
            
            this.logger.debug('ChunkingService', `Chunk ${chunks.length} (${chunkTokens.length} tokens):`, chunkText);
            
            // Approximate character positions based on token positions
            const startCharIndex = Math.round(startTokenIndex * charToTokenRatio);
            const endCharIndex = Math.round(endTokenIndex * charToTokenRatio);
            
            chunks.push({
                text: chunkText,
                startIndex: startCharIndex,
                endIndex: endCharIndex,
                tokenCount: chunkTokens.length
            });

            // Move to next chunk with overlap
            // Ensure we always advance by at least 1 to prevent infinite loops
            const advance = Math.max(1, this.chunkSize - this.overlap);
            startTokenIndex += advance;
        }

        this.logger.info('ChunkingService', `Created ${chunks.length} chunks for text (${tokens.length} tokens)`);
        return chunks;
    }

    /**
     * Get token count for a text without chunking
     */
    async getTokenCount(text: string): Promise<number> {
        await this.ensureEncoder();
        if (!this.encoder) {
            throw new Error('Encoder not initialized');
        }
        const tokens = this.encoder.encode(text);
        return tokens.length;
    }

    /**
     * Check if text needs chunking
     */
    async needsChunking(text: string): Promise<boolean> {
        const tokenCount = await this.getTokenCount(text);
        return tokenCount > this.chunkSize;
    }

    /**
     * Cleanup encoder resources
     */
    dispose(): void {
        if (this.encoder) {
            this.encoder.free();
            this.encoder = null;
        }
    }
}
