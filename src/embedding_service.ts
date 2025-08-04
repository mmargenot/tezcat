// LSH configuration interfaces
export interface LSHConfig {
    id: number;
    num_hash_functions: number;
    vector_dimensions: number;
    vector_count_at_build: number;
    created_at: string;
}

export type LSHHashFunction = {
    id: string;
    configId: string;
    hashIndex: number;
    projectionMatrix: Float32Array;
    createdAt: Date;
};

// Ollama API response interfaces
interface OllamaModel {
    name: string;
}

interface OllamaModelsResponse {
    models: OllamaModel[];
}

import { Logger } from './logger';
import { Notice, requestUrl } from 'obsidian';

// Vector processing utilities
export class VectorUtils {
    private logger: Logger;

    constructor(logger: Logger) {
        this.logger = logger;
    }

    /**
     * Generate random projection vectors for LSH hash functions
     */
    createHashFunctions(vectorCount: number, vectorDimensions: number): { 
        numHashFunctions: number; 
        hashFunctions: { hashIndex: number; projectionMatrix: Float32Array }[] 
    } {
        this.logger.info('VectorUtils', `Creating hash functions for ${vectorCount} vectors, ${vectorDimensions} dimensions`);

        // Calculate number of hash functions
        const numHashFunctions = Math.ceil(Math.log2(vectorCount));
        this.logger.info('VectorUtils', `Using ${numHashFunctions} hash functions`);

        // Generate random projection vectors
        const hashFunctions: { hashIndex: number; projectionMatrix: Float32Array }[] = [];
        for (let i = 0; i < numHashFunctions; i++) {
            const projectionMatrix = this.generateRandomProjectionVector(vectorDimensions);
            hashFunctions.push({
                hashIndex: i,
                projectionMatrix
            });
        }

        this.logger.info('VectorUtils', `Created ${numHashFunctions} hash functions`);
        
        return { numHashFunctions, hashFunctions };
    }

    /**
     * Compute hash vector (bit string) for a given input vector
     */
    /**
     * Compute LSH hash vector for given input vector using provided hash functions
     */
    computeHashVector(vector: Int8Array, hashFunctions: LSHHashFunction[], expectedDimensions: number): number[] {
        if (vector.length !== expectedDimensions) {
            throw new Error(`Input vector has ${vector.length} dimensions, expected ${expectedDimensions}`);
        }

        if (hashFunctions.length === 0) {
            throw new Error('No hash functions provided');
        }

        const hashBits: number[] = [];

        // For each hash function, compute dot product and convert to bit
        for (const hashFunction of hashFunctions) {
            const dotProduct = this.dotProduct(vector, hashFunction.projectionMatrix);
            // Convert to bit: positive = 1, negative/zero = 0
            hashBits.push(dotProduct > 0 ? 1 : 0);
        }

        return hashBits;
    }

    /**
     * Calculate Hamming distance between two hash vectors (number arrays)
     */
    static hammingDistance(hash1: number[], hash2: number[]): number {
        if (hash1.length !== hash2.length) {
            throw new Error('Hash vectors must have the same length');
        }

        let distance = 0;
        for (let i = 0; i < hash1.length; i++) {
            if (hash1[i] !== hash2[i]) {
                distance++;
            }
        }
        return distance;
    }


    /**
     * Generate a random projection vector for LSH
     */
    private generateRandomProjectionVector(dimensions: number): Float32Array {
        const vector = new Float32Array(dimensions);
        
        // Generate random values from standard normal distribution
        for (let i = 0; i < dimensions; i++) {
            // Box-Muller transform for normal distribution
            const u1 = Math.random();
            const u2 = Math.random();
            const z0 = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
            vector[i] = z0;
        }

        return vector;
    }

    /**
     * Calculate dot product between Int8Array vector and Float32Array projection matrix
     */
    private dotProduct(vector: Int8Array, projectionMatrix: Float32Array): number {
        if (vector.length !== projectionMatrix.length) {
            this.logger.error('VectorUtils', `Dimension mismatch: vector.length=${vector.length}, projectionMatrix.length=${projectionMatrix.length}`);
            throw new Error('Vectors must have the same length');
        }

        let sum = 0;
        for (let i = 0; i < vector.length; i++) {
            sum += vector[i] * projectionMatrix[i];
        }
        return sum;
    }
    /**
     * L2 normalize a vector (make its magnitude = 1)
     */
    static l2Normalize(vector: number[]): number[] {
        const magnitude = Math.sqrt(vector.reduce((sum, val) => sum + val * val, 0));
        if (magnitude === 0) return vector; // Avoid division by zero
        return vector.map(val => val / magnitude);
    }

    /**
     * Quantize normalized float vector to int8 range [-128, 127]
     */
    static quantizeToInt8(normalizedVector: number[]): Int8Array {
        return new Int8Array(normalizedVector.map(val => {
            // Clamp to [-1, 1] range and scale to [-127, 127]
            const clamped = Math.max(-1, Math.min(1, val));
            return Math.round(clamped * 127);
        }));
    }

    /**
     * Complete processing: L2 normalize + quantize to int8
     */
    static processVector(vector: number[]): Int8Array {
        const normalized = this.l2Normalize(vector);
        return this.quantizeToInt8(normalized);
    }
}

export abstract class EmbeddingProvider {
    abstract embed_one(text: string): Promise<Int8Array>;
    abstract embed_many(texts: string[]): Promise<Int8Array[]>;
    abstract validate(): Promise<void>;
}



export class OllamaEmbeddingProvider extends EmbeddingProvider {
    private baseUrl: string;
    private modelName: string;
    private logger: Logger;
    private modelManager?: OllamaModelManager;

    constructor(baseUrl: string = 'http://localhost:11434', modelName: string = 'nomic-embed-text', logger: Logger, modelManager?: OllamaModelManager) {
        super();
        this.baseUrl = baseUrl;
        this.modelName = modelName;
        this.logger = logger;
        this.modelManager = modelManager;
    }

    /**
     * Set the model manager for enhanced validation with auto-download
     */
    setModelManager(modelManager: OllamaModelManager): void {
        this.modelManager = modelManager;
    }

    async embed_one(text: string): Promise<Int8Array> {
        const requestBody = {
            model: this.modelName,
            input: text
        };
        
        const response = await requestUrl({
            url: `${this.baseUrl}/api/embed`,
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requestBody)
        });
        
        if (response.status !== 200) {
            this.logger.error('OllamaProvider', `Error response: ${response.text}`);
            throw new Error(`Ollama API error: ${response.status} - ${response.text}`);
        }

        const data = response.json;
        
        // Handle both single and batch response formats
        const embedding = data.embeddings?.[0] || data.embedding;
        
        if (!embedding || embedding.length === 0) {
            throw new Error(`Ollama returned empty embedding for text: ${text.substring(0, 100)}...`);
        }
        
        return VectorUtils.processVector(embedding);
    }

    async embed_many(texts: string[]): Promise<Int8Array[]> {
        // Validate input data - should only be strings
        for (let j = 0; j < texts.length; j++) {
            const item = texts[j];
            if (typeof item !== 'string') {
                this.logger.error('OllamaProvider', `Invalid input at index ${j}: ${typeof item}`, item);
                throw new Error(`Expected string at index ${j}, got ${typeof item}`);
            }
        }
        
        const embeddings: Int8Array[] = [];
        const batchSize = 8; // Conservative batch size to avoid quality degradation
        
        for (let i = 0; i < texts.length; i += batchSize) {
            const batch = texts.slice(i, i + batchSize);
            
            const requestBody = {
                model: this.modelName,
                input: batch
            };
            
            const response = await requestUrl({
                url: `${this.baseUrl}/api/embed`,
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(requestBody)
            });
            
            if (response.status !== 200) {
                this.logger.error('OllamaProvider', `Batch error response: ${response.text}`);
                throw new Error(`Ollama API error: ${response.status} - ${response.text}`);
            }

            const data = response.json;
            
            if (!data.embeddings || !Array.isArray(data.embeddings)) {
                throw new Error(`Ollama batch request failed - expected embeddings array, got: ${Object.keys(data)}`);
            }
            
            // Process each embedding in the batch
            for (const embedding of data.embeddings) {
                if (!embedding || embedding.length === 0) {
                    throw new Error('Ollama returned empty embedding in batch');
                }
                embeddings.push(VectorUtils.processVector(embedding));
            }
        }
        
        this.logger.info('OllamaProvider', `Completed batch processing of ${embeddings.length} embeddings`);
        return embeddings;
    }

    async validate(): Promise<void> {
        try {
            // If model manager is available, use it for enhanced validation with auto-download
            if (this.modelManager) {
                await this.modelManager.ensureModelAvailable(this.modelName, true);
                this.logger.info('OllamaProvider', `Validated connection and ensured model availability: ${this.modelName}`);
                return;
            }

            // Fallback to basic validation if no model manager
            const response = await requestUrl({
                url: `${this.baseUrl}/api/tags`,
                method: 'GET'
            });
            if (response.status !== 200) {
                throw new Error(`Ollama server returned ${response.status}`);
            }
            
            const data = response.json as OllamaModelsResponse;
            if (!data.models || !Array.isArray(data.models)) {
                throw new Error('Unexpected response format from Ollama server');
            }
            
            // Check if selected model is available
            const modelExists = data.models.some((model: OllamaModel) => model.name === this.modelName);
            if (!modelExists) {
                const availableModels = data.models.map((m: OllamaModel) => m.name).join(', ');
                throw new Error(`Model "${this.modelName}" not found on Ollama server. Available models: ${availableModels}`);
            }
            
            this.logger.info('OllamaProvider', `Validated connection and model: ${this.modelName}`);
        } catch (error) {
            if (error instanceof Error && error.message.includes('fetch')) {
                throw new Error(`Cannot connect to Ollama server at ${this.baseUrl}. Please ensure Ollama is running and accessible.`);
            }
            throw error;
        }
    }
}

export class OpenAIEmbeddingProvider extends EmbeddingProvider {
    private apiKey: string;
    private modelName: string;
    private baseUrl: string;
    private logger: Logger;
    private lastRequestTime: number = 0;
    private minRequestInterval: number = 200; // Minimum 200ms between requests to avoid rate limits

    constructor(apiKey: string, modelName: string = 'text-embedding-3-small', baseUrl: string = 'https://api.openai.com', logger: Logger) {
        super();
        this.apiKey = apiKey;
        this.modelName = modelName;
        this.baseUrl = baseUrl;
        this.logger = logger;
        
        // Debug: Log API key info (without exposing the full key)
        this.logger.debug('OpenAIProvider', `API key length: ${apiKey?.length || 0}, starts with: ${apiKey?.substring(0, 7) || 'undefined'}`);
    }

    async embed_one(text: string): Promise<Int8Array> {
        // Check token count - rough estimate: 1 token ≈ 4 characters for English text
        const estimatedTokens = Math.ceil(text.length / 4);
        const maxTokens = 8000; // Leave some buffer below the 8192 limit
        
        if (estimatedTokens > maxTokens) {
            this.logger.warn('OpenAIProvider', `Text too long for embedding (estimated ${estimatedTokens} tokens, limit ${maxTokens}), truncating...`);
            // Truncate to approximately the token limit
            const truncatedLength = maxTokens * 4;
            text = text.substring(0, truncatedLength);
        }
        
        return await this.makeRequestWithRetry(async () => {
            const response = await requestUrl({
                url: `${this.baseUrl}/v1/embeddings`,
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${this.apiKey}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    input: text,
                    model: this.modelName
                })
            });

            if (response.status !== 200) {
                throw new Error(`OpenAI API error: ${response.status} - ${response.text}`);
            }

            const data = response.json;
            
            if (!data.data || !data.data[0] || !data.data[0].embedding) {
                throw new Error('OpenAI returned invalid response format');
            }
            
            return VectorUtils.processVector(data.data[0].embedding);
        });
    }

    async embed_many(texts: string[]): Promise<Int8Array[]> {
        // Validate input data - should only be strings
        for (let j = 0; j < texts.length; j++) {
            const item = texts[j];
            if (typeof item !== 'string') {
                this.logger.error('OpenAIProvider', `Invalid input at index ${j}: ${typeof item}`, item);
                throw new Error(`Expected string at index ${j}, got ${typeof item}`);
            }
        }
        
        const embeddings: Int8Array[] = [];
        const maxTokensPerRequest = 7500; // Leave buffer below 8192 limit
        
        // Process texts in dynamic batches based on token count
        for (let i = 0; i < texts.length; ) {
            const batch: string[] = [];
            let currentTokens = 0;
            
            // Build batch until we approach token limit
            while (i < texts.length && currentTokens < maxTokensPerRequest) {
                const text = texts[i];
                const estimatedTokens = Math.ceil(text.length / 4); // 1 token ≈ 4 characters
                
                // If adding this text would exceed limit, break (unless batch is empty)
                if (currentTokens + estimatedTokens > maxTokensPerRequest && batch.length > 0) {
                    break;
                }
                
                batch.push(text);
                currentTokens += estimatedTokens;
                i++;
            }
            
            if (batch.length === 0) {
                // Single text is too large, skip it
                this.logger.warn('OpenAIProvider', `Skipping text that's too large (estimated ${Math.ceil(texts[i].length / 4)} tokens)`);
                i++;
                continue;
            }
            
            this.logger.debug('OpenAIProvider', `Processing batch of ${batch.length} items (~${currentTokens} tokens)`);
            
            const batchEmbeddings = await this.makeRequestWithRetry(async () => {
                const response = await requestUrl({
                    url: `${this.baseUrl}/v1/embeddings`,
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${this.apiKey}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        input: batch,
                        model: this.modelName
                    })
                });

                if (response.status !== 200) {
                    this.logger.error('OpenAIProvider', `Batch error response: ${response.text}`);
                    throw new Error(`OpenAI API error: ${response.status} - ${response.text}`);
                }

                const data = response.json;
                
                if (!data.data || !Array.isArray(data.data)) {
                    throw new Error(`OpenAI batch request failed - expected data array, got: ${Object.keys(data)}`);
                }
                
                // Process each embedding in the batch
                const batchResults: Int8Array[] = [];
                for (const item of data.data) {
                    if (!item.embedding || item.embedding.length === 0) {
                        throw new Error('OpenAI returned empty embedding in batch');
                    }
                    batchResults.push(VectorUtils.processVector(item.embedding));
                }
                
                return batchResults;
            });
            
            embeddings.push(...batchEmbeddings);
        }
        
        this.logger.info('OpenAIProvider', `Completed batch processing of ${embeddings.length} embeddings`);
        return embeddings;
    }

    /**
     * Make a request with rate limiting and retry logic
     */
    private async makeRequestWithRetry<T>(requestFn: () => Promise<T>, maxRetries: number = 3): Promise<T> {
        // Rate limiting: ensure minimum time between requests
        const now = Date.now();
        const timeSinceLastRequest = now - this.lastRequestTime;
        if (timeSinceLastRequest < this.minRequestInterval) {
            const waitTime = this.minRequestInterval - timeSinceLastRequest;
            await new Promise(resolve => setTimeout(resolve, waitTime));
        }
        this.lastRequestTime = Date.now();

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                return await requestFn();
            } catch (error) {
                const isRateLimit = error.message.includes('429') || error.message.includes('rate_limit_exceeded');
                const isLastAttempt = attempt === maxRetries;
                
                if (isRateLimit && !isLastAttempt) {
                    // Extract retry delay from error message or use default
                    let retryDelay = 6000; // Default 6 seconds
                    
                    if (error.message.includes('try again in')) {
                        const match = error.message.match(/try again in ([\d.]+)s/);
                        if (match) {
                            retryDelay = Math.ceil(parseFloat(match[1]) * 1000) + 1000; // Add 1s buffer
                        }
                    }
                    
                    this.logger.warn('OpenAIProvider', `Rate limited (attempt ${attempt}/${maxRetries}), retrying in ${retryDelay}ms`);
                    await new Promise(resolve => setTimeout(resolve, retryDelay));
                    continue;
                }
                
                // If not rate limit error, or final attempt, throw the error
                throw error;
            }
        }
        
        // This should never be reached, but TypeScript requires it
        throw new Error('Max retries exceeded');
    }

    async validate(): Promise<void> {
        try {
            const response = await requestUrl({
                url: 'https://api.openai.com/v1/me',
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${this.apiKey}`,
                    'Content-Type': 'application/json'
                }
            });
            
            if (response.status !== 200) {
                if (response.status === 401 || response.status === 403) {
                    throw new Error('Invalid OpenAI API key. Please check your API key in settings.');
                }
                throw new Error(`OpenAI API returned ${response.status}`);
            }
            
            this.logger.info('OpenAIProvider', 'Validated API key successfully');
        } catch (error) {
            if (error.message.includes('fetch')) {
                throw new Error('Cannot reach OpenAI API. Please check your internet connection.');
            }
            throw error;
        }
    }
}

export class EmbeddingService {
    private provider: EmbeddingProvider;
    private logger: Logger;

    constructor(provider: EmbeddingProvider, logger: Logger) {
        this.provider = provider;
        this.logger = logger;
    }

    get embeddingProvider(): EmbeddingProvider {
        return this.provider;
    }

    async embedText(text: string): Promise<Int8Array> {
        return await this.provider.embed_one(text);
    }

    async embedTexts(texts: string[]): Promise<Int8Array[]> {
        return await this.provider.embed_many(texts);
    }
}

export interface ModelDownloadProgress {
    status: string;
    completed?: number;
    total?: number;
    percentage?: number;
    digest?: string;
}

export class OllamaModelManager {
    private baseUrl: string;
    private logger: Logger;
    private currentDownloadNotice: Notice | null = null;

    constructor(baseUrl: string, logger: Logger) {
        this.baseUrl = baseUrl;
        this.logger = logger;
    }

    /**
     * Check if Ollama server is accessible
     */
    async checkServerAvailability(): Promise<boolean> {
        try {
            const response = await requestUrl({
                url: `${this.baseUrl}/api/tags`,
                method: 'GET'
            });
            return response.status === 200;
        } catch (error) {
            this.logger.warn('OllamaModelManager', 'Server not accessible', error);
            return false;
        }
    }

    /**
     * Get list of available models on Ollama server
     */
    async getAvailableModels(): Promise<string[]> {
        try {
            const response = await requestUrl({
                url: `${this.baseUrl}/api/tags`,
                method: 'GET'
            });
            if (response.status !== 200) {
                throw new Error(`Server returned ${response.status}`);
            }
            
            const data = response.json as OllamaModelsResponse;
            if (!data.models || !Array.isArray(data.models)) {
                return [];
            }
            
            return data.models.map((model: OllamaModel) => model.name);
        } catch (error) {
            this.logger.error('OllamaModelManager', 'Failed to get available models', error);
            return [];
        }
    }

    /**
     * Check if a specific model is available
     */
    async isModelAvailable(modelName: string): Promise<boolean> {
        const models = await this.getAvailableModels();
        return models.includes(modelName);
    }

    /**
     * Download a model from Ollama registry with progress tracking
     */
    async downloadModel(modelName: string, showProgress: boolean = true): Promise<void> {
        this.logger.info('OllamaModelManager', `Starting download of model: ${modelName}`);
        
        if (showProgress) {
            this.currentDownloadNotice = new Notice(`Downloading ${modelName}...`, 0);
        }

        try {
            // Note: Using fetch here because requestUrl doesn't support streaming responses
            // This is the only remaining fetch call for streaming download functionality
            const response = await fetch(`${this.baseUrl}/api/pull`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    model: modelName,
                    stream: true 
                })
            });

            if (!response.ok) {
                throw new Error(`Download failed: ${response.status} ${response.statusText}`);
            }

            await this.processDownloadStream(response, modelName, showProgress);
            
            this.logger.info('OllamaModelManager', `Successfully downloaded model: ${modelName}`);
            
            if (showProgress && this.currentDownloadNotice) {
                this.currentDownloadNotice.hide();
                new Notice(`Model ${modelName} downloaded successfully!`, 3000);
            }
            
        } catch (error) {
            this.logger.error('OllamaModelManager', `Failed to download model ${modelName}`, error);
            
            if (showProgress && this.currentDownloadNotice) {
                this.currentDownloadNotice.hide();
                new Notice(`Failed to download ${modelName}: ${error.message}`, 5000);
            }
            
            throw error;
        }
    }

    /**
     * Process the streaming download response
     */
    private async processDownloadStream(response: Response, modelName: string, showProgress: boolean): Promise<void> {
        const reader = response.body?.getReader();
        if (!reader) {
            throw new Error('No response body available');
        }

        const decoder = new TextDecoder();
        let downloadedBytes = 0;
        let totalBytes = 0;

        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                const chunk = decoder.decode(value, { stream: true });
                const lines = chunk.split('\n').filter(line => line.trim());

                for (const line of lines) {
                    try {
                        const data: ModelDownloadProgress = JSON.parse(line);
                        
                        if (data.completed && data.total) {
                            downloadedBytes = data.completed;
                            totalBytes = data.total;
                            
                            const percentage = Math.round((downloadedBytes / totalBytes) * 100);
                            const mbDownloaded = Math.round(downloadedBytes / 1024 / 1024);
                            const mbTotal = Math.round(totalBytes / 1024 / 1024);
                            
                            this.logger.debug('OllamaModelManager', `Download progress: ${percentage}% (${mbDownloaded}MB/${mbTotal}MB)`);
                            
                            if (showProgress && this.currentDownloadNotice) {
                                this.updateDownloadProgress(modelName, percentage, mbDownloaded, mbTotal);
                            }
                        }
                        
                        if (data.status) {
                            this.logger.debug('OllamaModelManager', `Download status: ${data.status}`);
                            
                            if (showProgress && this.currentDownloadNotice && data.status.includes('verifying')) {
                                this.currentDownloadNotice.setMessage(`Verifying ${modelName}...`);
                            }
                        }
                        
                    } catch (parseError) {
                        // Skip invalid JSON lines
                        continue;
                    }
                }
            }
        } finally {
            reader.releaseLock();
        }
    }

    /**
     * Update the download progress notice
     */
    private updateDownloadProgress(modelName: string, percentage: number, mbDownloaded: number, mbTotal: number): void {
        if (!this.currentDownloadNotice) return;
        
        const progressBar = '█'.repeat(Math.floor(percentage / 5)) + '░'.repeat(20 - Math.floor(percentage / 5));
        const message = `Downloading ${modelName}\n${progressBar} ${percentage}%\n${mbDownloaded}MB / ${mbTotal}MB`;
        
        this.currentDownloadNotice.setMessage(message);
    }

    /**
     * Ensure a model is available, downloading it if necessary
     */
    async ensureModelAvailable(modelName: string, autoDownload: boolean = true): Promise<boolean> {
        try {
            // Check if server is available
            if (!await this.checkServerAvailability()) {
                throw new Error(`Ollama server not accessible at ${this.baseUrl}`);
            }

            // Check if model is already available
            if (await this.isModelAvailable(modelName)) {
                this.logger.info('OllamaModelManager', `Model ${modelName} is already available`);
                return true;
            }

            // Model not available - download if auto-download is enabled
            if (!autoDownload) {
                return false;
            }

            this.logger.info('OllamaModelManager', `Model ${modelName} not found, downloading...`);
            await this.downloadModel(modelName);
            return true;

        } catch (error) {
            this.logger.error('OllamaModelManager', `Failed to ensure model ${modelName} is available`, error);
            throw error;
        }
    }

    /**
     * Ensure multiple models are available
     */
    async ensureModelsAvailable(modelNames: string[], autoDownload: boolean = true): Promise<void> {
        const results = await Promise.allSettled(
            modelNames.map(modelName => this.ensureModelAvailable(modelName, autoDownload))
        );

        const failures = results
            .map((result, index) => ({ result, modelName: modelNames[index] }))
            .filter(({ result }) => result.status === 'rejected')
            .map(({ result, modelName }) => ({ 
                modelName, 
                error: result.status === 'rejected' ? result.reason : 'Unknown error' 
            }));

        if (failures.length > 0) {
            const errorMessage = failures
                .map(({ modelName, error }) => `${modelName}: ${error.message || error}`)
                .join(', ');
            throw new Error(`Failed to ensure models available: ${errorMessage}`);
        }

        this.logger.info('OllamaModelManager', `All models are available: ${modelNames.join(', ')}`);
    }
}
