import { App, CachedMetadata, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting, TAbstractFile, TFile, WorkspaceLeaf} from 'obsidian';
import { EditorView } from '@codemirror/view';
import { TezcatView, VIEW_TYPE } from './search_view';
import { DatabaseService, SqlJsDatabaseAdapter } from './database_service';
import { EmbeddingService, OllamaEmbeddingProvider, OpenAIEmbeddingProvider, OllamaModelManager } from './embedding_service';
import { SearchService, SearchResult } from './search_service';
import { logger, LogLevel } from './logger';
import { ValidationService, SystemValidationResult, ValidationResult } from './validation_service';
import { NoteProcessor } from './note_processor';
import { cursorContext } from './context';


type EmbeddingProviderType = 'openai' | 'ollama';
type SearchCadence = 'always' | 'sometimes' | 'occasionally';

/** Wait this long after a file's last change before re-indexing it (Obsidian saves while you type). */
const INDEX_DELAY_MS = 2000;

/** Debounce before searching, per cadence setting. */
const SEARCH_DELAY_MS: Record<SearchCadence, number> = { always: 500, sometimes: 2000, occasionally: 8000 };
type SearchMode = 'vector' | 'hybrid';

/** Models offered per provider; the first is the default when switching provider. */
const EMBEDDING_MODELS: Record<EmbeddingProviderType, [id: string, label: string][]> = {
    ollama: [['nomic-embed-text:v1.5', 'Nomic Embed Text v1.5 (768d)'], ['bge-m3', 'BGE M3 (1024d)']],
    openai: [['text-embedding-3-small', 'Text Embedding 3 Small (1536d)'], ['text-embedding-3-large', 'Text Embedding 3 Large (3072d)']],
};

interface TezcatSettings {
    embeddingProvider: EmbeddingProviderType;
    embeddingModel: string;
    openaiApiKey: string;
    ollamaBaseUrl: string;
    contextWindowWords: number;
    searchCadence: SearchCadence;
    searchMode: SearchMode;
    logLevel: LogLevel;
    highlightBlockOnOpen: boolean;
}

const DEFAULT_SETTINGS: TezcatSettings = {
    embeddingProvider: 'ollama',
    embeddingModel: 'nomic-embed-text:v1.5',
    openaiApiKey: '',
    ollamaBaseUrl: 'http://localhost:11434',
    contextWindowWords: 64, // Smaller context window for more focused search
    searchCadence: 'always',
    searchMode: 'hybrid',
    logLevel: LogLevel.ERROR,
    highlightBlockOnOpen: true
}

type EmbeddingSettings = Pick<TezcatSettings, 'embeddingProvider' | 'embeddingModel' | 'openaiApiKey' | 'ollamaBaseUrl'>;

const pickEmbeddingSettings = (s: TezcatSettings): EmbeddingSettings => ({
    embeddingProvider: s.embeddingProvider,
    embeddingModel: s.embeddingModel,
    openaiApiKey: s.openaiApiKey,
    ollamaBaseUrl: s.ollamaBaseUrl,
});

const isMarkdown = (file: TAbstractFile): file is TFile => file instanceof TFile && file.extension === 'md';

export default class Tezcat extends Plugin {
    settings: TezcatSettings;
    public databaseService: DatabaseService;
    public databaseAdapter: SqlJsDatabaseAdapter;
    public embeddingService: EmbeddingService;
    public searchService: SearchService;
    private noteProcessor: NoteProcessor;
    private validationService: ValidationService;
    public modelManager: OllamaModelManager | null = null;
    private systemValidationResult: SystemValidationResult | null = null;
    public isSystemValid: boolean = false;
    public isOperationInProgress: boolean = false;
    private searchDebounceTimer: number | null = null;
    private searchSeq = 0; // Increments per search; stale results are dropped
    private searchSuppressedUntil: number = 0; // Timestamp to suppress search until
    // File indexing runs one file at a time, so a file is never processed twice concurrently.
    private indexQueue: Promise<unknown> = Promise.resolve();
    private pendingIndex = new Map<string, { timer: number; content: string; cache: CachedMetadata }>();
    private statusBarItem: HTMLElement | null = null; // Status bar item for system status

    async onload() {
        const { firstRun } = await this.loadSettings();
        
        // Configure logger from settings
        logger.setLevel(this.settings.logLevel);
        logger.info('Plugin', 'Loading Tezcat plugin');
        
        
        // Initialize validation service
        this.validationService = new ValidationService(logger);
        
        // Initialize database (only this needs async initialization due to file I/O)
        this.databaseAdapter = new SqlJsDatabaseAdapter(this, logger);
        await this.databaseAdapter.initialize();
        
        // Initialize services but don't validate yet
        this.databaseService = new DatabaseService(this.databaseAdapter, logger);
        this.initializeEmbeddingServices();
        this.searchService = new SearchService(this.databaseService, this.embeddingService, logger);

        // Initialize note processor
        this.noteProcessor = new NoteProcessor();

        // Create status bar item
        this.statusBarItem = this.addStatusBarItem();
        this.updateStatusBar('sync', 'Tezcat: Initializing...', 'tezcat-status-initializing');
        
        // Once the vault has loaded: keep the index in sync with file changes, then validate and
        // index. Registering earlier would also receive an event for every file during vault load.
        this.app.workspace.onLayoutReady(() => {
            this.registerIndexingEvents();
            this.performValidationAndSetup();
            // Open the panel once, on first install. After that Obsidian restores it with the
            // saved layout, and a closed panel stays closed.
            if (firstRun) {
                void this.activateView();
                void this.saveData(this.settings);
            }
        });
        
        //net new set up view
        this.registerView(VIEW_TYPE, (leaf) => new TezcatView(leaf, this));
        
        this.addRibbonIcon('eye', 'Open Tezcat panel', () => this.activateView());
        this.addCommand({ id: 'open-panel', name: 'Open panel', callback: () => this.activateView() });

        // Add command to process all vault files
        this.addCommand({
            id: 'process-all-files',
            name: 'Process all files',
            callback: async () => {
                await this.processAllVaultFilesIntoDatabase();
            }
        });

        // Add vector database commands
        this.registerCommand('rebuild-database', 'Rebuild database', () => this.rebuildDatabase());
        this.registerCommand('show-vector-database-stats', 'Show vector database stats', () => this.showVectorDatabaseStats());
        this.registerCommand('vector-search', 'Vector search', () => this.performVectorSearch());


        // This adds a settings tab so the user can configure various aspects of the plugin
        this.addSettingTab(new TezcatSettingTab(this.app, this));

        // Search as the user types or moves the cursor (keyboard or mouse)...
        this.registerEditorExtension(EditorView.updateListener.of((update) => {
            if (update.docChanged || update.selectionSet) this.scheduleSearch();
        }));
        // ...and when they switch to another note or pane.
        this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.scheduleSearch()));
        this.registerEvent(this.app.workspace.on('file-open', () => this.scheduleSearch()));
    }

    /** Index one file. Run through `enqueueIndexing` so files are processed one at a time. */
    private async processOneFileIntoDatabase(file: TFile, parsed?: { content: string; cache: CachedMetadata }) {
        try {
            // Blocks are cut from the content using the parsed sections' offsets, so the two must
            // come from the same version of the file.
            const content = parsed?.content ?? await this.app.vault.cachedRead(file);
            const metadata = parsed?.cache ?? this.app.metadataCache.getFileCache(file);

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
            let skipped = 0;
            
            for (const file of files) {
                const result = await this.enqueueIndexing(() => this.processOneFileIntoDatabase(file));
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
          await workspace.revealLeaf(leaf);
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
        const saved = await this.loadData();
        this.settings = Object.assign({}, DEFAULT_SETTINGS, saved);
        return { firstRun: saved == null };
    }

    /** Persist settings. Search and display settings take effect immediately. */
    async saveSettings() {
        await this.saveData(this.settings);
        logger.setLevel(this.settings.logLevel);
    }

    /** A different provider or model embeds into a different vector space, so the index must be rebuilt. */
    needsReindex(changes: EmbeddingSettings): boolean {
        return changes.embeddingProvider !== this.settings.embeddingProvider
            || changes.embeddingModel !== this.settings.embeddingModel;
    }

    /**
     * Save new embedding settings and rebuild the services that depend on them. Provider or model
     * changes then rebuild the index; URL and API key changes re-run validation and setup.
     */
    async updateEmbeddingSettings(changes: EmbeddingSettings): Promise<void> {
        const reindex = this.needsReindex(changes);
        Object.assign(this.settings, changes);
        await this.saveSettings();

        this.initializeEmbeddingServices();
        this.searchService = new SearchService(this.databaseService, this.embeddingService, logger);
        this.clearValidationCache();

        if (!reindex) {
            new Notice('Settings saved.');
            await this.performValidationAndSetup();
            return;
        }
        try {
            new Notice('Settings saved. Checking the embedding provider...');
            await this.embeddingService.embeddingProvider.validate();
        } catch (error) {
            logger.error('Plugin', 'Embedding provider validation failed', error);
            const message = error instanceof Error ? error.message : String(error);
            new Notice(`Could not use the embedding provider: ${message}\nFix the settings, then run "Tezcat: Rebuild database".`, 10000);
            this.updateStatusBar('alert-triangle', 'Tezcat: Setup required', 'tezcat-status-error');
            return;
        }
        await this.rebuildDatabase();
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
            await this.databaseAdapter.createVectorsTable();
            await this.databaseAdapter.createBlocksTable();
            await this.databaseAdapter.createFTSTable();
            
            // Process all vault files with the clean database
            new Notice('Processing all vault files...');
            await this.processAllVaultFilesIntoDatabase(false);
            
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
            } else {
                logger.warn('Plugin', 'System validation failed, skipping automatic setup');
                this.updateStatusBar('alert-triangle', 'Tezcat: Setup required', 'tezcat-status-error');
                this.showValidationFailureGuidance();
            }
            
        } catch (error) {
            logger.error('Plugin', 'System validation failed with error', error);
            this.isSystemValid = false;
            this.updateStatusBar('x', 'Tezcat: Setup failed', 'tezcat-status-error');
            new Notice('Tezcat setup failed. Check console for details.', 10000);
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
            
            // Ensure FTS content exists for all notes (for hybrid search)
            logger.info('Plugin', 'Ensuring FTS content is populated...');
            await this.databaseService.ensureFTSContentForAllNotes();
            
            logger.info('Plugin', 'Automatic setup completed successfully');
        } catch (error) {
            logger.error('Plugin', 'Failed during automatic setup', error);
        }
    }

    async showVectorDatabaseStats() {
        try {
            const stats = await this.databaseService.getVectorDatabaseStats();

            const message = `Vector database stats:
• Total notes: ${stats.totalNotes}
• Total vectors: ${stats.totalVectors}
• Note vectors: ${stats.vectorsByType.note}
• Block vectors: ${stats.vectorsByType.block}`;

            new Notice(message, 10000); // Show for 10 seconds
            logger.info('Plugin', `Vector Database Stats: totalNotes=${stats.totalNotes}, totalVectors=${stats.totalVectors}, noteVectors=${stats.vectorsByType.note}, blockVectors=${stats.vectorsByType.block}`);
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


    /** Debounced: searches once the user pauses, using the cursor context at that moment. */
    private scheduleSearch() {
        if (!this.isSearchPanelVisible() || Date.now() < this.searchSuppressedUntil) return;
        if (this.searchDebounceTimer) window.clearTimeout(this.searchDebounceTimer);
        this.searchDebounceTimer = window.setTimeout(() => {
            this.searchDebounceTimer = null;
            void this.runSearch();
        }, SEARCH_DELAY_MS[this.settings.searchCadence] ?? SEARCH_DELAY_MS.always);
    }

    /**
     * The search panel, if it is open and loaded. A deferred leaf (restored from the saved
     * layout but never shown since startup) has no TezcatView yet and returns null.
     */
    private get view(): TezcatView | null {
        const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
        return leaf?.view instanceof TezcatView ? leaf.view : null;
    }

    private isSearchPanelVisible(): boolean {
        return this.view?.containerEl.isShown() ?? false;
    }

    private async runSearch() {
        if (Date.now() < this.searchSuppressedUntil) return;
        // Results stay as they are when focus is somewhere other than a note (e.g. the panel).
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view) return;
        const editor = view.editor;
        const context = cursorContext(editor, editor.getCursor(), this.settings.contextWindowWords);
        if (!context.trim()) return;

        const seq = ++this.searchSeq;
        const excludeNotePaths = view.file ? [view.file.path] : [];
        try {
            const options = { topK: 10, includeNoteVectors: true, includeBlockVectors: true, excludeNotePaths };
            const results = this.settings.searchMode === 'hybrid'
                // RRF scores are much smaller than cosine similarities, hence minScore 0.
                ? await this.searchService.hybridSearch(context, { ...options, minScore: 0, hybridWeight: 0.5 })
                : await this.searchService.vectorSearch(context, { ...options, minScore: 0.1 });
            // A newer search started while this one ran; its results win.
            if (seq !== this.searchSeq) return;
            await this.updateSearchPanel(results);
        } catch (error) {
            logger.error('Plugin', 'Dynamic search failed', error);
            if (seq === this.searchSeq) await this.updateSearchPanel([]);
        }
    }

    private async updateSearchPanel(results: SearchResult[]) {
        await this.view?.updateSearchResults(results);
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

    private registerIndexingEvents() {
        // Fires after Obsidian has re-parsed a file (including newly created files), with the
        // content and sections from the same parse.
        this.registerEvent(this.app.metadataCache.on('changed', (file, content, cache) => {
            if (file.extension === 'md') this.scheduleIndexing(file, content, cache);
        }));
        this.registerEvent(this.app.vault.on('delete', (file) => {
            if (!isMarkdown(file)) return;
            // A pending re-index would otherwise run after the delete and re-insert the note.
            this.cancelPendingIndexing(file.path);
            void this.enqueueIndexing(() => this.handleFileDelete(file.path));
        }));
        this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
            if (isMarkdown(file)) void this.enqueueIndexing(() => this.handleFileRename(file, oldPath));
        }));
        this.register(() => {
            for (const path of [...this.pendingIndex.keys()]) this.cancelPendingIndexing(path);
        });
    }

    /** Index a changed file once it has stopped changing, using its latest parse. */
    private scheduleIndexing(file: TFile, content: string, cache: CachedMetadata) {
        // Keyed by the path at the time of the change: renaming mutates `file.path`.
        const key = file.path;
        this.cancelPendingIndexing(key);
        const timer = window.setTimeout(() => {
            const latest = this.pendingIndex.get(key);
            this.pendingIndex.delete(key);
            // Skip files deleted in the meantime. A renamed file is indexed under its new path;
            // its rename was queued first, so the note's stored path is already updated.
            if (!latest || this.app.vault.getAbstractFileByPath(file.path) !== file) return;
            void this.enqueueIndexing(() => this.processOneFileIntoDatabase(file, latest));
        }, INDEX_DELAY_MS);
        this.pendingIndex.set(key, { timer, content, cache });
    }

    private cancelPendingIndexing(path: string) {
        const pending = this.pendingIndex.get(path);
        if (!pending) return;
        window.clearTimeout(pending.timer);
        this.pendingIndex.delete(path);
    }

    private enqueueIndexing<T>(task: () => Promise<T>): Promise<T> {
        const run = this.indexQueue.then(task, task);
        this.indexQueue = run.catch(() => {});
        return run;
    }

    private async handleFileDelete(path: string) {
        try {
            const existingNote = await this.databaseService.getNoteByPath(path);
            if (existingNote) {
                logger.info('Plugin', `Removing deleted note from database: ${path}`);
                // Delete vectors, then the note
                await this.databaseService.deleteVectorsForNote(existingNote.id);
                await this.databaseService.deleteNote(existingNote.id);
            }
        } catch (error) {
            logger.error('Plugin', `Failed to handle file delete for ${path}`, error);
        }
    }

    private async handleFileRename(file: TFile, oldPath: string) {
        try {
            const existingNote = await this.databaseService.getNoteByPath(oldPath);
            if (existingNote) {
                logger.debug('Plugin', `Updating renamed note path: ${oldPath} -> ${file.path}`);
                await this.databaseService.updateNote(existingNote.id, {
                    name: file.name,
                    base_name: file.basename,
                    path: file.path
                });
            } else {
                // Not indexed under the old path (e.g. renamed from another extension): index it now
                await this.processOneFileIntoDatabase(file);
            }
        } catch (error) {
            logger.error('Plugin', `Failed to handle file rename from ${oldPath} to ${file.path}`, error);
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

}


class TezcatSettingTab extends PluginSettingTab {
    plugin: Tezcat;
    /** Unsaved embedding settings; applied together with "Save changes". */
    private pending: EmbeddingSettings;
    private dirty = false;

    constructor(app: App, plugin: Tezcat) {
        super(app, plugin);
        this.plugin = plugin;
        this.pending = pickEmbeddingSettings(plugin.settings);
    }

    display(): void {
        const {containerEl} = this;

        containerEl.empty();
        if (!this.dirty) this.pending = pickEmbeddingSettings(this.plugin.settings);
        const markDirty = () => { this.dirty = true; this.display(); };

        // Embedding Settings Section
        new Setting(containerEl).setHeading().setName('Embeddings');
        containerEl.createEl('p', {
            text: 'Changing the provider or model requires reindexing all vault content.',
            cls: 'setting-item-description'
        });

        new Setting(containerEl)
            .setName('Embedding provider')
            .setDesc('Choose the provider for generating embeddings')
            .addDropdown(dropdown => dropdown
                .addOption('ollama', 'Ollama')
                .addOption('openai', 'OpenAI')
                .setValue(this.pending.embeddingProvider)
                .onChange((value: EmbeddingProviderType) => {
                    this.pending.embeddingProvider = value;
                    // The previous provider's model isn't available here; start from this one's default.
                    this.pending.embeddingModel = EMBEDDING_MODELS[value][0][0];
                    markDirty();
                }));

        new Setting(containerEl)
            .setName('Embedding model')
            .setDesc('The model to use for generating embeddings')
            .addDropdown(dropdown => {
                for (const [id, label] of EMBEDDING_MODELS[this.pending.embeddingProvider]) dropdown.addOption(id, label);
                dropdown
                    .setValue(this.pending.embeddingModel)
                    .onChange((value) => {
                        this.pending.embeddingModel = value;
                        markDirty();
                    });
            });

        // Text fields update on every keystroke but only redraw (showing Save) on blur, so
        // typing doesn't lose focus.
        const textSetting = (key: 'openaiApiKey' | 'ollamaBaseUrl', name: string, desc: string, placeholder: string) =>
            new Setting(containerEl).setName(name).setDesc(desc).addText(text => {
                text.setPlaceholder(placeholder)
                    .setValue(this.pending[key])
                    .onChange((value) => { this.pending[key] = value; });
                text.inputEl.addEventListener('blur', () => {
                    if (this.pending[key] !== this.plugin.settings[key]) markDirty();
                });
            });

        if (this.pending.embeddingProvider === 'openai') {
            textSetting('openaiApiKey', 'OpenAI API key', 'Your OpenAI API key for embedding generation', 'sk-...');
        } else {
            textSetting('ollamaBaseUrl', 'Ollama base URL', 'The base URL for your Ollama server', 'http://localhost:11434');
        }

        if (this.dirty) {
            new Setting(containerEl)
                .addButton(button => button
                    .setButtonText('Save changes')
                    .setCta()
                    .onClick(() => this.saveEmbeddingSettings()))
                .addButton(button => button
                    .setButtonText('Cancel')
                    .onClick(() => { this.dirty = false; this.display(); }));
        }

        // Rebuild Database Button
        new Setting(containerEl)
            .setName('Rebuild database & index')
            .setDesc('Completely rebuild the database and reindex all vault content. This will take some time but can fix indexing issues.')
            .addButton(button => button
                .setButtonText('Rebuild database')
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
        containerEl.createEl('hr', {
            cls: 'tezcat-settings-divider'
        });

        // Application Settings Section
        new Setting(containerEl).setHeading().setName('Application');
        containerEl.createEl('p', {
            text: 'These settings take effect immediately and don\'t require reindexing.',
            cls: 'setting-item-description'
        });

        // Search Cadence Setting (applies immediately)
        new Setting(containerEl)
            .setName('Search cadence')
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
            .setName('Search mode')
            .setDesc('Choose between vector-only search or hybrid search combining semantic similarity with keyword matching')
            .addDropdown(dropdown => dropdown
                .addOption('vector', 'Vector only (semantic similarity)')
                .addOption('hybrid', 'Hybrid (semantic + keyword matching)')
                .setValue(this.plugin.settings.searchMode)
                .onChange(async (value: SearchMode) => {
                    this.plugin.settings.searchMode = value;
                    await this.plugin.saveSettings();
                    logger.info('Settings', `Search mode updated to: ${value}`);
                }));

        // Context Window Setting (applies immediately)
        new Setting(containerEl)
            .setName('Search context window (words)')
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
            .setName('Highlight block on open')
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
            .setName('Log level')
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

    private saveEmbeddingSettings() {
        const changes = { ...this.pending };
        const apply = async () => {
            // updateEmbeddingSettings applies the new values before its first await, so the
            // redraw shows them while validation or reindexing continues.
            const done = this.plugin.updateEmbeddingSettings(changes);
            this.dirty = false;
            this.display();
            await done;
        };
        if (this.plugin.needsReindex(changes)) {
            new ReindexConfirmModal(this.app, apply, () => {}).open();
        } else {
            void apply();
        }
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

        new Setting(contentEl).setHeading().setName('Confirm reindex');

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

        new Setting(contentEl).setHeading().setName('Vector search');

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

        new Setting(contentEl).setHeading().setName('Tezcat system status');

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
            overallEl.createEl('strong', { text: 'System ready' });
            overallEl.createEl('br');
            overallEl.appendText('All components are working correctly.');
        } else {
            overallEl.addClass('setup-required');
            overallEl.createEl('strong', { text: 'Setup required' });
            overallEl.createEl('br');
            overallEl.appendText('Some components need attention.');
        }
        
        // Detailed status
        const detailsEl = contentEl.createDiv('system-status-details');
        
        // Provider status
        this.createStatusItem(
            detailsEl,
            'Embedding provider',
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
                text: this.plugin.isOperationInProgress ? 'Operation in progress...' : 'Retry setup',
                cls: this.plugin.isOperationInProgress ? 'mod-muted' : 'mod-cta'
            });
            
            if (this.plugin.isOperationInProgress) {
                retryButton.disabled = true;
                retryButton.addClass('tezcat-button-disabled');
            } else {
                retryButton.onclick = async () => {
                    this.close();
                    new Notice('Retrying system setup...');
                    await this.plugin.performValidationAndSetup();
                };
            }
            
            const settingsButton = buttonContainer.createEl('button', {
                text: 'Open settings'
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

        new Setting(contentEl).setHeading().setName(`Search results for: "${this.query}"`);
        contentEl.createEl('p', { text: `Found ${this.results.length} matches` });

        const resultsContainer = contentEl.createDiv('tezcat-search-results');

        this.results.forEach((result) => {
            const resultEl = resultsContainer.createDiv('tezcat-search-result');

            // Note name, result type and score, then path and text
            const headerEl = resultEl.createDiv('tezcat-search-result-header');

            const titleEl = headerEl.createEl('strong');
            titleEl.textContent = result.noteName;

            const metaEl = headerEl.createDiv();
            metaEl.createEl('span', {
                text: result.type,
                cls: 'tezcat-search-result-type'
            });

            metaEl.createEl('span', {
                text: `Score: ${result.score.toFixed(3)}`,
                cls: 'tezcat-search-result-score'
            });

            // Path
            const pathEl = resultEl.createDiv('tezcat-search-result-path note-path');
            pathEl.textContent = result.notePath;

            // Text content (block text, or note path and name)
            const textEl = resultEl.createDiv('tezcat-search-result-text');
            textEl.textContent = result.text.length > 200 ? result.text.substring(0, 200) + '...' : result.text;

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
