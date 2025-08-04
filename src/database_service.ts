import { Plugin } from 'obsidian';
import { TextChunk } from './chunking_service';
import { EmbeddingService, LSHConfig, LSHHashFunction, VectorUtils } from './embedding_service';
import { Logger } from './logger';
import { Block, BlockType } from './note_processor';
import initSqlJs from 'sql.js';
import sqlWasmPath from '../node_modules/sql.js/dist/sql-wasm.wasm';
const sqlWasm = sqlWasmPath;


export interface DatabaseAdapter {
    close(): Promise<void>;
    
    // Schema creation methods - each adapter implements its own table creation
    createNotesTable(): Promise<void>;
    createChunksTable(): Promise<void>;
    createVectorsTable(): Promise<void>;
    createBlocksTable(): Promise<void>;
    createFTSTable(): Promise<void>;
    dropAllTables(): Promise<void>;
    
    // Basic database operations
    execute(sql: string, params?: any[]): Promise<void>;
    query(sql: string, params?: any[]): Promise<any[]>;
    get(sql: string, params?: any[]): Promise<any>;
    
    // Vector indexing operations
    generateVectorIndex(vectorDimensions: number): Promise<void>;
    getSimilarVectors(queryVector: Int8Array, limit: number): Promise<Vector[]>;
    isVectorIndexAvailable(): Promise<boolean>;
    
    // FTS operations
    searchFTS(query: string, limit: number): Promise<FTSResult[]>;
    insertFTSContent(id: string, type: string, noteId: string, content: string, notePath: string, noteName: string, blockId?: string): Promise<void>;
    deleteFTSContentForNote(noteId: string): Promise<void>;
    
    // Persistence operations
    save(): Promise<void>;
    load(): Promise<void>;
}


export class SqlJsDatabaseAdapter implements DatabaseAdapter {
    private db: any = null;
    private SQL: any = null;
    private plugin: Plugin;
    private vectorUtils: VectorUtils;
    private logger: Logger;

    constructor(plugin: Plugin, vectorUtils: VectorUtils, logger: Logger) {
        this.plugin = plugin;
        this.vectorUtils = vectorUtils;
        this.logger = logger;
    }

    async initialize(): Promise<void> {
        try {
            this.logger.info('SqlJsAdapter', 'Starting sql.js database initialization...');
            
            this.logger.info('SqlJsAdapter', 'sql.js loaded successfully');
            
            this.SQL = await initSqlJs({
                wasmBinary: sqlWasm
            });
            this.logger.info('SqlJsAdapter', 'sql.js initialized successfully');
            
            // Create a new database
            this.db = new this.SQL.Database();
            this.logger.info('SqlJsAdapter', 'Database instance created');
            
            // Load existing database if it exists
            await this.load();
            
            // Create all tables (will be no-op if they already exist due to IF NOT EXISTS)
            await this.createNotesTable();
            await this.createChunksTable();
            await this.createVectorsTable();
            await this.createBlocksTable();
            await this.createFTSTable();
            await this.createLSHBucketsTable();
            
            this.logger.info('SqlJsAdapter', 'Database initialized successfully with sql.js');
        } catch (error) {
            this.logger.error('SqlJsAdapter', 'Failed to initialize sql.js database:', error);
            throw error;
        }
    }

    async close(): Promise<void> {
        if (this.db) {
            this.db.close();
            this.db = null;
        }
    }

    async createNotesTable(): Promise<void> {
        if (!this.db) throw new Error('Database not initialized');
        
        await this.execute(`
            CREATE TABLE IF NOT EXISTS notes (
                id TEXT PRIMARY KEY,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                path TEXT NOT NULL UNIQUE,
                name TEXT NOT NULL,
                base_name TEXT NOT NULL,
                text TEXT NOT NULL
            )
        `);
    }

    async createChunksTable(): Promise<void> {
        if (!this.db) throw new Error('Database not initialized');
        
        await this.execute(`
            CREATE TABLE IF NOT EXISTS chunks (
                id TEXT PRIMARY KEY,
                note_id TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                chunk_index INTEGER NOT NULL,
                text TEXT NOT NULL,
                FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE
            )
        `);
        
        await this.execute(`
            CREATE INDEX IF NOT EXISTS idx_chunks_note_id_index 
            ON chunks(note_id, chunk_index)
        `);
    }

    async createVectorsTable(): Promise<void> {
        if (!this.db) throw new Error('Database not initialized');
        
        // Create vectors table with BLOB storage for 768-dimensional vectors
        await this.execute(`
            CREATE TABLE IF NOT EXISTS vectors (
                id TEXT PRIMARY KEY,
                note_id TEXT NOT NULL,
                chunk_id TEXT,
                block_id TEXT,
                type TEXT NOT NULL CHECK (type IN ('note', 'chunk', 'block')),
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                vector BLOB,
                FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE,
                FOREIGN KEY (chunk_id) REFERENCES chunks(id) ON DELETE CASCADE,
                FOREIGN KEY (block_id) REFERENCES blocks(id) ON DELETE CASCADE
            )
        `);
        this.logger.info('SqlJsAdapter', 'Created vectors table with BLOB storage for 768-dimensional vectors');
    }

    async createBlocksTable(): Promise<void> {
        if (!this.db) throw new Error('Database not initialized');
        
        await this.execute(`
            CREATE TABLE IF NOT EXISTS blocks (
                id TEXT PRIMARY KEY,
                note_id TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                type TEXT NOT NULL,
                content TEXT NOT NULL,
                obsidian_id TEXT,
                start_position TEXT NOT NULL, -- JSON: {line, col, offset}
                end_position TEXT NOT NULL,   -- JSON: {line, col, offset}
                FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE
            )
        `);
        
        await this.execute(`
            CREATE INDEX IF NOT EXISTS idx_blocks_note_id 
            ON blocks(note_id)
        `);
        
        this.logger.info('SqlJsAdapter', 'Created blocks table with JSON position storage');
    }

    async createFTSTable(): Promise<void> {
        if (!this.db) throw new Error('Database not initialized');
        
        // Create FTS3 virtual table for full-text search
        await this.execute(`
            CREATE VIRTUAL TABLE IF NOT EXISTS fts_content USING fts3(
                id TEXT,
                type TEXT,
                note_id TEXT,
                content TEXT,
                note_path TEXT,
                note_name TEXT,
                block_id TEXT
            )
        `);
        
        this.logger.info('SqlJsAdapter', 'Created FTS3 virtual table for full-text search');
    }


    async dropAllTables(): Promise<void> {
        if (!this.db) throw new Error('Database not initialized');
        
        this.logger.info('SqlJsAdapter', 'Dropping all tables for database rebuild...');
        
        // Drop tables in reverse dependency order to avoid foreign key constraint issues
        await this.execute('DROP TABLE IF EXISTS lsh_vector_buckets');
        await this.execute('DROP TABLE IF EXISTS lsh_hash_functions');
        await this.execute('DROP TABLE IF EXISTS lsh_configs');
        await this.execute('DROP TABLE IF EXISTS vectors');
        await this.execute('DROP TABLE IF EXISTS blocks');
        await this.execute('DROP TABLE IF EXISTS chunks');
        await this.execute('DROP TABLE IF EXISTS fts_content');
        await this.execute('DROP TABLE IF EXISTS notes');
        
        this.logger.info('SqlJsAdapter', 'All tables dropped successfully');
    }

    async createLSHBucketsTable(): Promise<void> {
        if (!this.db) throw new Error('Database not initialized');
        
        // Create LSH configuration table
        await this.execute(`
            CREATE TABLE IF NOT EXISTS lsh_configs (
                id TEXT PRIMARY KEY,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                vector_count INTEGER NOT NULL,
                vector_dimensions INTEGER NOT NULL,
                num_hash_functions INTEGER NOT NULL
            )
        `);
        
        // Create LSH hash functions table
        await this.execute(`
            CREATE TABLE IF NOT EXISTS lsh_hash_functions (
                id TEXT PRIMARY KEY,
                config_id TEXT NOT NULL,
                hash_index INTEGER NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                projection_matrix TEXT NOT NULL,
                FOREIGN KEY (config_id) REFERENCES lsh_configs(id) ON DELETE CASCADE
            )
        `);
        
        // Create LSH buckets table
        await this.execute(`
            CREATE TABLE IF NOT EXISTS lsh_buckets (
                id TEXT PRIMARY KEY,
                config_id TEXT NOT NULL,
                bucket_hash TEXT NOT NULL,
                vector_id TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (config_id) REFERENCES lsh_configs(id) ON DELETE CASCADE,
                FOREIGN KEY (vector_id) REFERENCES vectors(id) ON DELETE CASCADE
            )
        `);
        
        // Create indexes for efficient lookups
        await this.execute(`
            CREATE INDEX IF NOT EXISTS idx_lsh_hash_functions_config_id 
            ON lsh_hash_functions(config_id)
        `);
        
        await this.execute(`
            CREATE INDEX IF NOT EXISTS idx_lsh_buckets_config_hash 
            ON lsh_buckets(config_id, bucket_hash)
        `);
        
        this.logger.info('SqlJsAdapter', 'Created LSH tables for hash function storage and bucket indexing');
    }

    async execute(sql: string, params?: any[]): Promise<void> {
        if (!this.db) throw new Error('Database not initialized');
        this.db.run(sql, params);
    }

    async query(sql: string, params?: any[]): Promise<any[]> {
        if (!this.db) throw new Error('Database not initialized');
        const stmt = this.db.prepare(sql);
        if (params) stmt.bind(params);
        const results = [];
        while (stmt.step()) {
            results.push(stmt.getAsObject());
        }
        stmt.free();
        return results;
    }

    async get(sql: string, params?: any[]): Promise<any> {
        const results = await this.query(sql, params);
        return results[0] || null;
    }

    async save(): Promise<void> {
        if (!this.db) return;
        
        const data = this.db.export();
        const buffer = Buffer.from(data);
        
        const adapter = this.plugin.app.vault.adapter;
        const dbPath = `${this.plugin.app.vault.configDir}/plugins/tezcat/tezcat.db`;
        await adapter.writeBinary(dbPath, buffer);
    }

    async load(): Promise<void> {
        try {
            const adapter = this.plugin.app.vault.adapter;
            const dbPath = `${this.plugin.app.vault.configDir}/plugins/tezcat/tezcat.db`;
            
            if (await adapter.exists(dbPath)) {
                const buffer = await adapter.readBinary(dbPath);
                const data = new Uint8Array(buffer);
                this.db = new this.SQL.Database(data);
                this.logger.info('SqlJsAdapter', 'Database loaded from disk');
            }
        } catch (error) {
            this.logger.info('SqlJsAdapter', 'No existing database found, starting fresh');
        }
    }

    async generateVectorIndex(vectorDimensions: number): Promise<void> {
        if (!this.db) throw new Error('Database not initialized');
        
        this.logger.info('SqlJsAdapter', 'Starting LSH vector index generation...');
        
        try {
            // Get vector count from existing vectors
            const vectorStats = await this.get('SELECT COUNT(*) as count FROM vectors');
            
            if (!vectorStats || vectorStats.count === 0) {
                this.logger.info('SqlJsAdapter', 'No vectors found, skipping LSH index generation');
                return;
            }
            
            const vectorCount = vectorStats.count;
            
            this.logger.info('SqlJsAdapter', `Building LSH index for ${vectorCount} vectors of ${vectorDimensions} dimensions`);
            
            // Calculate optimal number of hash functions
            const numHashFunctions = Math.ceil(Math.log2(vectorCount));
            
            // Ensure LSH tables exist before clearing them (safe to call multiple times)
            await this.createLSHBucketsTable();
            
            // Clear existing LSH data
            await this.clearLSHTables();
            
            // Generate hash functions using VectorUtils
            const configId = await this.createLSHConfig({
                vector_count_at_build: vectorCount,
                vector_dimensions: vectorDimensions,
                num_hash_functions: numHashFunctions
            });

            // Generate hash functions
            const { hashFunctions } = this.vectorUtils.createHashFunctions(vectorCount, vectorDimensions);
            
            // Store hash functions in database
            for (const hashFunction of hashFunctions) {
                await this.createLSHHashFunction({
                    configId: configId,
                    hashIndex: hashFunction.hashIndex,
                    projectionMatrix: hashFunction.projectionMatrix
                });
            }
            
            // Get the stored hash functions for proper typing
            const storedHashFunctions = await this.getLSHHashFunctions(configId);
            
            // Get all vectors and populate LSH buckets
            const vectors = await this.query('SELECT id, vector FROM vectors');
            
            this.logger.info('SqlJsAdapter', `Populating LSH buckets for ${vectors.length} vectors...`);
            
            for (const vectorRow of vectors) {
                const vector = new Int8Array(vectorRow.vector);
                const hashVector = this.vectorUtils.computeHashVector(vector, storedHashFunctions, vectorDimensions);
                const bucketHash = hashVector.join('');
                
                await this.createLSHBucket(configId, bucketHash, vectorRow.id);
            }
            
            // Get and log LSH statistics
            const stats = await this.getLSHStats(configId);
            this.logger.info('SqlJsAdapter', `LSH index generation completed: totalBuckets=${stats.totalBuckets}, totalVectors=${stats.totalVectors}, avgVectorsPerBucket=${stats.avgVectorsPerBucket.toFixed(2)}, maxVectorsInBucket=${stats.maxVectorsInBucket}`);
            
        } catch (error) {
            this.logger.error('SqlJsAdapter', 'Failed to generate LSH vector index', error);
            throw error;
        }
    }

    // LSH-specific operations for SQL.js adapter
    async getLSHConfig(): Promise<LSHConfig | null> {
        const row = await this.get('SELECT * FROM lsh_configs LIMIT 1');
        
        if (!row) return null;
        
        return {
            id: row.id,
            vector_count_at_build: row.vector_count,
            vector_dimensions: row.vector_dimensions,
            num_hash_functions: row.num_hash_functions,
            created_at: row.created_at
        };
    }

    async isVectorIndexAvailable(): Promise<boolean> {
        try {
            const config = await this.getLSHConfig();
            return config !== null;
        } catch (error) {
            this.logger.warn('SqlJsAdapter', 'Failed to check vector index availability', error);
            return false;
        }
    }

    async getLSHHashFunctions(configId: string): Promise<LSHHashFunction[]> {
        const rows = await this.query(`
            SELECT * FROM lsh_hash_functions 
            WHERE config_id = ? 
            ORDER BY hash_index
        `, [configId]);
        
        return rows.map(row => {
            // Parse as regular array first, then convert to Float32Array
            const projectionMatrixArray = JSON.parse(row.projection_matrix);
            const projectionMatrix = new Float32Array(projectionMatrixArray);
            this.logger.debug('SqlJsAdapter', `Retrieved hash function with ${projectionMatrix.length} dimensions`);
            
            return {
                id: row.id,
                configId: row.config_id,
                hashIndex: row.hash_index,
                projectionMatrix: projectionMatrix,
                createdAt: new Date(row.created_at)
            };
        });
    }

    async clearLSHTables(): Promise<void> {
        await this.execute('DELETE FROM lsh_buckets');
        await this.execute('DELETE FROM lsh_hash_functions');
        await this.execute('DELETE FROM lsh_configs');
        await this.save();
        this.logger.info('SqlJsAdapter', 'Cleared all LSH tables');
    }

    async createLSHConfig(config: Omit<LSHConfig, 'id' | 'created_at'>): Promise<string> {
        const id = this.generateId();
        const now = new Date().toISOString();
        
        await this.execute(`
            INSERT INTO lsh_configs (id, created_at, vector_count, vector_dimensions, num_hash_functions)
            VALUES (?, ?, ?, ?, ?)
        `, [id, now, config.vector_count_at_build, config.vector_dimensions, config.num_hash_functions]);
        
        await this.save();
        return id;
    }

    async createLSHHashFunction(hashFunction: Omit<LSHHashFunction, 'id' | 'createdAt'>): Promise<string> {
        const id = this.generateId();
        const now = new Date().toISOString();
        
        // Convert Float32Array to regular array for proper JSON serialization
        const projectionMatrixArray = Array.from(hashFunction.projectionMatrix);
        this.logger.debug('SqlJsAdapter', `Storing hash function with ${projectionMatrixArray.length} dimensions`);
        
        await this.execute(`
            INSERT INTO lsh_hash_functions (id, config_id, hash_index, created_at, projection_matrix)
            VALUES (?, ?, ?, ?, ?)
        `, [id, hashFunction.configId, hashFunction.hashIndex, now, JSON.stringify(projectionMatrixArray)]);
        
        await this.save();
        return id;
    }

    async createLSHBucket(configId: string, bucketHash: string, vectorId: string): Promise<string> {
        const id = this.generateId();
        const now = new Date().toISOString();
        
        await this.execute(`
            INSERT INTO lsh_buckets (id, config_id, bucket_hash, vector_id, created_at)
            VALUES (?, ?, ?, ?, ?)
        `, [id, configId, bucketHash, vectorId, now]);
        
        await this.save();
        return id;
    }

    async getLSHBucket(configId: string, bucketHash: string): Promise<string[]> {
        const rows = await this.query(`
            SELECT vector_id FROM lsh_buckets 
            WHERE config_id = ? AND bucket_hash = ?
        `, [configId, bucketHash]);
        
        return rows.map(row => row.vector_id);
    }

    async getAllLSHBuckets(configId: string): Promise<{bucketHash: string, vectorIds: string[]}[]> {
        const rows = await this.query(`
            SELECT bucket_hash, vector_id FROM lsh_buckets 
            WHERE config_id = ?
        `, [configId]);
        
        // Group by bucket hash
        const bucketMap = new Map<string, string[]>();
        for (const row of rows) {
            if (!bucketMap.has(row.bucket_hash)) {
                bucketMap.set(row.bucket_hash, []);
            }
            bucketMap.get(row.bucket_hash)!.push(row.vector_id);
        }
        
        return Array.from(bucketMap.entries()).map(([bucketHash, vectorIds]) => ({
            bucketHash,
            vectorIds
        }));
    }

    async clearLSHBuckets(configId: string): Promise<void> {
        await this.execute('DELETE FROM lsh_buckets WHERE config_id = ?', [configId]);
        await this.save();
    }

    async getLSHStats(configId: string): Promise<{
        totalBuckets: number;
        totalVectors: number;
        avgVectorsPerBucket: number;
        maxVectorsInBucket: number;
        emptyBuckets: number;
    }> {
        const stats = await this.get(`
            SELECT 
                COUNT(DISTINCT bucket_hash) as total_buckets,
                COUNT(*) as total_vectors,
                AVG(bucket_size) as avg_vectors_per_bucket,
                MAX(bucket_size) as max_vectors_in_bucket,
                COUNT(CASE WHEN bucket_size = 0 THEN 1 END) as empty_buckets
            FROM (
                SELECT bucket_hash, COUNT(*) as bucket_size 
                FROM lsh_buckets 
                WHERE config_id = ? 
                GROUP BY bucket_hash
            )
        `, [configId]);
        
        return {
            totalBuckets: stats?.total_buckets || 0,
            totalVectors: stats?.total_vectors || 0,
            avgVectorsPerBucket: stats?.avg_vectors_per_bucket || 0,
            maxVectorsInBucket: stats?.max_vectors_in_bucket || 0,
            emptyBuckets: stats?.empty_buckets || 0
        };
    }

    async getSimilarVectors(queryVector: Int8Array, limit: number): Promise<Vector[]> {
        if (!this.db) throw new Error('Database not initialized');
        
        if (!this.vectorUtils) {
            this.logger.error('SqlJsAdapter', 'VectorUtils not provided - vector index search unavailable');
            throw new Error('Vector index not available - VectorUtils not initialized');
        }
        
        // Check if LSH is available
        const lshConfig = await this.getLSHConfig();
        if (!lshConfig) {
            this.logger.error('SqlJsAdapter', 'No LSH configuration found - vector index not built');
            throw new Error('Vector index not available - LSH configuration missing');
        }

        try {
            // Get hash functions for this configuration
            const hashFunctions = await this.getLSHHashFunctions(lshConfig.id.toString());
            
            // Compute hash for query vector
            const queryHash = this.vectorUtils.computeHashVector(queryVector, hashFunctions, lshConfig.vector_dimensions);

            // Get all buckets and compute hamming distances
            const allBuckets = await this.getAllLSHBuckets(lshConfig.id.toString());
            // Compute hamming distance to each bucket and sort by distance
            const bucketDistances = allBuckets.map(bucket => {
                const bucketHashArray = bucket.bucketHash.split('').map(Number);
                const hammingDistance = VectorUtils.hammingDistance(queryHash, bucketHashArray);
                return {
                    ...bucket,
                    hammingDistance
                };
            });

            // Sort by hamming distance (closest first)
            bucketDistances.sort((a, b) => a.hammingDistance - b.hammingDistance);

            // Collect vector IDs from closest buckets until we have enough candidates
            const candidateVectorIds = new Set<string>();
            const targetCandidates = limit * 10; // Get 10x more candidates for better ranking
            let bucketsUsed = 0;
            
            for (const bucket of bucketDistances) {
                bucket.vectorIds.forEach(id => candidateVectorIds.add(id));
                bucketsUsed++;
                
                // Break once we have enough candidates
                if (candidateVectorIds.size >= targetCandidates) break;
            }

            // Retrieve actual vectors from the database
            const vectorIds = Array.from(candidateVectorIds);
            const vectors: Vector[] = [];
            
            if (vectorIds.length > 0) {
                const placeholders = vectorIds.map(() => '?').join(',');
                const rows = await this.query(`
                    SELECT * FROM vectors WHERE id IN (${placeholders})
                `, vectorIds);
                
                vectors.push(...rows.map(row => ({
                    ...row,
                    type: row.type as VectorType,
                    vector: new Int8Array(row.vector)
                })));
            }

            this.logger.debug('SqlJsAdapter', `LSH search found ${vectors.length} vector candidates from ${bucketsUsed} buckets (min hamming distance: ${bucketDistances[0].hammingDistance})`);
            
            return vectors;

        } catch (error) {
            this.logger.error('SqlJsAdapter', 'LSH search failed', error);
            throw error;
        }
    }

    async searchFTS(query: string, limit: number): Promise<FTSResult[]> {
        if (!this.db) throw new Error('Database not initialized');
        
        // Escape FTS query and use FTS3 MATCH syntax
        const escapedQuery = query.replace(/["']/g, '').trim();
        if (!escapedQuery) return [];
        
        const rows = await this.query(`
            SELECT id, type, note_id, content, note_path, note_name, block_id
            FROM fts_content 
            WHERE content MATCH ?
            LIMIT ?
        `, [escapedQuery, limit]);
        
        return rows.map(row => ({
            id: row.id,
            type: row.type,
            noteId: row.note_id,
            content: row.content,
            notePath: row.note_path,
            noteName: row.note_name,
            blockId: row.block_id,
            relevance: 1.0 // Simple relevance score since we removed rank()
        }));
    }

    async insertFTSContent(id: string, type: string, noteId: string, content: string, notePath: string, noteName: string, blockId?: string): Promise<void> {
        if (!this.db) throw new Error('Database not initialized');
        
        await this.execute(`
            INSERT OR REPLACE INTO fts_content (id, type, note_id, content, note_path, note_name, block_id)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `, [id, type, noteId, content, notePath, noteName, blockId || null]);
        
        await this.save();
    }

    async deleteFTSContentForNote(noteId: string): Promise<void> {
        if (!this.db) throw new Error('Database not initialized');
        
        await this.execute('DELETE FROM fts_content WHERE note_id = ?', [noteId]);
        await this.save();
    }

    private generateId(): string {
        return Date.now().toString(36) + Math.random().toString(36).substr(2);
    }
}

// Enums and types
export enum VectorType {
    NOTE = 'note',
    CHUNK = 'chunk',
    BLOCK = 'block'
}

export type Note = {
    id: string;
    created_at: string;
    updated_at: string;
    path: string;
    name: string;
    base_name: string;
    text: string;
};

export type Chunk = {
    id: string;
    note_id: string;
    created_at: string;
    updated_at: string;
    chunk_index: number;
    text: string;
};

export type Vector = {
    id: string;
    note_id: string;
    chunk_id?: string;
    block_id?: string;
    type: VectorType;
    created_at: string;
    updated_at: string;
    vector: Int8Array; // Quantized int8 vectors
};

export type FTSResult = {
    id: string;
    type: string;
    noteId: string;
    content: string;
    notePath: string;
    noteName: string;
    blockId?: string;
    relevance: number;
};

export class DatabaseService {
    public adapter: DatabaseAdapter;
    private logger: Logger;

    constructor(adapter: DatabaseAdapter, logger: Logger) {
        this.adapter = adapter;
        this.logger = logger;
    }

    // Notes operations
    async createNote(note: Omit<Note, 'id' | 'created_at' | 'updated_at'>): Promise<string> {
        const id = this.generateId();
        const now = new Date().toISOString();
        
        await this.adapter.execute(`
            INSERT INTO notes (id, created_at, updated_at, path, name, base_name, text)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `, [id, now, now, note.path, note.name, note.base_name, note.text]);
        
        await this.adapter.save();
        return id;
    }

    async updateNote(id: string, updates: Partial<Pick<Note, 'path' | 'name' | 'base_name' | 'text'>>): Promise<void> {
        const now = new Date().toISOString();
        const setClause = Object.keys(updates).map(key => `${key} = ?`).join(', ');
        const values = [...Object.values(updates), now, id];
        
        await this.adapter.execute(`
            UPDATE notes SET ${setClause}, updated_at = ? WHERE id = ?
        `, values);
        
        await this.adapter.save();
    }

    async deleteNote(id: string): Promise<void> {
        await this.adapter.execute('DELETE FROM notes WHERE id = ?', [id]);
        await this.adapter.save();
    }

    async getNote(id: string): Promise<Note | null> {
        return await this.adapter.get('SELECT * FROM notes WHERE id = ?', [id]);
    }

    async getNoteByPath(path: string): Promise<Note | null> {
        return await this.adapter.get('SELECT * FROM notes WHERE path = ?', [path]);
    }

    async getAllNotes(): Promise<Note[]> {
        return await this.adapter.query('SELECT * FROM notes ORDER BY created_at DESC');
    }

    // Chunks operations
    async createChunk(chunk: Omit<Chunk, 'id' | 'created_at' | 'updated_at'>): Promise<string> {
        const id = this.generateId();
        const now = new Date().toISOString();
        
        await this.adapter.execute(`
            INSERT INTO chunks (id, note_id, created_at, updated_at, chunk_index, text)
            VALUES (?, ?, ?, ?, ?, ?)
        `, [id, chunk.note_id, now, now, chunk.chunk_index, chunk.text]);
        
        await this.adapter.save();
        return id;
    }

    async updateChunk(id: string, updates: Partial<Pick<Chunk, 'chunk_index' | 'text'>>): Promise<void> {
        const now = new Date().toISOString();
        const setClause = Object.keys(updates).map(key => `${key} = ?`).join(', ');
        const values = [...Object.values(updates), now, id];
        
        await this.adapter.execute(`
            UPDATE chunks SET ${setClause}, updated_at = ? WHERE id = ?
        `, values);
        
        await this.adapter.save();
    }

    async deleteChunk(id: string): Promise<void> {
        await this.adapter.execute('DELETE FROM chunks WHERE id = ?', [id]);
        await this.adapter.save();
    }

    async getChunksForNote(noteId: string): Promise<Chunk[]> {
        return await this.adapter.query(
            'SELECT * FROM chunks WHERE note_id = ? ORDER BY chunk_index',
            [noteId]
        );
    }

    async deleteChunksForNote(noteId: string): Promise<void> {
        await this.adapter.execute('DELETE FROM chunks WHERE note_id = ?', [noteId]);
        await this.adapter.save();
    }

    // Vectors operations
    async createVector(vector: Omit<Vector, 'id' | 'created_at' | 'updated_at'>): Promise<string> {
        const id = this.generateId();
        const now = new Date().toISOString();
        
        await this.adapter.execute(`
            INSERT INTO vectors (id, note_id, chunk_id, block_id, type, created_at, updated_at, vector)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `, [id, vector.note_id, vector.chunk_id || null, vector.block_id || null, vector.type, now, now, vector.vector]);
        
        await this.adapter.save();
        return id;
    }

    async updateVector(id: string, vector: Int8Array): Promise<void> {
        const now = new Date().toISOString();
        
        await this.adapter.execute(`
            UPDATE vectors SET vector = ?, updated_at = ? WHERE id = ?
        `, [vector, now, id]);
        
        await this.adapter.save();
    }

    async deleteVector(id: string): Promise<void> {
        await this.adapter.execute('DELETE FROM vectors WHERE id = ?', [id]);
        await this.adapter.save();
    }

    async getVectorsForNote(noteId: string): Promise<Vector[]> {
        const rows = await this.adapter.query(
            'SELECT * FROM vectors WHERE note_id = ?',
            [noteId]
        );
        
        return rows.map(row => ({
            ...row,
            type: row.type as VectorType,
            vector: new Int8Array(row.vector) // Convert BLOB back to Int8Array
        }));
    }

    async deleteVectorsForNote(noteId: string): Promise<void> {
        await this.adapter.execute('DELETE FROM vectors WHERE note_id = ?', [noteId]);
        await this.adapter.save();
    }

    // Enhanced vector storage/retrieval methods
    async getVectorByNoteAndChunk(noteId: string, chunkId?: string): Promise<Vector | null> {
        const query = chunkId 
            ? 'SELECT * FROM vectors WHERE note_id = ? AND chunk_id = ?'
            : 'SELECT * FROM vectors WHERE note_id = ? AND chunk_id IS NULL';
        
        const params = chunkId ? [noteId, chunkId] : [noteId];
        const row = await this.adapter.get(query, params);
        
        if (!row) return null;
        
        return {
            ...row,
            type: row.type as VectorType,
            vector: new Int8Array(row.vector)
        };
    }

    async getAllVectors(): Promise<Vector[]> {
        const rows = await this.adapter.query('SELECT * FROM vectors ORDER BY created_at DESC');
        
        return rows.map(row => ({
            ...row,
            type: row.type as VectorType,
            vector: new Int8Array(row.vector)
        }));
    }

    async getSimilarVectors(queryVector: Int8Array, limit: number): Promise<Vector[]> {
        return await this.adapter.getSimilarVectors(queryVector, limit);
    }

    async isVectorIndexAvailable(): Promise<boolean> {
        return await this.adapter.isVectorIndexAvailable();
    }

    async getVectorCount(): Promise<number> {
        const result = await this.adapter.get('SELECT COUNT(*) as count FROM vectors');
        return result?.count || 0;
    }

    async getVectorCountByType(): Promise<{ note: number; block: number }> {
        const results = await this.adapter.query(`
            SELECT type, COUNT(*) as count 
            FROM vectors 
            GROUP BY type
        `);
        
        const counts = { note: 0, block: 0 };
        results.forEach(row => {
            if (row.type === 'note') counts.note = row.count;
            if (row.type === 'block') counts.block = row.count;
        });
        
        return counts;
    }

    // Change detection methods
    async getFilesModifiedSinceLastVectorCreation(): Promise<{ path: string; lastModified: number }[]> {
        // Get all files that are not fully processed (either note vector or chunk vectors are outdated)
        const query = `
            SELECT DISTINCT
                n.path,
                n.updated_at as note_updated
            FROM notes n
            LEFT JOIN chunks c ON n.id = c.note_id
            LEFT JOIN vectors v_note ON n.id = v_note.note_id AND v_note.type = 'note'
            LEFT JOIN vectors v_chunk ON c.id = v_chunk.chunk_id AND v_chunk.type = 'chunk'
            WHERE 
                -- Missing note vector
                v_note.id IS NULL
                -- Note vector is outdated
                OR (v_note.created_at IS NOT NULL AND v_note.created_at < n.updated_at)
                -- Has chunks but missing chunk vectors
                OR (c.id IS NOT NULL AND v_chunk.id IS NULL)
                -- Has chunks with outdated vectors
                OR (c.id IS NOT NULL AND v_chunk.created_at IS NOT NULL AND v_chunk.created_at < n.updated_at)
            ORDER BY n.updated_at DESC
        `;
        
        const results = await this.adapter.query(query);
        
        return results.map(row => ({
            path: row.path,
            lastModified: new Date(row.note_updated).getTime()
        }));
    }

    async getFilesWithoutVectors(): Promise<{ path: string; noteId: string }[]> {
        // Get all notes that have no note-level vectors at all
        const query = `
            SELECT n.id as note_id, n.path
            FROM notes n
            LEFT JOIN vectors v ON n.id = v.note_id AND v.type = 'note'
            WHERE v.id IS NULL
            ORDER BY n.created_at DESC
        `;
        
        const results = await this.adapter.query(query);
        
        return results.map(row => ({
            path: row.path,
            noteId: row.note_id
        }));
    }

    async getOutdatedFiles(): Promise<{ path: string; noteId: string; lastModified: number }[]> {
        // Combine both modified files and files without vectors
        const [modifiedFiles, filesWithoutVectors] = await Promise.all([
            this.getFilesModifiedSinceLastVectorCreation(),
            this.getFilesWithoutVectors()
        ]);

        // For files without vectors, we need to get their note IDs
        const filesWithoutVectorsWithIds = await Promise.all(
            filesWithoutVectors.map(async (file) => {
                const note = await this.getNoteByPath(file.path);
                return {
                    path: file.path,
                    noteId: file.noteId,
                    lastModified: note ? new Date(note.updated_at).getTime() : Date.now()
                };
            })
        );

        // Combine and deduplicate by path
        const allFiles = new Map<string, { path: string; noteId: string; lastModified: number }>();
        
        // Add modified files (need to get note IDs)
        for (const file of modifiedFiles) {
            const note = await this.getNoteByPath(file.path);
            if (note) {
                allFiles.set(file.path, {
                    path: file.path,
                    noteId: note.id,
                    lastModified: file.lastModified
                });
            }
        }
        
        // Add files without vectors
        for (const file of filesWithoutVectorsWithIds) {
            allFiles.set(file.path, file);
        }

        return Array.from(allFiles.values());
    }

    // Cleanup methods for orphaned data
    async cleanupOrphanedVectors(): Promise<number> {
        // Remove vectors that reference non-existent notes
        const query = `
            DELETE FROM vectors 
            WHERE note_id NOT IN (SELECT id FROM notes)
        `;
        
        const result = await this.adapter.execute(query);
        await this.adapter.save();
        
        // Return count of cleaned up vectors (sql.js doesn't provide affected row counts)
        // For performance reasons, we don't query to count deleted rows
        return 0;
    }

    async cleanupOrphanedChunks(): Promise<number> {
        // Remove chunks that reference non-existent notes
        const query = `
            DELETE FROM chunks 
            WHERE note_id NOT IN (SELECT id FROM notes)
        `;
        
        await this.adapter.execute(query);
        await this.adapter.save();
        
        // Return count of cleaned up chunks (sql.js doesn't provide affected row counts)
        // For performance reasons, we don't query to count deleted rows
        return 0;
    }

    async cleanupVectorsForDeletedChunks(): Promise<number> {
        // Remove vectors that reference non-existent chunks
        const query = `
            DELETE FROM vectors 
            WHERE chunk_id IS NOT NULL 
            AND chunk_id NOT IN (SELECT id FROM chunks)
        `;
        
        await this.adapter.execute(query);
        await this.adapter.save();
        
        // Return count of cleaned up vectors (sql.js doesn't provide affected row counts)
        // For performance reasons, we don't query to count deleted rows
        return 0;
    }

    async performFullCleanup(): Promise<{ vectors: number; chunks: number; vectorsForChunks: number }> {
        const [vectors, chunks, vectorsForChunks] = await Promise.all([
            this.cleanupOrphanedVectors(),
            this.cleanupOrphanedChunks(),
            this.cleanupVectorsForDeletedChunks()
        ]);
        
        return { vectors, chunks, vectorsForChunks };
    }

    async getOrphanedDataCounts(): Promise<{ orphanedVectors: number; orphanedChunks: number; orphanedChunkVectors: number }> {
        const [orphanedVectors, orphanedChunks, orphanedChunkVectors] = await Promise.all([
            this.adapter.get(`
                SELECT COUNT(*) as count FROM vectors 
                WHERE note_id NOT IN (SELECT id FROM notes)
            `),
            this.adapter.get(`
                SELECT COUNT(*) as count FROM chunks 
                WHERE note_id NOT IN (SELECT id FROM notes)
            `),
            this.adapter.get(`
                SELECT COUNT(*) as count FROM vectors 
                WHERE chunk_id IS NOT NULL 
                AND chunk_id NOT IN (SELECT id FROM chunks)
            `)
        ]);
        
        return {
            orphanedVectors: orphanedVectors?.count || 0,
            orphanedChunks: orphanedChunks?.count || 0,
            orphanedChunkVectors: orphanedChunkVectors?.count || 0
        };
    }

    // Vector timestamp tracking methods
    async getLastVectorCreationTime(noteId: string): Promise<Date | null> {
        const result = await this.adapter.get(`
            SELECT MAX(created_at) as last_created
            FROM vectors
            WHERE note_id = ?
        `, [noteId]);
        
        return result?.last_created ? new Date(result.last_created) : null;
    }

    async getVectorCreationStats(): Promise<{
        totalVectors: number;
        oldestVector: Date | null;
        newestVector: Date | null;
        avgVectorsPerNote: number;
    }> {
        const stats = await this.adapter.get(`
            SELECT 
                COUNT(*) as total_vectors,
                MIN(created_at) as oldest,
                MAX(created_at) as newest,
                COUNT(*) * 1.0 / COUNT(DISTINCT note_id) as avg_per_note
            FROM vectors
        `);
        
        return {
            totalVectors: stats?.total_vectors || 0,
            oldestVector: stats?.oldest ? new Date(stats.oldest) : null,
            newestVector: stats?.newest ? new Date(stats.newest) : null,
            avgVectorsPerNote: stats?.avg_per_note || 0
        };
    }

    async getNotesOlderThan(date: Date): Promise<Note[]> {
        // Get notes that haven't been updated since the given date
        const isoDate = date.toISOString();
        return await this.adapter.query(`
            SELECT * FROM notes 
            WHERE updated_at < ? 
            ORDER BY updated_at ASC
        `, [isoDate]);
    }

    async getVectorsOlderThan(date: Date): Promise<Vector[]> {
        // Get vectors created before the given date
        const isoDate = date.toISOString();
        const rows = await this.adapter.query(`
            SELECT * FROM vectors 
            WHERE created_at < ? 
            ORDER BY created_at ASC
        `, [isoDate]);
        
        return rows.map(row => ({
            ...row,
            type: row.type as VectorType,
            vector: new Int8Array(row.vector)
        }));
    }

    async isNoteVectorUpToDate(noteId: string): Promise<boolean> {
        // Check if BOTH note-level vector AND all chunk vectors are up to date
        const result = await this.adapter.get(`
            SELECT 
                n.updated_at as note_updated,
                COUNT(c.id) as total_chunks,
                COUNT(CASE WHEN v_note.type = 'note' THEN 1 END) as note_vectors,
                COUNT(CASE WHEN v_chunk.type = 'chunk' THEN 1 END) as chunk_vectors,
                MIN(CASE WHEN v_note.type = 'note' THEN v_note.created_at END) as note_vector_created,
                MIN(CASE WHEN v_chunk.type = 'chunk' THEN v_chunk.created_at END) as oldest_chunk_vector_created
            FROM notes n
            LEFT JOIN chunks c ON n.id = c.note_id
            LEFT JOIN vectors v_note ON n.id = v_note.note_id AND v_note.type = 'note'
            LEFT JOIN vectors v_chunk ON c.id = v_chunk.chunk_id AND v_chunk.type = 'chunk'
            WHERE n.id = ?
            GROUP BY n.id, n.updated_at
        `, [noteId]);
        
        if (!result) return false;
        
        const noteUpdated = new Date(result.note_updated);
        
        // Check note-level vector exists and is up to date
        if (!result.note_vectors || result.note_vectors === 0) return false;
        if (!result.note_vector_created) return false;
        if (new Date(result.note_vector_created) < noteUpdated) return false;
        
        // If there are chunks, check that all chunks have vectors and they're up to date
        if (result.total_chunks > 0) {
            if (result.chunk_vectors !== result.total_chunks) return false; // Missing chunk vectors
            if (!result.oldest_chunk_vector_created) return false;
            if (new Date(result.oldest_chunk_vector_created) < noteUpdated) return false;
        }
        
        return true;
    }

    async getNoteProcessingStatus(noteId: string): Promise<{
        noteUpdated: Date;
        hasNoteVector: boolean;
        noteVectorUpToDate: boolean;
        totalChunks: number;
        chunksWithVectors: number;
        allChunkVectorsUpToDate: boolean;
        fullyProcessed: boolean;
    }> {
        const result = await this.adapter.get(`
            SELECT 
                n.updated_at as note_updated,
                COUNT(c.id) as total_chunks,
                COUNT(CASE WHEN v_note.type = 'note' THEN 1 END) as note_vectors,
                COUNT(CASE WHEN v_chunk.type = 'chunk' THEN 1 END) as chunk_vectors,
                MIN(CASE WHEN v_note.type = 'note' THEN v_note.created_at END) as note_vector_created,
                MIN(CASE WHEN v_chunk.type = 'chunk' THEN v_chunk.created_at END) as oldest_chunk_vector_created
            FROM notes n
            LEFT JOIN chunks c ON n.id = c.note_id
            LEFT JOIN vectors v_note ON n.id = v_note.note_id AND v_note.type = 'note'
            LEFT JOIN vectors v_chunk ON c.id = v_chunk.chunk_id AND v_chunk.type = 'chunk'
            WHERE n.id = ?
            GROUP BY n.id, n.updated_at
        `, [noteId]);
        
        if (!result) {
            throw new Error(`Note not found: ${noteId}`);
        }
        
        const noteUpdated = new Date(result.note_updated);
        const hasNoteVector = result.note_vectors > 0;
        const noteVectorUpToDate = hasNoteVector && 
            result.note_vector_created && 
            new Date(result.note_vector_created) >= noteUpdated;
        
        const allChunkVectorsUpToDate = result.total_chunks === 0 || (
            result.chunk_vectors === result.total_chunks &&
            result.oldest_chunk_vector_created &&
            new Date(result.oldest_chunk_vector_created) >= noteUpdated
        );
        
        return {
            noteUpdated,
            hasNoteVector,
            noteVectorUpToDate,
            totalChunks: result.total_chunks,
            chunksWithVectors: result.chunk_vectors,
            allChunkVectorsUpToDate,
            fullyProcessed: noteVectorUpToDate && allChunkVectorsUpToDate
        };
    }

    async processNoteVector(noteId: string, embeddingService: EmbeddingService): Promise<void> {
        const note = await this.getNote(noteId);
        if (!note) {
            throw new Error('Note not found: ${noteId}');
        }
        const trimmedContent = note.text.trim();
        if (!trimmedContent || trimmedContent.length < 16) {
            return
        }

        if (await this.isNoteVectorUpToDate(noteId)) {
            return;  // up to date already
        }

        try {
            const noteVector = await embeddingService.embedText(note.text);
            await this.createVector({
                note_id: noteId,
                type: VectorType.NOTE,
                vector: noteVector
            });
            
            // Also add note content to FTS index
            await this.adapter.insertFTSContent(
                `note_${noteId}`,
                'note',
                noteId,
                note.text,
                note.path,
                note.name
            );
        } catch (error) {
            this.logger.error('SqlJsAdapter', `Failed to process note ${noteId}`, error);
            throw error;
        }
    }

    async insertBlocksForNote(noteId: string, blocks: Block[]): Promise<{ blockIds: string[] }> {
        const blockIds: string[] = [];
        
        // Delete existing blocks for this note first (clean slate approach)
        await this.adapter.execute('DELETE FROM blocks WHERE note_id = ?', [noteId]);
        
        // Insert each block
        for (const block of blocks) {
            const blockId = this.generateId();
            const now = new Date().toISOString();
            
            await this.adapter.execute(`
                INSERT INTO blocks (id, note_id, created_at, updated_at, type, content, obsidian_id, start_position, end_position)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `, [
                blockId,
                noteId,
                now,
                now,
                block.type,
                block.content,
                block.obsidian_id,
                JSON.stringify(block.start_position),
                JSON.stringify(block.end_position)
            ]);
            
            blockIds.push(blockId);
        }
        
        await this.adapter.save();
        
        return { blockIds };
    }

    async getBlocksForNote(noteId: string, filterNull: boolean = false): Promise<Block[]> {
        const rows = await this.adapter.query(
            'SELECT * FROM blocks WHERE note_id = ? ORDER BY created_at',
            [noteId]
        );
        
        const blocks: Block[] = rows.map(row => ({
            id: row.id,
            type: row.type as BlockType,
            content: row.content,
            obsidian_id: row.obsidian_id,
            start_position: JSON.parse(row.start_position),
            end_position: JSON.parse(row.end_position)
        }));
        
        if (filterNull) {
            return blocks.filter(block => block.content && block.content.trim().length > 0);
        }
        
        return blocks;
    }

    async processBlockVectors(
        noteId: string,
        blockIds: string[],
        embeddingService: EmbeddingService
    ) {
        if (blockIds.length > 0) {
            // Get the blocks for this note, filtering out null content
            const blocks = await this.getBlocksForNote(noteId, true);
            if (blocks.length === 0) {
                return;
            }

            // Define whitelist of block types to process
            const allowedBlockTypes = [
                BlockType.PARAGRAPH,
                BlockType.HEADING,
                BlockType.LIST,
                BlockType.BLOCKQUOTE
            ];
            
            // Filter blocks to only process allowed types
            const filteredBlocks = blocks.filter(block => allowedBlockTypes.includes(block.type));
            
            if (filteredBlocks.length === 0) {
                return;
            }

            // Extract text content from blocks for embedding
            const blockTexts = filteredBlocks.map(block => block.content);
            
            // Generate embeddings for all blocks at once
            const embeddings = await embeddingService.embedTexts(blockTexts);
            
            // Store the embeddings in the vectors table and FTS content
            for (let i = 0; i < embeddings.length; i++) {
                const block = filteredBlocks[i];
                const embedding = embeddings[i];
                
                await this.createVector({
                    note_id: noteId,
                    chunk_id: undefined, // No chunk for block vectors
                    block_id: block.id,
                    type: VectorType.BLOCK,
                    vector: embedding
                });
                
                // Get note info for FTS indexing
                const note = await this.getNote(noteId);
                if (note) {
                    await this.adapter.insertFTSContent(
                        `block_${block.id}`,
                        'block',
                        noteId,
                        block.content,
                        note.path,
                        note.name,
                        block.id
                    );
                }
            }
            
            this.logger.info('SqlJsAdapter', `Generated and stored ${embeddings.length} block embeddings for note ${noteId}`);
        }
    }




    /**
     * Unified method to create or update a note, checking for existence and changes
     * Returns true if the note was created or updated, false if no changes were needed
     */
    async upsertNote(filePath: string, fileName: string, fileBaseName: string, content: string): Promise<{ noteId: string; changed: boolean }> {
        try {
            const existingNote = await this.getNoteByPath(filePath);
            
            if (existingNote) {
                // Note exists - check if content has changed
                if (existingNote.text !== content || 
                    existingNote.name !== fileName || 
                    existingNote.base_name !== fileBaseName) {
                    
                    // Content has changed - update note
                    await this.updateNote(existingNote.id, {
                        name: fileName,
                        base_name: fileBaseName,
                        text: content,
                        path: filePath
                    });
                    
                    return { noteId: existingNote.id, changed: true };
                } else {
                    // Content unchanged - skip
                    return { noteId: existingNote.id, changed: false };
                }
            } else {
                // Note doesn't exist - create new note
                const newNoteId = await this.createNote({
                    name: fileName,
                    base_name: fileBaseName,
                    text: content,
                    path: filePath
                });
                
                return { noteId: newNoteId, changed: true };
            }
        } catch (error) {
            this.logger.error('SqlJsAdapter', `Failed to upsert note ${filePath}`, error);
            throw error;
        }
    }


    async searchFTS(query: string, limit: number = 10): Promise<FTSResult[]> {
        return await this.adapter.searchFTS(query, limit);
    }

    async getFTSTableStats(): Promise<{ count: number; sampleContent: string | null }> {
        const countResult = await this.adapter.get('SELECT COUNT(*) as count FROM fts_content');
        const sampleResult = await this.adapter.get('SELECT content FROM fts_content LIMIT 1');
        
        return {
            count: countResult?.count || 0,
            sampleContent: sampleResult?.content || null
        };
    }

    async ensureFTSContentForAllNotes(): Promise<void> {
        this.logger.info('DatabaseService', 'Ensuring FTS content exists for all notes...');
        
        // Get all notes
        const allNotes = await this.getAllNotes();
        
        // Get existing FTS content note IDs
        const existingFTSNoteIds = new Set<string>();
        const ftsRows = await this.adapter.query('SELECT DISTINCT note_id FROM fts_content');
        ftsRows.forEach(row => existingFTSNoteIds.add(row.note_id));
        
        let populated = 0;
        
        for (const note of allNotes) {
            if (!existingFTSNoteIds.has(note.id)) {
                
                // Add note content to FTS
                await this.adapter.insertFTSContent(
                    `note_${note.id}`,
                    'note',
                    note.id,
                    note.text,
                    note.path,
                    note.name
                );
                
                // Add block content to FTS
                const blocks = await this.getBlocksForNote(note.id);
                for (const block of blocks) {
                    await this.adapter.insertFTSContent(
                        `block_${block.id}`,
                        'block',
                        note.id,
                        block.content,
                        note.path,
                        note.name,
                        block.id
                    );
                }
                
                populated++;
            }
        }
        
        if (populated > 0) {
            this.logger.info('DatabaseService', `Populated FTS content for ${populated} notes`);
        }
    }

    async getVectorDatabaseStats(): Promise<{
        totalNotes: number;
        processedNotes: number;
        totalVectors: number;
        vectorsByType: { note: number; block: number };
        outdatedNotes: number;
        orphanedData: { orphanedVectors: number; orphanedChunks: number; orphanedChunkVectors: number };
    }> {
        const [
            allNotes,
            vectorCount,
            vectorsByType,
            outdatedFiles,
            orphanedData
        ] = await Promise.all([
            this.getAllNotes(),
            this.getVectorCount(),
            this.getVectorCountByType(),
            this.getOutdatedFiles(),
            this.getOrphanedDataCounts()
        ]);

        // Count how many notes are fully processed
        let processedNotes = 0;
        for (const note of allNotes) {
            if (await this.isNoteVectorUpToDate(note.id)) {
                processedNotes++;
            }
        }

        return {
            totalNotes: allNotes.length,
            processedNotes,
            totalVectors: vectorCount,
            vectorsByType,
            outdatedNotes: outdatedFiles.length,
            orphanedData
        };
    }


    // Helper methods
    private generateId(): string {
        return Date.now().toString(36) + Math.random().toString(36).substr(2);
    }
}
