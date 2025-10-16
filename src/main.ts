import { App, Editor, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting, WorkspaceLeaf} from 'obsidian';
import { TezcatView, VIEW_TYPE } from './search_view';
import { DatabaseService, SqlJsDatabaseAdapter } from './database_service';
import { EmbeddingService, OllamaEmbeddingProvider, OpenAIEmbeddingProvider, EmbeddingProvider, VectorUtils, OllamaModelManager } from './embedding_service';
import { ChunkingService } from './chunking_service';
import { SearchService, SearchResult } from './search_service';
import { logger, LogLevel } from './logger';
import { ValidationService, SystemValidationResult, ValidationResult } from './validation_service';
import { NoteProcessor } from './note_processor';


type EmbeddingProviderType = 'openai' | 'ollama';
type SearchCadence = 'always' | 'sometimes' | 'occasionally';
type SearchMode = 'vector' | 'hybrid';

interface TezcatSettings {
    embeddingProvider: EmbeddingProviderType;
    embeddingModel: string;
    vectorSize: number;
    openaiApiKey: string;
    ollamaBaseUrl: string;
    chunkSize: number;
    chunkOverlap: number;
    contextWindowWords: number;
    searchCadence: SearchCadence;
    searchMode: SearchMode;
    logLevel: LogLevel;
    highlightBlockOnOpen: boolean;
}

const DEFAULT_SETTINGS: TezcatSettings = {
    embeddingProvider: 'ollama',
    embeddingModel: 'nomic-embed-text:v1.5',
    vectorSize: 768,
    openaiApiKey: '',
    ollamaBaseUrl: 'http://localhost:11434',
    chunkSize: 128,
    chunkOverlap: 16,
    contextWindowWords: 64, // Smaller context window for more focused search
    searchCadence: 'always',
    searchMode: 'hybrid',
    logLevel: LogLevel.INFO,
    highlightBlockOnOpen: true
}

export default class Tezcat extends Plugin {
    settings: TezcatSettings;
    public databaseService: DatabaseService;
    public databaseAdapter: SqlJsDatabaseAdapter;
    public embeddingService: EmbeddingService;
    public chunkingService: ChunkingService;
    public searchService: SearchService;
    private noteProcessor: NoteProcessor;
    private vectorUtils: VectorUtils;
    private validationService: ValidationService;
    public modelManager: OllamaModelManager | null = null;
    private systemValidationResult: SystemValidationResult | null = null;
    public isSystemValid: boolean = false;
    public isOperationInProgress: boolean = false;
    private searchDebounceTimer: number | null = null;
    private lastSearchContext: string = '';
    private get CONTEXT_WINDOW_WORDS() { 
        return this.settings.contextWindowWords; // Words to extract around cursor for search context
    }
    private searchSuppressedUntil: number = 0; // Timestamp to suppress search until
    private currentNoteId: string | null = null; // Track current note for navigation events
    private statusBarItem: HTMLElement | null = null; // Status bar item for system status

    async onload() {
        await this.loadSettings();
        
        // Configure logger from settings
        logger.setLevel(this.settings.logLevel);
        logger.info('Plugin', 'Loading Tezcat plugin');
        
        
        // Initialize vector utils and validation service
        this.vectorUtils = new VectorUtils(logger);
        this.validationService = new ValidationService(logger);
        
        // Initialize database (only this needs async initialization due to file I/O)
        this.databaseAdapter = new SqlJsDatabaseAdapter(this, this.vectorUtils, logger);
        await this.databaseAdapter.initialize();
        
        // Initialize services but don't validate yet
        this.databaseService = new DatabaseService(this.databaseAdapter, logger);
        this.initializeEmbeddingServices();
        this.chunkingService = new ChunkingService(this.settings.chunkSize, this.settings.chunkOverlap, this, logger);
        this.searchService = new SearchService(this.databaseService, this.embeddingService, logger);

        // Initialize note processor
        this.noteProcessor = new NoteProcessor();

        // Create status bar item
        this.statusBarItem = this.addStatusBarItem();
        this.addStatusBarStyles();
        this.updateStatusBar('sync', 'Tezcat: Initializing...', 'tezcat-status-initializing');
        
        // Schedule validation and setup to run when workspace is ready
        this.app.workspace.onLayoutReady(() => {
            this.performValidationAndSetup();
        });
        
        //net new set up view
        this.registerView(
          VIEW_TYPE,
          (leaf) => new TezcatView(leaf)
        );
        
        // Add command to process all vault files
        this.addCommand({
            id: 'process-all-files',
            name: 'Process All Files',
            callback: async () => {
                await this.processAllVaultFilesIntoDatabase();
            }
        });
        
        // Add vector database commands
        this.registerCommand('rebuild-database', 'Rebuild Database', () => this.rebuildDatabase());
        this.registerCommand('show-vector-database-stats', 'Show Vector Database Stats', () => this.showVectorDatabaseStats());
        this.registerCommand('rebuild-vector-index', 'Rebuild Vector Index', () => this.rebuildVectorIndex());
        this.registerCommand('vector-search', 'Vector Search', () => this.performVectorSearch());


        // This adds a settings tab so the user can configure various aspects of the plugin
        this.addSettingTab(new TezcatSettingTab(this.app, this));

        // If the plugin hooks up any global DOM events (on parts of the app that doesn't belong to this plugin)
        // Using this function will automatically remove the event listener when this plugin is disabled.

        // When registering intervals, this function will automatically clear the interval when the plugin is disabled.
        this.registerInterval(window.setInterval(() => logger.debug('Plugin', 'Heartbeat interval'), 5 * 60 * 1000));
        
        // Listen for file modifications
        this.registerEvent(this.app.vault.on('modify', (file) => {
            logger.debug('Plugin', `File modified: ${file.path}`);
            this.handleFileModify(file);
        }));
        
        // Listen for file creation
        this.registerEvent(this.app.vault.on('create', (file) => {
            logger.debug('Plugin', `File created: ${file.path}`);
            this.handleFileCreate(file);
        }));
        
        // Listen for file deletion
        this.registerEvent(this.app.vault.on('delete', (file) => {
            logger.info('Plugin', `File deletion event triggered: ${file.path}`);
            this.handleFileDelete(file);
        }));
        
        // Listen for file rename
        this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
            logger.debug('Plugin', `File renamed: ${oldPath} -> ${file.path}`);
            this.handleFileRename(file, oldPath);
        }));
        
        // Listen for editor changes for dynamic search
        this.registerEvent(this.app.workspace.on('editor-change', (editor, view) => {
            if (view instanceof MarkdownView) {
                this.onEditorChange(editor, view);
            }
        }));

        // Listen for active leaf changes to track navigation to different markdown files
        this.registerEvent(this.app.workspace.on('active-leaf-change', (leaf) => {
            this.onActiveLeafChange(leaf);
        }));

        // Listen for file open events (covers both opening new files and switching between files)
        this.registerEvent(this.app.workspace.on('file-open', (file) => {
            this.onFileOpen(file);
        }));

        // Listen for clicks on the editor to detect cursor movements
        this.registerDomEvent(document, 'click', (evt: MouseEvent) => {
            this.onDocumentClick(evt);
        });
    }

    async processOneFileIntoDatabase(file: any) {
        try {
            // Get file content
            const content = await this.app.vault.read(file);
            const metadata = await this.app.metadataCache.getFileCache(file);

            const blocks = await this.noteProcessor.getBlocksFromFile(content, metadata)
            
            // Use upsertNote to handle existence checking and changes
            const note_result = await this.databaseService.upsertNote(
                file.path, 
                file.name, 
                file.basename, 
                content
            );

            if (note_result.changed) {
                const block_result = await this.databaseService.insertBlocksForNote(
                    note_result.noteId,
                    blocks
                );

                await this.databaseService.deleteVectorsForNote(note_result.noteId);
                await this.databaseService.processNoteVector(
                    note_result.noteId, 
                    this.embeddingService
                );

                await this.databaseService.processBlockVectors(
                    note_result.noteId,
                    block_result.blockIds,
                    this.embeddingService
                );

                logger.info('Plugin', `Processed: ${file.path}`);
            }

            return note_result;
        } catch (error) {
            logger.error('Plugin', `Error processing file ${file.path}`, error);
            return null;
        }
    }

    async processAllVaultFilesIntoDatabase(showNotice: boolean = true) {
        if (showNotice) {
            new Notice('Processing all files into database...');
        }
        
        try {
            const files = this.app.vault.getMarkdownFiles();
            logger.info('Plugin', `Found ${files.length} markdown files in vault`);
            
            let processed = 0;
            let created = 0;
            let updated = 0;
            let skipped = 0;
            
            for (const file of files) {
                const result = await this.processOneFileIntoDatabase(file);
                processed++;
                if (result?.changed) {
                    created++;
                } else if (result) {
                    skipped++;
                }
                // If result is null (error), it's counted in processed but not created/skipped
            }
            
            const message = `Completed processing ${processed} files: ${created} processed (new/changed), ${skipped} skipped (unchanged)`;
            if (showNotice) {
                new Notice(message);
            }
            logger.info('Plugin', message);
            
        } catch (error) {
            logger.error('Plugin', 'Failed to process vault files', error);
            if (showNotice) {
                new Notice('Failed to process vault files. Check console for details.');
            }
        }
    }
    
    async activateView() {
        const { workspace } = this.app;

        let leaf: WorkspaceLeaf | null = null;
        const leaves = workspace.getLeavesOfType(VIEW_TYPE);

        if (leaves.length > 0) {
          // A leaf with our view already exists, use that
          leaf = leaves[0];
        } else {
          // Our view could not be found in the workspace, create a new leaf
          // in the right sidebar for it
          leaf = workspace.getRightLeaf(false);
          if (leaf) {
            await leaf.setViewState({ type: VIEW_TYPE, active: true });
          }
        }

        // "Reveal" the leaf in case it is in a collapsed sidebar
        if (leaf) {
          workspace.revealLeaf(leaf);
        }
    }

    async onunload() {
        // Clean up status bar item
        if (this.statusBarItem) {
            this.statusBarItem.remove();
            this.statusBarItem = null;
        }
        
        // Save and close database connection
        if (this.databaseAdapter) {
            await this.databaseAdapter.save();
            await this.databaseAdapter.close();
        }
    }

    private registerCommand(id: string, name: string, callback: () => Promise<void>): void {
        this.addCommand({
            id,
            name,
            callback
        });
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
        // Update logger level when settings are saved
        logger.setLevel(this.settings.logLevel);
        // Reinitialize services to pick up new settings
        this.reinitializeServicesAfterSettingsChange();
    }

    private reinitializeServicesAfterSettingsChange(): void {
        logger.info('Plugin', 'Reinitializing services after settings change');
        
        // Reinitialize embedding services with new settings
        this.initializeEmbeddingServices();
        
        // Update chunking service with new settings
        this.chunkingService = new ChunkingService(
            this.settings.chunkSize, 
            this.settings.chunkOverlap, 
            this, 
            logger
        );
        
        // Recreate search service with updated embedding service
        this.searchService = new SearchService(
            this.databaseService, 
            this.embeddingService, 
            logger
        );
        
        // Clear any cached validation results to force fresh validation
        this.clearValidationCache();
        
        logger.info('Plugin', 'Services reinitialized after settings change');
    }

    /**
     * Clear validation cache to force fresh validation
     */
    clearValidationCache(): void {
        this.systemValidationResult = null;
        this.isSystemValid = false;
    }

    // Vector database command implementations
    async rebuildDatabase() {
        if (this.isOperationInProgress) {
            new Notice('Database operation already in progress. Please wait for it to complete.');
            return;
        }

        this.isOperationInProgress = true;
        new Notice('Starting database rebuild...');
        
        try {
            // Drop all existing tables for a clean rebuild
            await this.databaseAdapter.dropAllTables();
            
            // Recreate core tables
            new Notice('Recreating database tables...');
            await this.databaseAdapter.createNotesTable();
            await this.databaseAdapter.createChunksTable();
            await this.databaseAdapter.createVectorsTable();
            await this.databaseAdapter.createBlocksTable();
            await this.databaseAdapter.createFTSTable();
            
            // Process all vault files with the clean database
            new Notice('Processing all vault files...');
            await this.processAllVaultFilesIntoDatabase(false);
            
            // Build vector index (this will create LSH tables internally if needed)
            new Notice('Building vector index...');
            await this.databaseAdapter.generateVectorIndex(this.settings.vectorSize);
            
            // Save the rebuilt database
            await this.databaseAdapter.save();
            
            new Notice('Database rebuild completed successfully!');
            
            // Update system status to reflect successful rebuild
            this.isSystemValid = true;
            this.updateStatusBar('check', 'Tezcat: System ready', 'tezcat-status-ready');
        } catch (error) {
            logger.error('Plugin', 'Database rebuild failed', error);
            new Notice('Database rebuild failed. Check console for details.');
        } finally {
            this.isOperationInProgress = false;
        }
    }


    /**
     * Initialize embedding services with model manager integration
     */
    private initializeEmbeddingServices(): void {
        if (this.settings.embeddingProvider === 'ollama') {
            // Create model manager for Ollama
            this.modelManager = new OllamaModelManager(this.settings.ollamaBaseUrl, logger);
            
            // Create Ollama provider with model manager
            const ollamaProvider = new OllamaEmbeddingProvider(
                this.settings.ollamaBaseUrl, 
                this.settings.embeddingModel, 
                logger
            );
            ollamaProvider.setModelManager(this.modelManager);
            
            this.embeddingService = new EmbeddingService(ollamaProvider, logger);
            this.validationService.setModelManager(this.modelManager);
        } else {
            // Create OpenAI provider
            const openaiProvider = new OpenAIEmbeddingProvider(
                this.settings.openaiApiKey,
                this.settings.embeddingModel,
                'https://api.openai.com',
                logger
            );
            
            this.embeddingService = new EmbeddingService(openaiProvider, logger);
        }
    }

    /**
     * Perform system validation before any setup
     */
    async performValidationAndSetup(): Promise<void> {
        if (this.isOperationInProgress) {
            new Notice('Database operation already in progress. Please wait for it to complete.');
            return;
        }

        this.isOperationInProgress = true;
        try {
            logger.info('Plugin', 'Starting system validation...');
            
            // Validate the entire system
            this.systemValidationResult = await this.validationService.validateSystem(
                this.embeddingService.embeddingProvider,
                this.databaseService,
                [this.settings.embeddingModel]
            );
            
            this.isSystemValid = this.systemValidationResult.overall.success;
            
            if (this.isSystemValid) {
                logger.info('Plugin', 'System validation successful, proceeding with setup...');
                await this.performAutomaticSetup();
                // Only show "ready" status after setup completes successfully
                this.updateStatusBar('check', 'Tezcat: System ready', 'tezcat-status-ready');
                await this.activateView();
            } else {
                logger.warn('Plugin', 'System validation failed, skipping automatic setup');
                this.updateStatusBar('alert-triangle', 'Tezcat: Setup required', 'tezcat-status-error');
                this.showValidationFailureGuidance();
                // Still activate view so user can see guidance
                await this.activateView();
            }
            
        } catch (error) {
            logger.error('Plugin', 'System validation failed with error', error);
            this.isSystemValid = false;
            this.updateStatusBar('x', 'Tezcat: Setup failed', 'tezcat-status-error');
            new Notice('Tezcat setup failed. Check console for details.', 10000);
            await this.activateView(); // Show view with error state
        } finally {
            this.isOperationInProgress = false;
        }
    }

    /**
     * Show guidance to user when validation fails
     */
    private showValidationFailureGuidance(): void {
        if (!this.systemValidationResult) return;
        
        const summary = this.validationService.getValidationSummary(this.systemValidationResult);
        new Notice(`Tezcat Setup Issues:\n${summary}`, 15000);
        
        // More specific guidance based on the type of failure
        if (!this.systemValidationResult.embeddingProvider.success) {
            const message = this.systemValidationResult.embeddingProvider.message;
            if (message.includes('Ollama server not accessible')) {
                new Notice('To fix: Start Ollama by starting up the application (or downloading and running at https://ollama.com/download) or by running "ollama serve" in terminal', 8000);
            } else if (message.includes('API key')) {
                new Notice('To fix: Add your OpenAI API key in Tezcat settings', 8000);
            }
        }
        
        if (!this.systemValidationResult.models.success) {
            new Notice('Model download may be in progress. Check the notifications for status.', 5000);
        }
    }

    /**
     * Check if system is valid before performing vector operations
     */
    private ensureSystemValid(): boolean {
        if (!this.isSystemValid) {
            new Notice('Cannot perform operation: System validation failed. Please fix the issues shown earlier.', 8000);
            return false;
        }
        return true;
    }

    async performAutomaticSetup() {
        // Only proceed if system validation passed
        if (!this.ensureSystemValid()) {
            logger.warn('Plugin', 'Skipping automatic setup due to system validation failure');
            return;
        }
        try {
            // Automatically process all vault files when workspace is ready
            logger.info('Plugin', 'Workspace ready, processing vault files...');
            await this.processAllVaultFilesIntoDatabase(false);
            
            // Build vector index after all files are processed
            logger.info('Plugin', 'Building vector index...');
            await this.ensureVectorIndexExists();
            
            // Ensure FTS content exists for all notes (for hybrid search)
            logger.info('Plugin', 'Ensuring FTS content is populated...');
            await this.databaseService.ensureFTSContentForAllNotes();
            
            // Automatically activate the Tezcat view
            logger.info('Plugin', 'Activating Tezcat view...');
            await this.activateView();
            
            logger.info('Plugin', 'Automatic setup completed successfully');
        } catch (error) {
            logger.error('Plugin', 'Failed during automatic setup', error);
        }
    }

    async ensureVectorIndexExists() {
        if (!this.ensureSystemValid()) {
            return;
        }
        
        try {
            // Check if vector index already exists
            const lshConfig = await this.databaseAdapter.getLSHConfig();
            
            if (lshConfig) {
                logger.info('Plugin', 'Vector index already exists, skipping build');
                return;
            }
            
            // Index doesn't exist, build it
            logger.info('Plugin', 'Vector index not found, building index...');
            await this.databaseAdapter.generateVectorIndex(this.settings.vectorSize);
            logger.info('Plugin', 'Vector index built successfully');
            
        } catch (error) {
            logger.error('Plugin', 'Failed to ensure vector index exists', error);
            // Don't throw error during startup - just log it
        }
    }

    async rebuildVectorIndex() {
        if (!this.ensureSystemValid()) {
            return;
        }
        
        new Notice('Starting vector index rebuild...');
        
        try {
            await this.databaseAdapter.generateVectorIndex(this.settings.vectorSize);
            new Notice('Vector index rebuilt successfully!');
        } catch (error) {
            logger.error('Plugin', 'Vector index rebuild failed', error);
            new Notice('Vector index rebuild failed. Check console for details.');
        }
    }

    async showVectorDatabaseStats() {
        try {
            const stats = await this.databaseService.getVectorDatabaseStats();
            
            const message = `Vector Database Stats:
• Total Notes: ${stats.totalNotes}
• Processed Notes: ${stats.processedNotes}
• Total Vectors: ${stats.totalVectors}
• Note Vectors: ${stats.vectorsByType.note}
• Block Vectors: ${stats.vectorsByType.block}
• Outdated Notes: ${stats.outdatedNotes}
• Orphaned Vectors: ${stats.orphanedData.orphanedVectors}
• Orphaned Chunks: ${stats.orphanedData.orphanedChunks}`;

            new Notice(message, 10000); // Show for 10 seconds
            logger.info('Plugin', `Vector Database Stats: totalNotes=${stats.totalNotes}, processedNotes=${stats.processedNotes}, totalVectors=${stats.totalVectors}, noteVectors=${stats.vectorsByType.note}, blockVectors=${stats.vectorsByType.block}`);
        } catch (error) {
            logger.error('Plugin', 'Failed to get vector database stats', error);
            new Notice('Failed to get vector database stats. Check console for details.');
        }
    }

    async performVectorSearch() {
        try {
            // Create a simple input modal to get the search query
            new VectorSearchModal(this.app, async (query: string) => {
                if (!query.trim()) {
                    new Notice('Please enter a search query');
                    return;
                }

                new Notice('Performing vector search...');
                
                try {
                    const currentNotePath = this.getCurrentNotePath();
                    const excludeNotePaths = currentNotePath ? [currentNotePath] : [];
                    
                    const results = await this.searchService.vectorSearch(query, {
                        topK: 10,
                        minScore: 0.1,
                        includeNoteVectors: true,
                        includeChunkVectors: false,
                        includeBlockVectors: true,
                        excludeNotePaths
                    });

                    if (results.length === 0) {
                        new Notice('No results found');
                        return;
                    }

                    // Display results in a modal
                    new VectorSearchResultsModal(this.app, query, results).open();
                    
                } catch (error) {
                    logger.error('Plugin', 'Vector search failed', error);
                    new Notice('Vector search failed. Check console for details.');
                }
            }).open();
            
        } catch (error) {
            logger.error('Plugin', 'Failed to open vector search', error);
            new Notice('Failed to open vector search. Check console for details.');
        }
    }


    private onEditorChange(editor: Editor, view: MarkdownView) {
        // Only search if we're on a markdown file and search panel is visible
        if (!view || !this.isSearchPanelVisible()) {
            return;
        }

        const context = this.extractCursorContext(editor);
        this.debouncedSearch(context);
    }

    private onActiveLeafChange(leaf: WorkspaceLeaf | null) {
        // Handle note navigation tracking
        this.handleNoteNavigation(leaf);
        
        // Track the last active markdown view for the search panel
        if (leaf?.view instanceof MarkdownView) {
            const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
            if (leaves.length > 0) {
                const searchView = leaves[0].view as TezcatView;
                searchView.setLastActiveMarkdownView(leaf.view);
            }
        }

        if (!this.isSearchPanelVisible()) {
            return;
        }

        // Check if we're on a markdown file
        if (leaf?.view instanceof MarkdownView) {
            const editor = leaf.view.editor;
            const context = this.extractCursorContext(editor);
            this.debouncedSearch(context);
        }
        // Note: We don't clear results when switching away from markdown files
        // This allows users to interact with search results even when not in an editor
    }

    private onDocumentClick(evt: MouseEvent) {
        // Only proceed if the search panel is open and visible
        if (!this.isSearchPanelVisible()) {
            return;
        }

        // Check if the click was in an editor area (lightweight check)
        const target = evt.target as Element;
        if (target && (target.closest('.cm-editor') || target.closest('.markdown-source-view'))) {
            // Defer the heavy work to avoid blocking the click event
            setTimeout(() => {
                try {
                    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
                    if (activeView && activeView.editor) {
                        const context = this.extractCursorContext(activeView.editor);
                        this.debouncedSearch(context);
                    }
                } catch (error) {
                    logger.warn('Plugin', 'Error handling click event', error);
                }
            }, 10);
        }
    }

    private onFileOpen(file: any) {
        // Handle note navigation tracking for file opens
        setTimeout(() => {
            const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
            if (activeView) {
                this.handleNoteNavigation(this.app.workspace.activeLeaf);
            }
        }, 10);
        
        if (!this.isSearchPanelVisible()) {
            return;
        }

        // Small delay to ensure the editor is ready
        setTimeout(() => {
            const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
            if (activeView && activeView.editor) {
                const context = this.extractCursorContext(activeView.editor);
                this.debouncedSearch(context);
            } else {
                // Not a markdown file - clear results since there's no cursor context
                this.updateSearchPanel([]);
            }
        }, 50);
    }

    private extractCursorContext(editor: Editor): string {
        try {
            const doc = editor.getDoc();
            
            // Get cursor position first, fallback to beginning if no cursor
            let cursor;
            try {
                cursor = editor.getCursor();
            } catch (error) {
                cursor = { line: 0, ch: 0 };
            }
            
            // Get a reasonable range around the cursor instead of the full document
            // This is much faster for large documents
            const lineCount = doc.lineCount();
            const contextLines = 10; // Look at 10 lines before and after cursor
            const startLine = Math.max(0, cursor.line - contextLines);
            const endLine = Math.min(lineCount, cursor.line + contextLines + 1);
            
            // Get text from the limited range
            const lines = [];
            for (let i = startLine; i < endLine; i++) {
                lines.push(doc.getLine(i));
            }
            const contextText = lines.join('\n');
            
            // Split into words
            const words = contextText.split(/\s+/).filter(word => word.length > 0);
            
            if (words.length === 0) {
                return '';
            }
            
            // Find approximate cursor position within this limited context
            let wordIndex = 0;
            for (let i = startLine; i < cursor.line && i < lineCount; i++) {
                const line = doc.getLine(i);
                const lineWords = line.split(/\s+/).filter(word => word.length > 0);
                wordIndex += lineWords.length;
            }
            
            // Add words from current line up to cursor position
            if (cursor.line < lineCount) {
                const currentLine = doc.getLine(cursor.line);
                const lineUpToCursor = currentLine.substring(0, cursor.ch);
                const wordsBeforeCursor = lineUpToCursor.split(/\s+/).filter(word => word.length > 0);
                wordIndex += wordsBeforeCursor.length;
            }
            
            // Extract context window, but limit to what we actually retrieved
            const halfWindow = Math.floor(this.CONTEXT_WINDOW_WORDS / 2);
            const startIndex = Math.max(0, wordIndex - halfWindow);
            const endIndex = Math.min(words.length, wordIndex + halfWindow);
            
            return words.slice(startIndex, endIndex).join(' ');
            
        } catch (error) {
            logger.warn('Plugin', 'Error extracting cursor context', error);
            return '';
        }
    }

    /**
     * Get debounce delay based on search cadence setting
     */
    private getSearchDebounceDelay(): number {
        switch (this.settings.searchCadence) {
            case 'always':
                return 500; // 0.5 seconds - current behavior
            case 'sometimes':
                return 2000; // 2 seconds - slower
            case 'occasionally':
                return 8000; // 8 seconds - very slow
            default:
                return 500;
        }
    }

    private debouncedSearch(context: string) {
        // Check if search is currently suppressed
        if (Date.now() < this.searchSuppressedUntil) {
            logger.debug('Plugin', 'Search suppressed due to recent button interaction');
            return;
        }

        if (this.searchDebounceTimer) {
            window.clearTimeout(this.searchDebounceTimer);
        }
        
        const debounceDelay = this.getSearchDebounceDelay();
        logger.debug('Plugin', `Using search cadence: ${this.settings.searchCadence} (${debounceDelay}ms delay)`);
        
        this.searchDebounceTimer = window.setTimeout(async () => {
            // Double-check suppression at execution time
            if (Date.now() < this.searchSuppressedUntil) {
                logger.debug('Plugin', 'Search suppressed at execution time');
                return;
            }
            
            if (context.trim()) {
                this.lastSearchContext = context;
                await this.performDynamicSearch(context);
            }
        }, debounceDelay);
    }

    private isSearchPanelVisible(): boolean {
        const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
        return leaves.length > 0 && leaves[0].view.containerEl.isShown();
    }

    private async performDynamicSearch(context: string) {
        try {
            const currentNotePath = this.getCurrentNotePath();
            const excludeNotePaths = currentNotePath ? [currentNotePath] : [];
            
            // Perform search based on settings (vector or hybrid)
            const searchPromise = this.settings.searchMode === 'hybrid' 
                ? this.searchService.hybridSearch(context, {
                    topK: 10,
                    minScore: 0, // RRF scores are much smaller than cosine similarity scores
                    includeNoteVectors: true,
                    includeChunkVectors: false,
                    includeBlockVectors: true,
                    excludeNotePaths,
                    hybridWeight: 0.5 // Equal weighting by default
                })
                : this.searchService.vectorSearch(context, {
                    topK: 10,
                    minScore: 0.1,
                    includeNoteVectors: true,
                    includeChunkVectors: false,
                    includeBlockVectors: true,
                    excludeNotePaths
                });
            
            const results = await searchPromise;
            
            // Update panel asynchronously
            await this.updateSearchPanel(results);
            
        } catch (error) {
            logger.error('Plugin', 'Dynamic search failed', error);
            await this.updateSearchPanel([]);
        }
    }

    private async updateSearchPanel(results: SearchResult[]) {
        const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
        if (leaves.length > 0) {
            const view = leaves[0].view as TezcatView;
            // Update view asynchronously to avoid blocking the editor
            setTimeout(async () => {
                await view.updateSearchResults(results);
            }, 0);
        }
    }

    private getCurrentNotePath(): string | null {
        const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!activeView || !activeView.file) {
            return null;
        }

        return activeView.file.path;
    }

    suppressSearchFor(milliseconds: number = 2000) {
        this.searchSuppressedUntil = Date.now() + milliseconds;
        logger.debug('Plugin', `Search suppressed for ${milliseconds}ms`);
    }

    // File event handlers for note reprocessing
    private async handleFileModify(file: any) {
        // Only process markdown files
        if (file.extension !== 'md') return;
        
        try {
            // Use the complete blocks workflow for modified files
            await this.processOneFileIntoDatabase(file);
        } catch (error) {
            logger.error('Plugin', `Failed to handle file modify for ${file.path}`, error);
        }
    }

    private async handleFileCreate(file: any) {
        // Only process markdown files
        if (file.extension !== 'md') return;
        
        try {
            // Use the complete blocks workflow for new files
            await this.processOneFileIntoDatabase(file);
        } catch (error) {
            logger.error('Plugin', `Failed to handle file create for ${file.path}`, error);
        }
    }

    private async handleFileDelete(file: any) {
        // Only process markdown files
        if (file.extension !== 'md') return;
        
        try {
            // Check if note exists in database
            const existingNote = await this.databaseService.getNoteByPath(file.path);
            if (existingNote) {
                logger.info('Plugin', `Removing deleted note from database: ${file.path}`);
                // Delete in order: vectors, chunks, then note
                await this.databaseService.deleteVectorsForNote(existingNote.id);
                await this.databaseService.deleteChunksForNote(existingNote.id);
                await this.databaseService.deleteNote(existingNote.id);
                logger.info('Plugin', `Successfully removed note ${existingNote.id} (${file.path}) from database`);
            } else {
                logger.debug('Plugin', `Note not found in database for deletion: ${file.path}`);
            }
        } catch (error) {
            logger.error('Plugin', `Failed to handle file delete for ${file.path}`, error);
        }
    }

    private async handleFileRename(file: any, oldPath: string) {
        // Only process markdown files
        if (file.extension !== 'md') return;
        
        try {
            // Look for note by old path
            const existingNote = await this.databaseService.getNoteByPath(oldPath);
            if (existingNote) {
                logger.debug('Plugin', `Updating renamed note path: ${oldPath} -> ${file.path}`);
                await this.databaseService.updateNote(existingNote.id, {
                    name: file.name,
                    base_name: file.basename,
                    path: file.path
                });
            } else {
                // Note not found by old path - might be a new file, handle as create
                logger.debug('Plugin', `Note not found for rename, treating as new file: ${file.path}`);
                await this.handleFileCreate(file);
            }
        } catch (error) {
            logger.error('Plugin', `Failed to handle file rename from ${oldPath} to ${file.path}`, error);
        }
    }


    private async handleNoteNavigation(leaf: WorkspaceLeaf | null) {
        // Only handle markdown files
        if (!leaf?.view || !(leaf.view instanceof MarkdownView) || !leaf.view.file) {
            return;
        }
        
        const file = leaf.view.file;
        if (file.extension !== 'md') return;
        
        try {
            // Get the note ID for the current file
            const note = await this.databaseService.getNoteByPath(file.path);
            const newNoteId = note?.id || null;
            
            
            // Update current note tracking
            this.currentNoteId = newNoteId;
            
        } catch (error) {
            logger.warn('Plugin', `Failed to handle note navigation for ${file.path}`, error);
        }
    }

    /**
     * Update the status bar with current system status
     */
    public updateStatusBar(status: string, tooltip: string, className?: string) {
        if (!this.statusBarItem) return;
        
        this.statusBarItem.empty();
        
        // Map status to simple text indicators
        let displayText: string;
        switch (status) {
            case 'sync':
                displayText = '○';
                break;
            case 'check':
                displayText = '✓';
                break;
            case 'alert-triangle':
                displayText = '!';
                break;
            case 'x':
                displayText = '×';
                break;
            default:
                displayText = status;
        }
        
        this.statusBarItem.setText(displayText);
        this.statusBarItem.title = tooltip;
        
        // Remove existing tezcat status classes
        this.statusBarItem.removeClass('tezcat-status-initializing');
        this.statusBarItem.removeClass('tezcat-status-ready');
        this.statusBarItem.removeClass('tezcat-status-error');
        
        if (className) {
            this.statusBarItem.addClass(className);
        }
        
        // Add click handler to show validation details
        this.statusBarItem.onclick = () => {
            this.showSystemStatusModal();
        };
    }

    /**
     * Show detailed system status in a modal
     */
    private async showSystemStatusModal() {
        // If operation is in progress, show modal immediately without validation
        if (this.isOperationInProgress) {
            // Skip validation and proceed directly to showing modal
        } else if (!this.systemValidationResult) {
            // Only run validation if not in progress and no validation result exists
            new Notice('Running system validation...');
            await this.performValidationAndSetup();
            // Return early - performValidationAndSetup handles everything including user feedback
            // Don't show the modal after validation/setup completes
            return;
        }
        
        // Get current database stats for real-time display
        try {
            const noteCount = (await this.databaseService.getAllNotes()).length;
            const vectorCount = await this.databaseService.getVectorCount();
            
            // Create updated validation result with current database info
            const updatedResult = {
                ...this.systemValidationResult,
                database: {
                    success: true,
                    message: `Database ready (${noteCount} notes, ${vectorCount} vectors)`
                }
            } as SystemValidationResult;
            
            new SystemStatusModal(this.app, updatedResult, this.isSystemValid, this).open();
        } catch (error) {
            // Fall back to cached result if database query fails, or create minimal result if none exists
            const fallbackResult = this.systemValidationResult || {
                embeddingProvider: { success: false, message: 'Not validated yet' },
                database: { success: false, message: 'Not validated yet' },
                models: { success: false, message: 'Not validated yet' },
                overall: { success: false, message: 'System not validated yet' }
            };
            new SystemStatusModal(this.app, fallbackResult, this.isSystemValid, this).open();
        }
    }

    /**
     * Add CSS styles for status bar items
     */
    private addStatusBarStyles() {
        const styleEl = document.createElement('style');
        styleEl.textContent = `
            .tezcat-status-ready {
                color: var(--text-success, #4ade80) !important;
                cursor: pointer;
            }
            .tezcat-status-error {
                color: var(--text-error, #ef4444) !important;
                cursor: pointer;
                animation: tezcat-pulse 2s infinite;
            }
            .tezcat-status-initializing {
                color: var(--text-muted) !important;
                cursor: pointer;
            }
            @keyframes tezcat-pulse {
                0%, 100% { opacity: 1; }
                50% { opacity: 0.6; }
            }
            .status-bar-item.tezcat-status-ready:hover,
            .status-bar-item.tezcat-status-error:hover,
            .status-bar-item.tezcat-status-initializing:hover {
                background-color: var(--background-modifier-hover);
                border-radius: 3px;
            }
        `;
        document.head.appendChild(styleEl);
    }
}


class TezcatSettingTab extends PluginSettingTab {
    plugin: Tezcat;
    private pendingSettings: TezcatSettings;
    private hasSensitiveChanges: boolean = false;

    constructor(app: App, plugin: Tezcat) {
        super(app, plugin);
        this.plugin = plugin;
        this.pendingSettings = { ...plugin.settings };
    }

    display(): void {
        const {containerEl} = this;

        containerEl.empty();

        // Embedding Settings Section
        containerEl.createEl('h3', { text: 'Embedding Settings' });
        containerEl.createEl('p', {
            text: 'Changing these settings will require reindexing all vault content.',
            cls: 'setting-item-description'
        });

        new Setting(containerEl)
            .setName('Embedding Provider')
            .setDesc('Choose the provider for generating embeddings')
            .addDropdown(dropdown => dropdown
                .addOption('ollama', 'Ollama')
                .addOption('openai', 'OpenAI')
                .setValue(this.pendingSettings.embeddingProvider)
                .onChange((value: EmbeddingProviderType) => {
                    this.pendingSettings.embeddingProvider = value;
                    this.hasSensitiveChanges = true;
                    this.display(); // Refresh settings to show/hide conditional settings
                }));

        new Setting(containerEl)
            .setName('Embedding Model')
            .setDesc('The model to use for generating embeddings')
            .addDropdown(dropdown => {
                if (this.pendingSettings.embeddingProvider === 'openai') {
                    dropdown
                        .addOption('text-embedding-3-small', 'Text Embedding 3 Small (1536d)')
                        .addOption('text-embedding-3-large', 'Text Embedding 3 Large (3072d)');
                } else if (this.pendingSettings.embeddingProvider === 'ollama') {
                    dropdown
                        .addOption('nomic-embed-text:v1.5', 'Nomic Embed Text v1.5 (768d)')
                        .addOption('bge-m3', 'BGE M3 (1024d)');
                }
                
                dropdown
                    .setValue(this.pendingSettings.embeddingModel)
                    .onChange((value) => {
                        this.pendingSettings.embeddingModel = value;
                        this.hasSensitiveChanges = true;
                        
                        // Auto-update vector size based on model
                        if (value === 'bge-m3') {
                            this.pendingSettings.vectorSize = 1024;
                        } else if (value === 'text-embedding-3-small') {
                            this.pendingSettings.vectorSize = 1536;
                        } else if (value === 'text-embedding-3-large') {
                            this.pendingSettings.vectorSize = 3072;
                        } else {
                            this.pendingSettings.vectorSize = 768;
                        }
                        this.display(); // Refresh to update vector size field
                    });
            });

        new Setting(containerEl)
            .setName('Vector Size')
            .setDesc('The size of the embedding vectors (default: 768)')
            .addText(text => {
                const isReadOnly = this.pendingSettings.embeddingModel === 'bge-m3' || 
                                 this.pendingSettings.embeddingModel === 'text-embedding-3-small' ||
                                 this.pendingSettings.embeddingModel === 'text-embedding-3-large';
                
                text
                    .setPlaceholder('768')
                    .setValue(this.pendingSettings.vectorSize.toString())
                    .setDisabled(isReadOnly);
                
                if (!isReadOnly) {
                    const originalValue = this.plugin.settings.vectorSize;
                    text.onChange((value) => {
                        const vectorSize = parseInt(value) || 768;
                        this.pendingSettings.vectorSize = vectorSize;
                    });
                    text.inputEl.addEventListener('blur', () => {
                        if (this.pendingSettings.vectorSize !== originalValue) {
                            this.hasSensitiveChanges = true;
                            this.display();
                        }
                    });
                }
            });

        new Setting(containerEl)
            .setName('Chunk Size')
            .setDesc('The number of tokens per text chunk. Also affects the search context window size around your cursor (default: 128)')
            .addText(text => {
                const originalValue = this.plugin.settings.chunkSize;
                text
                    .setPlaceholder('128')
                    .setValue(this.pendingSettings.chunkSize.toString())
                    .onChange((value) => {
                        const chunkSize = parseInt(value) || 128;
                        this.pendingSettings.chunkSize = chunkSize;
                    });
                text.inputEl.addEventListener('blur', () => {
                    if (this.pendingSettings.chunkSize !== originalValue) {
                        this.hasSensitiveChanges = true;
                        this.display();
                    }
                });
            });

        new Setting(containerEl)
            .setName('Chunk Overlap')
            .setDesc('The number of tokens to overlap between chunks for better context continuity (default: 16)')
            .addText(text => {
                const originalValue = this.plugin.settings.chunkOverlap;
                text
                    .setPlaceholder('16')
                    .setValue(this.pendingSettings.chunkOverlap.toString())
                    .onChange((value) => {
                        const chunkOverlap = parseInt(value) || 16;
                        this.pendingSettings.chunkOverlap = chunkOverlap;
                    });
                text.inputEl.addEventListener('blur', () => {
                    if (this.pendingSettings.chunkOverlap !== originalValue) {
                        this.hasSensitiveChanges = true;
                        this.display();
                    }
                });
            });

        // Conditional settings based on provider
        if (this.pendingSettings.embeddingProvider === 'openai') {
            new Setting(containerEl)
                .setName('OpenAI API Key')
                .setDesc('Your OpenAI API key for embedding generation')
                .addText(text => {
                    const originalValue = this.plugin.settings.openaiApiKey;
                    text
                        .setPlaceholder('sk-...')
                        .setValue(this.pendingSettings.openaiApiKey)
                        .onChange((value) => {
                            this.pendingSettings.openaiApiKey = value;
                        });
                    text.inputEl.addEventListener('blur', () => {
                        if (this.pendingSettings.openaiApiKey !== originalValue) {
                            this.hasSensitiveChanges = true;
                            this.display();
                        }
                    });
                });
        }

        if (this.pendingSettings.embeddingProvider === 'ollama') {
            new Setting(containerEl)
                .setName('Ollama Base URL')
                .setDesc('The base URL for your Ollama server')
                .addText(text => {
                    const originalValue = this.plugin.settings.ollamaBaseUrl;
                    text
                        .setPlaceholder('http://localhost:11434')
                        .setValue(this.pendingSettings.ollamaBaseUrl)
                        .onChange((value) => {
                            this.pendingSettings.ollamaBaseUrl = value;
                        });
                    text.inputEl.addEventListener('blur', () => {
                        if (this.pendingSettings.ollamaBaseUrl !== originalValue) {
                            this.hasSensitiveChanges = true;
                            this.display();
                        }
                    });
                });
        }

        // Save and Cancel buttons for sensitive settings
        const buttonContainer = containerEl.createDiv('setting-item');
        const buttonInfo = buttonContainer.createDiv('setting-item-info');
        const buttonControl = buttonContainer.createDiv('setting-item-control');

        if (this.hasSensitiveChanges) {
            const saveButton = buttonControl.createEl('button', {
                text: 'Save Changes',
                cls: 'mod-cta'
            });
            saveButton.onclick = () => this.confirmAndSave();

            const cancelButton = buttonControl.createEl('button', {
                text: 'Cancel'
            });
            cancelButton.onclick = () => this.cancelChanges();
        }

        // Rebuild Database Button
        new Setting(containerEl)
            .setName('Rebuild Database & Index')
            .setDesc('Completely rebuild the database and reindex all vault content. This will take some time but can fix indexing issues.')
            .addButton(button => button
                .setButtonText('Rebuild Database')
                .setClass('mod-warning')
                .onClick(async () => {
                    // Show confirmation modal
                    new ReindexConfirmModal(
                        this.app,
                        async () => {
                            // User confirmed - proceed with rebuild
                            await this.plugin.rebuildDatabase();
                        },
                        () => {
                            // User cancelled - do nothing
                        }
                    ).open();
                }));

        // Horizontal divider
        const divider = containerEl.createEl('hr', {
            attr: { style: 'margin: 2em 0; border: none; border-top: 1px solid var(--background-modifier-border);' }
        });

        // Application Settings Section
        containerEl.createEl('h3', { text: 'Application Settings' });
        containerEl.createEl('p', {
            text: 'These settings take effect immediately and don\'t require reindexing.',
            cls: 'setting-item-description'
        });

        // Search Cadence Setting (applies immediately)
        new Setting(containerEl)
            .setName('Search Cadence')
            .setDesc('How frequently to perform contextual searches as you move your cursor')
            .addDropdown(dropdown => dropdown
                .addOption('always', 'Always (0.5s delay - most responsive)')
                .addOption('sometimes', 'Sometimes (2s delay - slower)')
                .addOption('occasionally', 'Occasionally (8s delay - minimal)')
                .setValue(this.plugin.settings.searchCadence)
                .onChange(async (value: SearchCadence) => {
                    this.plugin.settings.searchCadence = value;
                    await this.plugin.saveSettings();
                    logger.info('Settings', `Search cadence updated to: ${value}`);
                }));

        new Setting(containerEl)
            .setName('Search Mode')
            .setDesc('Choose between vector-only search or hybrid search combining semantic similarity with keyword matching')
            .addDropdown(dropdown => dropdown
                .addOption('vector', 'Vector Only (semantic similarity)')
                .addOption('hybrid', 'Hybrid (semantic + keyword matching)')
                .setValue(this.plugin.settings.searchMode)
                .onChange(async (value: SearchMode) => {
                    this.plugin.settings.searchMode = value;
                    await this.plugin.saveSettings();
                    logger.info('Settings', `Search mode updated to: ${value}`);
                }));

        // Context Window Setting (applies immediately)
        new Setting(containerEl)
            .setName('Search Context Window (words)')
            .setDesc('Number of words to extract around your cursor for contextual search (default: 64)')
            .addText(text => text
                .setPlaceholder('64')
                .setValue(this.plugin.settings.contextWindowWords.toString())
                .onChange(async (value) => {
                    const contextWords = parseInt(value) || 64;
                    this.plugin.settings.contextWindowWords = contextWords;
                    await this.plugin.saveSettings();
                    logger.info('Settings', `Context window words updated to: ${contextWords}`);
                }));

        // Highlight Block Setting (applies immediately)
        new Setting(containerEl)
            .setName('Highlight Block on Open')
            .setDesc('When opening a note from a block search result, highlight the entire block content')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.highlightBlockOnOpen)
                .onChange(async (value) => {
                    this.plugin.settings.highlightBlockOnOpen = value;
                    await this.plugin.saveSettings();
                    logger.info('Settings', `Highlight block on open: ${value}`);
                }));

        // Log Level Setting (applies immediately)
        new Setting(containerEl)
            .setName('Log Level')
            .setDesc('Set the logging verbosity level for debugging')
            .addDropdown(dropdown => dropdown
                .addOption(LogLevel.ERROR.toString(), 'ERROR')
                .addOption(LogLevel.WARN.toString(), 'WARN')
                .addOption(LogLevel.INFO.toString(), 'INFO')
                .addOption(LogLevel.DEBUG.toString(), 'DEBUG')
                .setValue(this.plugin.settings.logLevel.toString())
                .onChange(async (value) => {
                    const newLogLevel = parseInt(value) as LogLevel;
                    this.plugin.settings.logLevel = newLogLevel;
                    await this.plugin.saveSettings();
                    logger.setLevel(newLogLevel);
                }));
    }

    private createEmbeddingProvider(): EmbeddingProvider {
        switch (this.plugin.settings.embeddingProvider) {
            case 'ollama':
                // Create model manager if needed
                if (!this.plugin.modelManager) {
                    this.plugin.modelManager = new OllamaModelManager(this.plugin.settings.ollamaBaseUrl, logger);
                }
                
                // Create Ollama provider with model manager
                const ollamaProvider = new OllamaEmbeddingProvider(
                    this.plugin.settings.ollamaBaseUrl, 
                    this.plugin.settings.embeddingModel, 
                    logger
                );
                ollamaProvider.setModelManager(this.plugin.modelManager);
                return ollamaProvider;
            case 'openai':
                return new OpenAIEmbeddingProvider(
                    this.plugin.settings.openaiApiKey,
                    this.plugin.settings.embeddingModel,
                    'https://api.openai.com',
                    logger
                );
            default:
                throw new Error(`Unknown embedding provider: ${this.plugin.settings.embeddingProvider}`);
        }
    }

    private async reinitializeServices(): Promise<void> {
        logger.info('Plugin', 'Reinitializing services with new settings...');
        
        // Always recreate all services for safety
        const provider = this.createEmbeddingProvider();
        this.plugin.embeddingService = new EmbeddingService(provider, logger);
        
        this.plugin.chunkingService = new ChunkingService(
            this.plugin.settings.chunkSize, 
            this.plugin.settings.chunkOverlap, 
            this.plugin, 
            logger
        );
        
        // Recreate search service to use the new embedding service
        this.plugin.searchService = new SearchService(
            this.plugin.databaseService, 
            this.plugin.embeddingService, 
            logger
        );
        
        // Clear any cached validation results to force fresh validation
        this.plugin.clearValidationCache();
        
        logger.info('Plugin', 'Services reinitialized successfully');
    }

    private async validateCurrentProvider(): Promise<void> {
        const provider = this.plugin.embeddingService.embeddingProvider;
        await provider.validate();
    }

    private async confirmAndSave() {
        const requiresReindex = this.requiresReindex();
        
        if (requiresReindex) {
            new ReindexConfirmModal(
                this.app, 
                async () => {
                    // User confirmed - proceed with save and reindex
                    await this.saveAndReindex();
                },
                () => {
                    // User cancelled - reset pending settings and clear save/cancel state
                    this.pendingSettings = { ...this.plugin.settings };
                    this.hasSensitiveChanges = false;
                    this.display();
                }
            ).open();
        } else {
            await this.saveSettings();
        }
    }

    private requiresReindex(): boolean {
        return (
            this.plugin.settings.embeddingProvider !== this.pendingSettings.embeddingProvider ||
            this.plugin.settings.embeddingModel !== this.pendingSettings.embeddingModel ||
            this.plugin.settings.vectorSize !== this.pendingSettings.vectorSize ||
            this.plugin.settings.chunkSize !== this.pendingSettings.chunkSize ||
            this.plugin.settings.chunkOverlap !== this.pendingSettings.chunkOverlap
        );
    }

    private async saveAndReindex() {
        if (this.plugin.isOperationInProgress) {
            new Notice('Database operation already in progress. Please wait for it to complete.');
            return;
        }

        this.plugin.isOperationInProgress = true;
        try {
            // Save settings first
            this.plugin.settings = { ...this.pendingSettings };
            await this.plugin.saveSettings();
            this.hasSensitiveChanges = false;
            this.display(); // Immediately refresh UI to clear save/cancel buttons
            
            new Notice('Settings saved. Validating configuration...');
            logger.info('Plugin', 'Starting reindexing process with new settings');
            
            // Reinitialize services with new settings
            await this.reinitializeServices();
            
            // Validate provider before destructive operations
            new Notice('Validating embedding provider...');
            await this.validateCurrentProvider();
            
            new Notice('Configuration validated. Rebuilding vector database...');
            logger.info('Plugin', 'Beginning vector database rebuild');
            
            // Use the existing rebuildDatabase method which handles everything properly
            await this.plugin.rebuildDatabase();
            
            new Notice('Reindexing completed successfully!');
            logger.info('Plugin', 'Reindexing completed successfully');
            
            // Update system status to reflect successful reindex
            this.plugin.isSystemValid = true;
            this.plugin.updateStatusBar('check', 'Tezcat: System ready', 'tezcat-status-ready');
            
            // Reset pending settings to match saved settings and refresh UI
            this.pendingSettings = { ...this.plugin.settings };
            this.hasSensitiveChanges = false;
            this.display();
            
        } catch (error) {
            logger.error('Plugin', 'Reindexing failed', error);
            
            // Keep new settings but show clear error and reset UI state
            let errorMessage = 'Reindexing failed: ';
            if (error.message.includes('Ollama')) {
                errorMessage += error.message;
            } else if (error.message.includes('OpenAI')) {
                errorMessage += error.message;
            } else {
                errorMessage += 'Unknown error occurred. Check console for details.';
            }
            
            new Notice(errorMessage, 10000);
            new Notice('Try using Command Palette - "Tezcat: Rebuild Vector Database" to retry with the new settings.', 8000);
            
            // Reset pending settings to match saved settings (even though save failed, we want UI to reflect current state)
            this.pendingSettings = { ...this.plugin.settings };
            this.hasSensitiveChanges = false;
            this.display();
        } finally {
            this.plugin.isOperationInProgress = false;
        }
    }

    private async saveSettings() {
        this.plugin.settings = { ...this.pendingSettings };
        await this.plugin.saveSettings();
        this.hasSensitiveChanges = false;
        
        new Notice('Settings saved.');
        this.display();
    }

    private cancelChanges() {
        this.pendingSettings = { ...this.plugin.settings };
        this.hasSensitiveChanges = false;
        this.display();
    }
}

class ReindexConfirmModal extends Modal {
    private onConfirm: () => void;
    private onCancel: () => void;

    constructor(app: App, onConfirm: () => void, onCancel: () => void) {
        super(app);
        this.onConfirm = onConfirm;
        this.onCancel = onCancel;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();

        contentEl.createEl('h2', { text: 'Confirm Reindex' });
        
        contentEl.createEl('p', {
            text: 'The changes you made will require reindexing all vault content. This may take several minutes depending on your vault size.'
        });

        contentEl.createEl('p', {
            text: 'During reindexing:',
            cls: 'setting-item-description'
        });

        const list = contentEl.createEl('ul');
        list.createEl('li', { text: 'All existing embeddings will be cleared' });
        list.createEl('li', { text: 'New embeddings will be generated for all files' });
        list.createEl('li', { text: 'Search functionality may be limited until complete' });

        const buttonContainer = contentEl.createDiv('tezcat-button-container');
        
        const confirmButton = buttonContainer.createEl('button', {
            text: 'Confirm and Reindex',
            cls: 'mod-cta'
        });
        confirmButton.onclick = () => {
            this.close();
            this.onConfirm();
        };

        const cancelButton = buttonContainer.createEl('button', {
            text: 'Cancel'
        });
        cancelButton.onclick = () => {
            this.close();
            this.onCancel();
        };
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}

class VectorSearchModal extends Modal {
    private onSubmit: (query: string) => void;

    constructor(app: App, onSubmit: (query: string) => void) {
        super(app);
        this.onSubmit = onSubmit;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();

        contentEl.createEl('h2', { text: 'Vector Search' });
        
        const inputContainer = contentEl.createDiv('tezcat-modal-input-container');
        const input = inputContainer.createEl('input', {
            type: 'text',
            placeholder: 'Enter your search query...',
            cls: 'tezcat-input'
        });

        const buttonContainer = contentEl.createDiv('tezcat-button-container');
        
        const searchButton = buttonContainer.createEl('button', {
            text: 'Search',
            cls: 'mod-cta'
        });
        searchButton.onclick = () => {
            const query = input.value.trim();
            if (query) {
                this.close();
                this.onSubmit(query);
            }
        };

        const cancelButton = buttonContainer.createEl('button', {
            text: 'Cancel'
        });
        cancelButton.onclick = () => this.close();

        // Focus the input and handle Enter key
        input.focus();
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                searchButton.click();
            }
        });
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}

class SystemStatusModal extends Modal {
    private validationResult: SystemValidationResult;
    private isSystemValid: boolean;
    private plugin: Tezcat;

    constructor(app: App, validationResult: SystemValidationResult, isSystemValid: boolean, plugin: Tezcat) {
        super(app);
        this.validationResult = validationResult;
        this.isSystemValid = isSystemValid;
        this.plugin = plugin;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();

        contentEl.createEl('h2', { text: 'Tezcat System Status' });
        
        // Show operation in progress status
        if (this.plugin.isOperationInProgress) {
            const progressEl = contentEl.createDiv('tezcat-operation-progress');
            progressEl.addClass('operation-in-progress');
            progressEl.createEl('strong', { text: 'Operation in Progress' });
            progressEl.createEl('br');
            progressEl.appendText('Database rebuild or validation is currently running. Please wait for it to complete.');
            progressEl.createEl('br');
        }
        
        // Overall status
        const overallEl = contentEl.createDiv('tezcat-overall-status');
        
        if (this.isSystemValid) {
            overallEl.addClass('system-ready');
            const strongEl = overallEl.createEl('strong', { text: 'System Ready' });
            overallEl.createEl('br');
            overallEl.appendText('All components are working correctly.');
        } else {
            overallEl.addClass('setup-required');
            const strongEl = overallEl.createEl('strong', { text: 'Setup Required' });
            overallEl.createEl('br');
            overallEl.appendText('Some components need attention.');
        }
        
        // Detailed status
        const detailsEl = contentEl.createDiv('system-status-details');
        
        // Provider status
        this.createStatusItem(
            detailsEl,
            'Embedding Provider',
            this.validationResult.embeddingProvider
        );
        
        // Models status
        this.createStatusItem(
            detailsEl,
            'Models',
            this.validationResult.models
        );
        
        // Database status
        this.createStatusItem(
            detailsEl,
            'Database',
            this.validationResult.database
        );
        
        // Action buttons
        const buttonContainer = contentEl.createDiv('tezcat-button-container');
        
        if (!this.isSystemValid) {
            const retryButton = buttonContainer.createEl('button', {
                text: this.plugin.isOperationInProgress ? 'Operation in Progress...' : 'Retry Setup',
                cls: this.plugin.isOperationInProgress ? 'mod-muted' : 'mod-cta'
            });
            
            if (this.plugin.isOperationInProgress) {
                retryButton.disabled = true;
                retryButton.style.opacity = '0.5';
            } else {
                retryButton.onclick = async () => {
                    this.close();
                    new Notice('Retrying system setup...');
                    await this.plugin.performValidationAndSetup();
                };
            }
            
            const settingsButton = buttonContainer.createEl('button', {
                text: 'Open Settings'
            });
            settingsButton.onclick = () => {
                this.close();
                (this.app as any).setting.open();
                (this.app as any).setting.openTabById('tezcat');
            };
        }
        
        const closeButton = buttonContainer.createEl('button', {
            text: 'Close'
        });
        closeButton.onclick = () => this.close();
    }
    
    private createStatusItem(container: HTMLElement, title: string, result: ValidationResult) {
        const itemEl = container.createDiv('tezcat-validation-item');
        
        const headerEl = itemEl.createDiv('tezcat-validation-header');
        
        const titleEl = headerEl.createEl('strong');
        titleEl.textContent = title;
        
        const statusEl = headerEl.createSpan({ cls: 'tezcat-validation-status' });
        if (result.success) {
            statusEl.textContent = 'Ready';
            statusEl.addClass('ready');
        } else {
            statusEl.textContent = 'Issue';
            statusEl.addClass('issue');
        }
        
        const messageEl = itemEl.createDiv('tezcat-validation-message');
        messageEl.textContent = result.message;
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}

class VectorSearchResultsModal extends Modal {
    private query: string;
    private results: SearchResult[];

    constructor(app: App, query: string, results: SearchResult[]) {
        super(app);
        this.query = query;
        this.results = results;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();

        contentEl.createEl('h2', { text: `Search Results for: "${this.query}"` });
        contentEl.createEl('p', { text: `Found ${this.results.length} matches` });

        const resultsContainer = contentEl.createDiv('tezcat-search-results');

        this.results.forEach((result, index) => {
            const resultEl = resultsContainer.createDiv('tezcat-search-result');

            if (result.type === 'chunk') {
                // For chunks: show chunk text first, then note info below
                const textEl = resultEl.createDiv('tezcat-search-result-text');
                textEl.textContent = result.text.length > 200 ? result.text.substring(0, 200) + '...' : result.text;

                // Note info with score and type
                const headerEl = resultEl.createDiv('tezcat-search-result-header');

                const titleEl = headerEl.createEl('strong', { cls: 'tezcat-search-result-title' });
                titleEl.textContent = result.noteName;

                const metaEl = headerEl.createDiv();
                const typeSpan = metaEl.createEl('span', { text: result.type });
                typeSpan.style.background = 'var(--background-modifier-border)';
                typeSpan.style.padding = '2px 6px';
                typeSpan.style.borderRadius = '3px';
                typeSpan.style.fontSize = '0.8em';
                
                const scoreSpan = metaEl.createEl('span', { text: `Score: ${result.score.toFixed(3)}` });
                scoreSpan.style.color = 'var(--text-muted)';
                scoreSpan.style.fontSize = '0.9em';
                scoreSpan.style.marginLeft = '6px';

                // Path
                const pathEl = resultEl.createDiv('tezcat-search-result-path');
                pathEl.textContent = result.notePath;
            } else {
                // For notes: show note info first, then path
                const headerEl = resultEl.createDiv('tezcat-search-result-header');

                const titleEl = headerEl.createEl('strong');
                titleEl.textContent = result.noteName;

                const metaEl = headerEl.createDiv();
                const typeSpan = metaEl.createEl('span', { text: result.type });
                typeSpan.style.background = 'var(--background-modifier-border)';
                typeSpan.style.padding = '2px 6px';
                typeSpan.style.borderRadius = '3px';
                typeSpan.style.fontSize = '0.8em';
                
                const scoreSpan = metaEl.createEl('span', { text: `Score: ${result.score.toFixed(3)}` });
                scoreSpan.style.color = 'var(--text-muted)';
                scoreSpan.style.fontSize = '0.9em';
                scoreSpan.style.marginLeft = '6px';

                // Path
                const pathEl = resultEl.createDiv('tezcat-search-result-path note-path');
                pathEl.textContent = result.notePath;

                // Text content (note path and name)
                const textEl = resultEl.createDiv('tezcat-search-result-text');
                textEl.textContent = result.text.length > 200 ? result.text.substring(0, 200) + '...' : result.text;
                textEl.style.fontSize = '0.9em';
                textEl.style.lineHeight = '1.4';
            }

            // Click to open note
            resultEl.onclick = () => {
                this.close();
                this.app.workspace.openLinkText(result.notePath, '', false);
            };

            // Hover effects are handled by CSS
        });

        const buttonContainer = contentEl.createDiv('tezcat-button-container');
        const closeButton = buttonContainer.createEl('button', {
            text: 'Close'
        });
        closeButton.onclick = () => this.close();
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}

