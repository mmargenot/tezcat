import { Plugin, normalizePath } from 'obsidian';
import { EmbeddingService } from './embedding_service';
import { Logger } from './logger';
import { Block, BlockType } from './note_processor';
import initSqlJs, { Database, SqlValue, SqlJsStatic, BindParams } from 'sql.js';
import sqlWasm from '../node_modules/sql.js/dist/sql-wasm.wasm';

/** Tables from earlier versions that nothing uses any more (token chunks and the LSH index). */
const OBSOLETE_TABLES = ['lsh_buckets', 'lsh_vector_buckets', 'lsh_hash_functions', 'lsh_configs', 'chunks'];


export interface DatabaseAdapter {
    close(): Promise<void>;
    
    // Schema creation methods - each adapter implements its own table creation
    createNotesTable(): Promise<void>;
    createVectorsTable(): Promise<void>;
    createBlocksTable(): Promise<void>;
    createFTSTable(): Promise<void>;
    dropAllTables(): Promise<void>;
    
    // Basic database operations
    execute(sql: string, params?: BindParams): Promise<void>;
    query(sql: string, params?: BindParams): Promise<Record<string, SqlValue>[]>;
    get(sql: string, params?: BindParams): Promise<Record<string, SqlValue> | null>;
    
    // FTS operations
    searchFTS(query: string, limit: number): Promise<FTSResult[]>;
    insertFTSContent(id: string, type: string, noteId: string, content: string, notePath: string, noteName: string, blockId?: string): Promise<void>;
    deleteFTSContentForNote(noteId: string): Promise<void>;
    
    // Persistence operations
    save(): Promise<void>;
    load(): Promise<void>;
}


export class SqlJsDatabaseAdapter implements DatabaseAdapter {
    private db: Database | null = null;
    private SQL: SqlJsStatic | null = null;
    private plugin: Plugin;
    private logger: Logger;
    /** Stored in the plugin's own folder, whatever that folder is named. */
    private readonly dbPath: string;

    constructor(plugin: Plugin, logger: Logger) {
        this.plugin = plugin;
        this.logger = logger;
        const pluginDir = plugin.manifest.dir ?? `${plugin.app.vault.configDir}/plugins/${plugin.manifest.id}`;
        this.dbPath = normalizePath(`${pluginDir}/tezcat.db`);
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

            // Remove tables left behind by earlier versions
            for (const table of OBSOLETE_TABLES) {
                await this.execute(`DROP TABLE IF EXISTS ${table}`);
            }
            
            // Create all tables (will be no-op if they already exist due to IF NOT EXISTS)
            await this.createNotesTable();
            await this.createVectorsTable();
            await this.createBlocksTable();
            await this.createFTSTable();
            
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

    async createVectorsTable(): Promise<void> {
        if (!this.db) throw new Error('Database not initialized');
        
        // chunk_id is unused but kept so existing databases don't need a migration.
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
        for (const table of OBSOLETE_TABLES) {
            await this.execute(`DROP TABLE IF EXISTS ${table}`);
        }
        await this.execute('DROP TABLE IF EXISTS vectors');
        await this.execute('DROP TABLE IF EXISTS blocks');
        await this.execute('DROP TABLE IF EXISTS fts_content');
        await this.execute('DROP TABLE IF EXISTS notes');
        
        this.logger.info('SqlJsAdapter', 'All tables dropped successfully');
    }

    async execute(sql: string, params?: BindParams): Promise<void> {
        if (!this.db) throw new Error('Database not initialized');
        this.db.run(sql, params);
    }

    async query(sql: string, params?: BindParams): Promise<Record<string, SqlValue>[]> {
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

    async get(sql: string, params?: BindParams): Promise<Record<string, SqlValue> | null> {
        const results = await this.query(sql, params);
        return results[0] || null;
    }

    async save(): Promise<void> {
        if (!this.db) return;
        
        const data = this.db.export();
        
        await this.plugin.app.vault.adapter.writeBinary(this.dbPath, data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer);
    }

    async load(): Promise<void> {
        try {
            const adapter = this.plugin.app.vault.adapter;

            if (await adapter.exists(this.dbPath)) {
                const buffer = await adapter.readBinary(this.dbPath);
                const data = new Uint8Array(buffer);
                if (!this.SQL) throw new Error('SQL not initialized');
                this.db = new this.SQL.Database(data);
                this.logger.info('SqlJsAdapter', 'Database loaded from disk');
            }
        } catch (error) {
            this.logger.info('SqlJsAdapter', 'No existing database found, starting fresh');
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
            id: row.id as string,
            type: row.type as string,
            noteId: row.note_id as string,
            content: row.content as string,
            notePath: row.note_path as string,
            noteName: row.note_name as string,
            blockId: row.block_id as string | undefined,
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
}

// Enums and types
export enum VectorType {
    NOTE = 'note',
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

export type Vector = {
    id: string;
    note_id: string;
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
        const row = await this.adapter.get('SELECT * FROM notes WHERE id = ?', [id]);
        if (!row) return null;
        return row as Note;
    }

    async getNoteByPath(path: string): Promise<Note | null> {
        const row = await this.adapter.get('SELECT * FROM notes WHERE path = ?', [path]);
        if (!row) return null;
        return row as Note;
    }

    async getAllNotes(): Promise<Note[]> {
        const rows = await this.adapter.query('SELECT * FROM notes ORDER BY created_at DESC');
        return rows as Note[];
    }

    // Vectors operations
    async createVector(vector: Omit<Vector, 'id' | 'created_at' | 'updated_at'>): Promise<string> {
        const id = this.generateId();
        const now = new Date().toISOString();
        
        await this.adapter.execute(`
            INSERT INTO vectors (id, note_id, block_id, type, created_at, updated_at, vector)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `, [id, vector.note_id, vector.block_id || null, vector.type, now, now, vector.vector as unknown as Uint8Array]);
        
        await this.adapter.save();
        return id;
    }

    async deleteVectorsForNote(noteId: string): Promise<void> {
        await this.adapter.execute('DELETE FROM vectors WHERE note_id = ?', [noteId]);
        await this.adapter.save();
    }

    async getAllVectors(): Promise<Vector[]> {
        const rows = await this.adapter.query('SELECT * FROM vectors ORDER BY created_at DESC');

        return rows.map(row => ({
            id: row.id as string,
            note_id: row.note_id as string,
            block_id: (row.block_id as string | null) || undefined,
            type: row.type as VectorType,
            created_at: row.created_at as string,
            updated_at: row.updated_at as string,
            vector: new Int8Array(row.vector as Uint8Array)
        }));
    }

    async getVectorCount(): Promise<number> {
        const result = await this.adapter.get('SELECT COUNT(*) as count FROM vectors');
        return (result?.count as number) || 0;
    }

    async getVectorCountByType(): Promise<{ note: number; block: number }> {
        const results = await this.adapter.query(`
            SELECT type, COUNT(*) as count 
            FROM vectors 
            GROUP BY type
        `);
        
        const counts = { note: 0, block: 0 };
        results.forEach(row => {
            if (row.type === 'note') counts.note = row.count as number;
            if (row.type === 'block') counts.block = row.count as number;
        });
        
        return counts;
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
            id: row.id as string,
            type: row.type as BlockType,
            content: row.content as string,
            obsidian_id: (row.obsidian_id as string) || null,
            start_position: JSON.parse(row.start_position as string),
            end_position: JSON.parse(row.end_position as string)
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

    async ensureFTSContentForAllNotes(): Promise<void> {
        this.logger.info('DatabaseService', 'Ensuring FTS content exists for all notes...');
        
        // Get all notes
        const allNotes = await this.getAllNotes();
        
        // Get existing FTS content note IDs
        const existingFTSNoteIds = new Set<string>();
        const ftsRows = await this.adapter.query('SELECT DISTINCT note_id FROM fts_content');
        ftsRows.forEach(row => existingFTSNoteIds.add(row.note_id as string));
        
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
        totalVectors: number;
        vectorsByType: { note: number; block: number };
    }> {
        const [allNotes, vectorCount, vectorsByType] = await Promise.all([
            this.getAllNotes(),
            this.getVectorCount(),
            this.getVectorCountByType()
        ]);

        return {
            totalNotes: allNotes.length,
            totalVectors: vectorCount,
            vectorsByType
        };
    }


    // Helper methods
    private generateId(): string {
        return Date.now().toString(36) + Math.random().toString(36).substr(2);
    }
}
