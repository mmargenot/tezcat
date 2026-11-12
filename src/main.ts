import { App, CachedMetadata, Component, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, SecretComponent, Setting, TAbstractFile, TFile, WorkspaceLeaf, normalizePath, setIcon } from 'obsidian';
import { EditorView } from '@codemirror/view';
import { TezcatView, VIEW_TYPE, renderResultText } from './search_view';
import { EmbeddingError, EmbeddingService, RECOMMENDED_OLLAMA_MODELS, embeddingModels, sameModel, suggestPrefixes } from './embedding_service';
import { DEFAULT_SETTINGS, migrateSettings, vectorSpaceOf, type EmbeddingSettings, type SearchCadence, type TezcatSettings } from './settings';
import { EmbeddingSpaceChanged, IndexRepository, type SourceFile, type VaultSource } from './index_repository';
import { SearchService, type SearchResult } from './search';
import { logger, LogLevel } from './logger';
import { cursorContext } from './context';


/** Wait this long after a file's last change before re-indexing it (Obsidian saves while you type). */
const INDEX_DELAY_MS = 2000;

/** Debounce before searching, per cadence setting. */
const SEARCH_DELAY_MS: Record<SearchCadence, number> = { always: 500, sometimes: 2000, occasionally: 8000 };

const RESULT_LIMIT = 10;

/** While the embedding provider is unreachable, check it again at most this often (on search or edit). */
const SEMANTIC_RETRY_MS = 30_000;

const isMarkdown = (file: TAbstractFile): file is TFile => file instanceof TFile && file.extension === 'md';

const toSourceFile = (file: TFile): SourceFile =>
    ({ path: file.path, basename: file.basename, mtime: file.stat.mtime, size: file.stat.size });

const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

export default class Tezcat extends Plugin {
    settings: TezcatSettings;
    private index: IndexRepository;
    private search: SearchService;
    private embeddingService: EmbeddingService;

    private indexReady = false;
    private indexProgress: { label: string; done: number; total: number } | null = null;
    /** Why semantic search is unavailable, if it is enabled but can't run. */
    private semanticError: string | null = null;
    private semanticRetryAt = 0;
    /** The service search and embedding actually use: the configured one, or a fallback. */
    private activeEmbedding: EmbeddingService | null = null;
    /** Set while the configured model is missing and the last working model is used instead. */
    private fallback: { configured: string; using: string } | null = null;
    private embedRun: AbortController | null = null;
    private embedAgain = false;
    private rebuilding = false;

    private searchDebounceTimer: number | null = null;
    private searchSeq = 0; // Increments per search; stale results are dropped
    private searchSuppressedUntil: number = 0; // Timestamp to suppress search until
    private pendingIndex = new Map<string, { timer: number; content: string; cache: CachedMetadata }>();
    private statusBarItem: HTMLElement | null = null;

    /** The vault, as the index sees it. */
    private readonly vault: VaultSource = {
        listFiles: () => this.app.vault.getMarkdownFiles().map(toSourceFile),
        read: async (path) => {
            const file = this.app.vault.getFileByPath(path);
            if (!file || file.extension !== 'md') return null;
            return { file: toSourceFile(file), content: await this.app.vault.cachedRead(file), cache: this.app.metadataCache.getFileCache(file) };
        },
    };

    async onload() {
        const { firstRun } = await this.loadSettings();
        logger.setLevel(this.settings.logLevel);

        this.index = new IndexRepository(this.indexNamespace(), logger);
        this.search = new SearchService(this.index, async (path) => {
            const file = this.app.vault.getFileByPath(path);
            return file ? this.app.vault.cachedRead(file) : null;
        }, logger);
        this.createEmbeddingService();

        this.statusBarItem = this.addStatusBarItem();
        this.statusBarItem.onclick = () => new StatusModal(this.app, this).open();
        this.refreshStatus();

        this.registerView(VIEW_TYPE, (leaf) => new TezcatView(leaf, this));
        this.addRibbonIcon('eye', 'Open Tezcat panel', () => this.activateView());
        this.addCommand({ id: 'open-panel', name: 'Open panel', callback: () => this.activateView() });
        // Command ids are kept from earlier versions so existing hotkeys keep working.
        this.addCommand({ id: 'process-all-files', name: 'Update index', callback: () => this.updateIndex() });
        this.addCommand({ id: 'rebuild-database', name: 'Rebuild index', callback: () => this.rebuildIndex() });
        this.addCommand({ id: 'show-vector-database-stats', name: 'Show index status', callback: () => new StatusModal(this.app, this).open() });
        this.addCommand({ id: 'vector-search', name: 'Search notes', callback: () => this.searchFromModal() });
        this.addSettingTab(new TezcatSettingTab(this.app, this));

        // Search as the user types or moves the cursor (keyboard or mouse)...
        this.registerEditorExtension(EditorView.updateListener.of((update) => {
            if (update.docChanged || update.selectionSet) this.scheduleSearch();
        }));
        // ...and when they switch to another note or pane.
        this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.scheduleSearch()));
        this.registerEvent(this.app.workspace.on('file-open', () => this.scheduleSearch()));

        // Once the vault has loaded: keep the index in sync with file changes, then load and
        // update it. Registering earlier would also receive an event for every file during load.
        this.app.workspace.onLayoutReady(() => {
            this.registerIndexingEvents();
            void this.startIndex();
            // Open the panel once, on first install. After that Obsidian restores it with the
            // saved layout, and a closed panel stays closed.
            if (firstRun) {
                void this.activateView();
                void this.saveData(this.settings);
            }
        });
    }

    async onunload() {
        this.embedRun?.abort();
        await this.index?.flush();
    }

    // ---------- settings ----------

    async loadSettings() {
        const saved = await this.loadData();
        const migrated = saved ? migrateSettings(saved, (name, key) => this.app.secretStorage.setSecret(name, key)) : false;
        this.settings = Object.assign({}, DEFAULT_SETTINGS, saved);
        if (migrated) await this.saveData(this.settings);
        return { firstRun: saved == null };
    }

    /** Persist settings. Search and display settings take effect immediately. */
    async saveSettings() {
        await this.saveData(this.settings);
        logger.setLevel(this.settings.logLevel);
    }

    /**
     * Whether applying these changes means embedding every block again: they switch to a
     * different model (or document prefix) whose vectors aren't stored. Vectors from different
     * models can't be compared; the previous model's are kept, so switching back is free.
     */
    needsReembedding(changes: Partial<EmbeddingSettings>): boolean {
        const space = vectorSpaceOf({ ...this.settings, ...changes });
        return this.semanticEnabled && space !== vectorSpaceOf(this.settings) && !this.index.storedSpaces.includes(space);
    }

    /** Apply new embedding settings and restart semantic search with them. */
    async updateEmbeddingSettings(changes: Partial<EmbeddingSettings>): Promise<void> {
        Object.assign(this.settings, changes);
        await this.saveSettings();
        this.createEmbeddingService();
        await this.updateSemanticSearch();
    }

    /** Change the semantic weight; turning semantic search on or off starts or stops it. */
    async setSemanticWeight(weight: number): Promise<void> {
        const wasOn = this.settings.semanticWeight > 0;
        this.settings.semanticWeight = weight;
        await this.saveSettings();
        if (wasOn !== weight > 0) await this.updateSemanticSearch();
    }

    get semanticEnabled() { return this.settings.semanticWeight > 0; }

    private createEmbeddingService(): void {
        const { embeddingEndpoint, embeddingModel, embeddingApiKeySecret, queryPrefix, documentPrefix } = this.settings;
        this.embeddingService = new EmbeddingService({
            endpoint: embeddingEndpoint,
            model: embeddingModel,
            apiKey: embeddingApiKeySecret ? this.app.secretStorage.getSecret(embeddingApiKeySecret) : null,
            prefixes: { query: queryPrefix, document: documentPrefix },
        }, logger);
    }

    // ---------- index ----------

    /** Per-vault, per-device name for the index databases, kept in Obsidian's vault-scoped local storage. */
    private indexNamespace(): string {
        let id = this.app.loadLocalStorage('tezcat-index-id');
        if (typeof id !== 'string') {
            id = crypto.randomUUID();
            this.app.saveLocalStorage('tezcat-index-id', id);
        }
        return `tezcat-${id}`;
    }

    private async startIndex() {
        try {
            // Load first: file events may already be arriving, and the index takes them in order.
            await this.index.load();
            await this.removeLegacyDatabase();
            await this.syncIndex();
            this.indexReady = true;
            this.refreshStatus();
            await this.updateSemanticSearch();
        } catch (error) {
            logger.error('Plugin', 'Failed to load the search index', error);
            new Notice(`Tezcat could not load its index: ${errorMessage(error)}`, 10000);
        }
    }

    /** Versions before 2.0 kept a sql.js database in the plugin folder; nothing reads it now. */
    private async removeLegacyDatabase() {
        const legacy = normalizePath(`${this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`}/tezcat.db`);
        if (await this.app.vault.adapter.exists(legacy)) {
            await this.app.vault.adapter.remove(legacy);
            logger.info('Plugin', 'Removed the database from an earlier version');
        }
    }

    private async syncIndex() {
        const { indexed, removed } = await this.index.sync(this.vault, (done, total) => {
            this.indexProgress = done < total ? { label: 'Indexing', done, total } : null;
            this.refreshStatus();
        });
        logger.info('Plugin', `Index updated: ${indexed} files indexed, ${removed} removed`);
    }

    /** Index new and changed files and embed any blocks that need it. */
    async updateIndex() {
        if (!this.indexReady) return;
        await this.syncIndex();
        void this.embedMissing();
    }

    /** Discard the index (including vectors) and build it again from the vault. */
    async rebuildIndex() {
        if (!this.indexReady || this.rebuilding) return;
        this.rebuilding = true;
        new Notice('Rebuilding the Tezcat index...');
        try {
            this.embedRun?.abort();
            await this.index.clear();
            await this.syncIndex();
            await this.updateSemanticSearch();
            new Notice('Tezcat index rebuilt.');
        } catch (error) {
            logger.error('Plugin', 'Index rebuild failed', error);
            new Notice(`Rebuilding the index failed: ${errorMessage(error)}`, 10000);
        } finally {
            this.rebuilding = false;
            this.refreshStatus();
        }
    }

    get indexStats() { return this.index.stats; }

    /** Model names with stored vectors, the current one first. */
    get storedModels(): string[] {
        return this.index.storedSpaces.map((space) => space.slice(0, space.lastIndexOf('|')));
    }

    /** Each model with stored vectors (current first) and how many vectors it has. */
    async storedVectors(): Promise<{ space: string; model: string; count: number; current: boolean }[]> {
        const counts = await this.index.storedVectorCounts();
        return counts.map(({ space, count }) => ({
            space,
            model: space.slice(0, space.lastIndexOf('|')),
            count,
            current: space === this.index.embeddingSpace,
        }));
    }

    async deleteStoredVectors(space: string) {
        await this.index.deleteStoredVectors(space);
        // The model in use lost its vectors: embed again (keyword search works meanwhile).
        if (space === this.index.embeddingSpace) void this.embedMissing();
        this.refreshStatus();
    }

    /** Model ids the configured server offers. */
    listModels(): Promise<string[]> {
        return this.embeddingService.listModels();
    }

    isOllama(): Promise<boolean> {
        return this.embeddingService.isOllama();
    }

    /** Download models onto the Ollama server one at a time, with a progress notice. */
    async downloadModels(models: string[]): Promise<void> {
        const service = this.embeddingService;
        const notice = new Notice('', 0);
        try {
            for (const [i, model] of models.entries()) {
                notice.setMessage(`Tezcat: downloading ${model} (${i + 1} of ${models.length})…`);
                await service.pullOllamaModel(model);
            }
            notice.setMessage(`Tezcat: downloaded ${models.join(', ')}.`);
            window.setTimeout(() => notice.hide(), 4000);
        } catch (error) {
            notice.setMessage(`Tezcat: download failed: ${errorMessage(error)}`);
            window.setTimeout(() => notice.hide(), 10000);
        }
        // The configured model may have been one of the missing ones.
        if (this.fallback || this.semanticError) await this.updateSemanticSearch({ quiet: true });
    }

    /** Embed a short text with the current settings and report what happened. */
    async testConnection(): Promise<void> {
        const service = this.embeddingService;
        try {
            const { dimensions, ms } = await service.check();
            new Notice(`Connected: ${service.config.model} returns ${dimensions}-dimensional vectors (${ms} ms).`);
            // It works now: stop using the fallback model, or start semantic search if it was down.
            if (this.fallback || this.semanticError) await this.updateSemanticSearch();
        } catch (error) {
            new Notice(`Connection failed: ${errorMessage(error)}`, 10000);
        }
    }

    // ---------- semantic search ----------

    /**
     * Start or stop semantic search to match the settings: check the embedding provider, then
     * embed any blocks that need vectors in the background. Keyword search works throughout.
     * `quiet` skips the notice when the provider is unreachable (used for automatic retries).
     */
    async updateSemanticSearch({ quiet = false }: { quiet?: boolean } = {}) {
        this.embedRun?.abort();
        this.semanticError = null;
        this.search.semanticError = null;
        this.search.embedQuery = null;
        this.activeEmbedding = null;
        this.fallback = null;
        if (!this.semanticEnabled || !this.indexReady) {
            this.refreshStatus();
            return;
        }
        const configured = this.embeddingService;
        let service = configured;
        this.semanticRetryAt = Date.now() + SEMANTIC_RETRY_MS;
        try {
            await configured.check();
        } catch (error) {
            const fallback = await this.workingFallback(error);
            if (configured !== this.embeddingService) return; // settings changed meanwhile
            if (!fallback) {
                if (!quiet) logger.warn('Plugin', 'Embedding provider unavailable', error);
                this.semanticError = errorMessage(error);
                this.refreshStatus();
                if (!quiet) new Notice(`Tezcat: semantic search unavailable, using keyword search.\n${this.semanticError}`, 10000);
                return;
            }
            service = fallback;
            this.fallback = { configured: configured.config.model, using: fallback.config.model };
            if (!quiet) logger.warn('Plugin', `Model ${configured.config.model} not found; using ${fallback.config.model}`);
        }
        if (configured !== this.embeddingService) return; // settings changed while validating
        if (service === configured) await this.rememberWorkingModel();
        await this.index.setEmbeddingSpace(service.space);
        this.activeEmbedding = service;
        this.search.embedQuery = (text) => service.embedQuery(text);
        this.refreshStatus();
        void this.embedMissing();
    }

    /**
     * When the configured model isn't on the server, the last model that worked (if different
     * and still available) — its vectors are kept, so switching to it is instant.
     */
    private async workingFallback(error: unknown): Promise<EmbeddingService | null> {
        const last = this.settings.lastWorkingModel;
        if (!(error instanceof EmbeddingError) || error.reason !== 'model-not-found') return null;
        if (!last || last.model === this.settings.embeddingModel) return null;
        const fallback = new EmbeddingService({
            ...this.embeddingService.config,
            model: last.model,
            prefixes: { query: last.queryPrefix, document: last.documentPrefix },
        }, logger);
        try {
            await fallback.check();
            return fallback;
        } catch {
            return null;
        }
    }

    private async rememberWorkingModel() {
        const { embeddingModel: model, queryPrefix, documentPrefix } = this.settings;
        const last = this.settings.lastWorkingModel;
        if (last?.model === model && last.queryPrefix === queryPrefix && last.documentPrefix === documentPrefix) return;
        this.settings.lastWorkingModel = { model, queryPrefix, documentPrefix };
        await this.saveSettings();
    }

    /** While a fallback is in use: the configured model's name and the one used instead. */
    get modelFallback() { return this.fallback; }

    /**
     * If the embedding provider was unreachable when semantic search started, check it again
     * (quietly, at most every SEMANTIC_RETRY_MS) so semantic search and embedding resume once
     * it's back. Called on searches and edits rather than on a timer, so nothing runs while idle.
     */
    private retrySemanticSearchIfDue() {
        if (!this.semanticEnabled || Date.now() < this.semanticRetryAt) return;
        if (this.semanticError && !this.search.embedQuery) {
            void this.updateSemanticSearch({ quiet: true });
        } else if (this.fallback) {
            // Only switch over once the configured model works, so embedding with the fallback
            // isn't interrupted by every check.
            this.semanticRetryAt = Date.now() + SEMANTIC_RETRY_MS;
            void this.embeddingService.check().then(() => this.updateSemanticSearch({ quiet: true }), () => {});
        }
    }

    /** Embed blocks that have no vector yet. One run at a time; later requests queue a re-run. */
    private async embedMissing() {
        const service = this.activeEmbedding;
        if (!service) return;
        if (this.embedRun) { this.embedAgain = true; return; }
        const run = this.embedRun = new AbortController();
        try {
            do {
                this.embedAgain = false;
                await this.index.embedMissing(this.vault, (texts) => service.embedDocuments(texts), {
                    signal: run.signal,
                    onProgress: (done, total) => {
                        this.indexProgress = done < total ? { label: 'Embedding', done, total } : null;
                        this.refreshStatus();
                    },
                });
            } while (this.embedAgain && !run.signal.aborted);
        } catch (error) {
            if (!(error instanceof EmbeddingSpaceChanged) && !run.signal.aborted) {
                logger.error('Plugin', 'Embedding failed', error);
                this.semanticError = `Embedding failed: ${errorMessage(error)}`;
            }
        } finally {
            if (this.embedRun === run) this.embedRun = null;
            this.indexProgress = null;
            this.refreshStatus();
        }
    }

    // ---------- file events ----------

    private registerIndexingEvents() {
        // Fires after Obsidian has re-parsed a file (including newly created files), with the
        // content and sections from the same parse.
        this.registerEvent(this.app.metadataCache.on('changed', (file, content, cache) => {
            if (file.extension === 'md') this.scheduleIndexing(file, content, cache);
        }));
        this.registerEvent(this.app.vault.on('delete', (file) => {
            if (!isMarkdown(file)) return;
            // A pending re-index would otherwise run after the delete and re-add the note.
            this.cancelPendingIndexing(file.path);
            void this.index.removeFile(file.path);
        }));
        this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
            if (!isMarkdown(file)) return;
            void this.vault.read(file.path).then((content) => this.index.renameFile(oldPath, content));
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
            // Skip files deleted in the meantime; a renamed file is indexed under its new path.
            if (!latest || this.app.vault.getFileByPath(file.path) !== file) return;
            void this.index.indexFile({ file: toSourceFile(file), content: latest.content, cache: latest.cache })
                .then(() => {
                    // The edit needs embedding: a good moment to check whether the provider is back.
                    this.retrySemanticSearchIfDue();
                    return this.embedMissing();
                });
        }, INDEX_DELAY_MS);
        this.pendingIndex.set(key, { timer, content, cache });
    }

    private cancelPendingIndexing(path: string) {
        const pending = this.pendingIndex.get(path);
        if (!pending) return;
        window.clearTimeout(pending.timer);
        this.pendingIndex.delete(path);
    }

    // ---------- search ----------

    async activateView() {
        const { workspace } = this.app;
        let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(VIEW_TYPE)[0] ?? null;
        if (!leaf) {
            // Not open anywhere: open it in the right sidebar
            leaf = workspace.getRightLeaf(false);
            await leaf?.setViewState({ type: VIEW_TYPE, active: true });
        }
        // "Reveal" the leaf in case it is in a collapsed sidebar
        if (leaf) await workspace.revealLeaf(leaf);
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

    /** Debounced: searches once the user pauses, using the cursor context at that moment. */
    private scheduleSearch() {
        if (!this.isSearchPanelVisible() || Date.now() < this.searchSuppressedUntil) return;
        if (this.searchDebounceTimer) window.clearTimeout(this.searchDebounceTimer);
        this.searchDebounceTimer = window.setTimeout(() => {
            this.searchDebounceTimer = null;
            void this.runSearch();
        }, SEARCH_DELAY_MS[this.settings.searchCadence] ?? SEARCH_DELAY_MS.always);
    }

    private async runSearch() {
        if (Date.now() < this.searchSuppressedUntil) return;
        // This search uses keywords if semantic search is down; it may bring it back for the next.
        this.retrySemanticSearchIfDue();
        // Results stay as they are when focus is somewhere other than a note (e.g. the panel).
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view) return;
        const context = cursorContext(view.editor, view.editor.getCursor(), this.settings.contextWindowWords);
        if (!context.trim()) return;

        const seq = ++this.searchSeq;
        try {
            const results = await this.search.search(context, { ...this.searchOptions, excludePath: view.file?.path });
            // A newer search started while this one ran; its results win.
            if (seq === this.searchSeq) this.view?.updateSearchResults(results);
            this.refreshStatus(); // a semantic search may have just failed or recovered
        } catch (error) {
            logger.error('Plugin', 'Search failed', error);
        }
    }

    private get searchOptions() {
        return {
            semanticWeight: this.settings.semanticWeight,
            limit: RESULT_LIMIT,
            filterBoilerplate: this.settings.filterBoilerplate,
            filterCommonPhrasing: this.settings.filterCommonPhrasing,
        };
    }

    suppressSearchFor(milliseconds: number = 2000) {
        this.searchSuppressedUntil = Date.now() + milliseconds;
    }

    private searchFromModal() {
        new SearchQueryModal(this.app, async (query) => {
            const results = await this.search.search(query, { ...this.searchOptions, excludePath: this.app.workspace.getActiveFile()?.path });
            if (results.length === 0) new Notice('No results found');
            else new SearchResultsModal(this.app, query, results).open();
        }).open();
    }

    // ---------- status ----------

    /** One-line summary of what the index is doing, for the status bar and status modal. */
    get statusSummary(): { icon: string; text: string; problem: boolean } {
        if (this.indexProgress) {
            const { label, done, total } = this.indexProgress;
            return { icon: '○', text: `${label} ${done}/${total}`, problem: false };
        }
        if (!this.indexReady) return { icon: '○', text: 'Loading index', problem: false };
        if (this.semanticError) return { icon: '!', text: `Semantic search unavailable: ${this.semanticError}`, problem: true };
        if (this.semanticEnabled && this.search.semanticError) {
            return { icon: '!', text: `Semantic search failing, showing keyword results: ${this.search.semanticError}`, problem: true };
        }
        if (this.fallback) {
            return { icon: '!', text: `Model "${this.fallback.configured}" isn't available on the server; using ${this.fallback.using}`, problem: true };
        }
        if (this.semanticEnabled && !this.search.embedQuery) return { icon: '○', text: 'Starting semantic search', problem: false };
        return { icon: '✓', text: this.semanticEnabled ? 'Keyword and semantic search ready' : 'Keyword search ready', problem: false };
    }

    private refreshStatus() {
        if (!this.statusBarItem) return;
        const { icon, text, problem } = this.statusSummary;
        this.statusBarItem.setText(icon);
        this.statusBarItem.title = `Tezcat: ${text}`;
        this.statusBarItem.toggleClass('tezcat-status-ready', icon === '✓');
        this.statusBarItem.toggleClass('tezcat-status-initializing', icon === '○');
        this.statusBarItem.toggleClass('tezcat-status-error', problem);
    }
}


/** The nearest element (itself or an ancestor) that scrolls vertically. */
function scrollParent(el: HTMLElement | null): HTMLElement | null {
    for (let e = el; e; e = e.parentElement) {
        const { overflowY } = getComputedStyle(e);
        if ((overflowY === 'auto' || overflowY === 'scroll') && e.scrollHeight > e.clientHeight) return e;
    }
    return null;
}

/** Dropdown value for "type a model name". */
const OTHER_MODEL = '\u0000other';

class TezcatSettingTab extends PluginSettingTab {
    plugin: Tezcat;
    /** The server's models (and whether it's Ollama), fetched once per endpoint/key and on refresh. */
    private models: { source: string; ids: string[] | null; error: string | null; ollama: boolean } | null = null;
    /** The user picked "Other…" to type a model name. */
    private typingModel = false;
    /** Whether the "Advanced" section is expanded; kept across redraws. */
    private advancedOpen = false;
    private downloading = false;

    constructor(app: App, plugin: Tezcat) {
        super(app, plugin);
        this.plugin = plugin;
    }

    /** Redraws empty and rebuild the page; keep the user's scroll position instead of jumping to the top. */
    display(): void {
        const scroller = scrollParent(this.containerEl);
        const top = scroller?.scrollTop ?? 0;
        this.render();
        if (scroller) scroller.scrollTop = top;
    }

    private render(): void {
        const {containerEl} = this;

        containerEl.empty();

        new Setting(containerEl).setHeading().setName('Search');

        new Setting(containerEl)
            .setName('Semantic search')
            .setDesc('0 uses keyword search only and needs nothing else. Higher values mix in semantic matches from an embedding provider (configured below); 1 uses semantic matches only.')
            .addSlider(slider => slider
                .setLimits(0, 1, 0.05)
                .setValue(this.plugin.settings.semanticWeight)
                // Deprecated in 1.13, where the value is always shown; needed to show it on older versions.
                .setDynamicTooltip()
                .onChange(async (value) => {
                    const wasOn = this.plugin.semanticEnabled;
                    await this.plugin.setSemanticWeight(value);
                    if (wasOn !== this.plugin.semanticEnabled) this.display(); // show/hide provider settings
                }));

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
                }));

        new Setting(containerEl)
            .setName('Search context window (words)')
            .setDesc('Number of words to extract around your cursor for contextual search (default: 64)')
            .addText(text => text
                .setPlaceholder('64')
                .setValue(this.plugin.settings.contextWindowWords.toString())
                .onChange(async (value) => {
                    this.plugin.settings.contextWindowWords = parseInt(value) || 64;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Filter detected boilerplate')
            .setDesc('Hide passages repeated across 5 or more notes, such as templated headers and bylines, and show any other repeated passage only once.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.filterBoilerplate)
                .onChange(async (value) => {
                    this.plugin.settings.filterBoilerplate = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Filter common phrasing')
            .setDesc('Hide passages made only of words that are common across your vault, such as "he said, at last." Applies once the vault has 20 or more notes.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.filterCommonPhrasing)
                .onChange(async (value) => {
                    this.plugin.settings.filterCommonPhrasing = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Highlight text on open')
            .setDesc('When opening a result, select the matching text in the note')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.highlightBlockOnOpen)
                .onChange(async (value) => {
                    this.plugin.settings.highlightBlockOnOpen = value;
                    await this.plugin.saveSettings();
                }));

        if (this.plugin.semanticEnabled) this.displayEmbeddingSettings(containerEl);

        new Setting(containerEl).setHeading().setName('Maintenance');

        new Setting(containerEl)
            .setName('Rebuild index')
            .setDesc('Discard the index and rebuild it from your vault. Not normally needed; it can fix a damaged index.')
            .addButton(button => button
                .setButtonText('Rebuild index')
                .setWarning()
                .onClick(() => this.plugin.rebuildIndex()));

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
                    this.plugin.settings.logLevel = parseInt(value) as LogLevel;
                    await this.plugin.saveSettings();
                }));
    }

    private displayEmbeddingSettings(containerEl: HTMLElement) {
        const settings = this.plugin.settings;
        new Setting(containerEl).setHeading().setName('Embedding provider');
        containerEl.createEl('p', {
            text: 'Any server with an OpenAI-compatible embeddings API: Ollama (http://localhost:11434/v1), LM Studio (http://localhost:1234/v1), llama.cpp, or a hosted service such as OpenAI (https://api.openai.com/v1).',
            cls: 'setting-item-description'
        });

        // Text settings apply when the field is committed (Enter or leaving it), not per keystroke.
        const textSetting = (name: string, desc: string, placeholder: string, value: string, apply: (value: string) => void) =>
            new Setting(containerEl).setName(name).setDesc(desc).addText(text => {
                text.setPlaceholder(placeholder).setValue(value);
                text.inputEl.addEventListener('change', () => {
                    const next = text.getValue().trim();
                    if (next !== value) apply(next);
                });
            });

        textSetting('Endpoint URL', 'Base URL of the embeddings API, usually ending in /v1.', DEFAULT_SETTINGS.embeddingEndpoint,
            settings.embeddingEndpoint, (embeddingEndpoint) => this.apply({ embeddingEndpoint }));

        const modelSetting = this.displayModelSetting(containerEl, textSetting);
        const fallback = this.plugin.modelFallback;
        if (fallback) {
            const warning = modelSetting.descEl.createDiv({ cls: 'tezcat-setting-warning' });
            setIcon(warning.createSpan({ cls: 'tezcat-setting-warning-icon' }), 'alert-triangle');
            warning.createSpan({
                text: `"${fallback.configured}" isn't available on this server, so Tezcat is using ${fallback.using}, the last model that worked. With Ollama, run: ollama pull ${fallback.configured}`,
            });
        }

        new Setting(containerEl)
            .setName('API key')
            .setDesc('Only needed for hosted services. Kept in Obsidian\'s secret storage, not in the plugin\'s settings file.')
            .addComponent(el => new SecretComponent(this.app, el)
                .setValue(settings.embeddingApiKeySecret)
                .onChange((secret) => this.apply({ embeddingApiKeySecret: secret ?? '' })));

        new Setting(containerEl)
            .setName('Test connection')
            .setDesc('Embed a short text with these settings and report the result.')
            .addButton(button => button
                .setButtonText('Test')
                .onClick(async () => {
                    button.setDisabled(true);
                    await this.plugin.testConnection();
                    button.setDisabled(false);
                }));


        // Rarely needed: prefixes are filled in automatically for known models.
        const advanced = containerEl.createEl('details', { cls: 'tezcat-settings-advanced' });
        advanced.open = this.advancedOpen;
        advanced.addEventListener('toggle', () => { this.advancedOpen = advanced.open; });
        advanced.createEl('summary', { text: 'Advanced' });
        // Prefixes are kept exactly as typed: trailing spaces and newlines are part of them.
        // Short description; the full explanation is a hover tooltip on an info icon by the name.
        // Obsidian shows its own tooltip for an element's aria-label (which screen readers read too).
        const prefixSetting = (name: string, desc: string, help: string, value: string, apply: (value: string) => void) => {
            const setting = new Setting(advanced).setName(name).setDesc(desc).addTextArea(text => {
                text.setValue(value);
                text.inputEl.rows = 2;
                text.inputEl.addEventListener('change', () => {
                    if (text.getValue() !== value) apply(text.getValue());
                });
            });
            const info = setting.nameEl.createSpan({ cls: 'tezcat-setting-info', attr: { tabindex: '0', role: 'img', 'aria-label': help } });
            setIcon(info, 'info');
            return setting;
        };
        prefixSetting('Query prefix', 'Added before your search text.',
            'Instruction some embedding models expect before a search query (here, your text around the cursor). Filled in automatically for known models; change it only if your model needs a different one.',
            settings.queryPrefix, (queryPrefix) => this.apply({ queryPrefix }));
        prefixSetting('Document prefix', 'Added before each passage. Changing it re-embeds.',
            'Instruction some embedding models expect before each passage being indexed. Filled in automatically for known models. Changing it changes every stored vector, so all blocks are embedded again.',
            settings.documentPrefix, (documentPrefix) => this.apply({ documentPrefix }));
        this.displayStoredVectors(advanced);
    }

    /**
     * Models with stored vectors, each with a delete button. Vectors are kept for the current
     * and previous model, so switching back is instant.
     */
    private displayStoredVectors(containerEl: HTMLElement) {
        new Setting(containerEl)
            .setHeading()
            .setName('Stored vectors')
            .setDesc(this.plugin.storedModels.length
                ? 'Kept for the current and previous model, so switching back is instant.'
                : 'None yet.');
        const list = containerEl.createDiv();
        void this.plugin.storedVectors().then((stored) => {
            for (const { space, model, count, current } of stored) {
                new Setting(list)
                    .setName(current ? `${model} (in use)` : model)
                    .setDesc(`${count.toLocaleString()} vectors`)
                    .addExtraButton(button => button
                        .setIcon('trash-2')
                        .setTooltip('Delete these vectors')
                        .onClick(() => new ConfirmModal(this.app, {
                            title: `Delete vectors for ${model}?`,
                            body: current
                                ? `${model} is the model in use, so every block will be embedded again, starting now. Keyword search keeps working meanwhile.`
                                : `Switching back to ${model} later will embed every block again.`,
                            confirm: 'Delete',
                            onConfirm: async () => {
                                await this.plugin.deleteStoredVectors(space);
                                this.display();
                            },
                        }).open()));
            }
        });
    }

    /**
     * Model picker: a dropdown of the server's embedding models, plus "Other…" to type any
     * name (also shown when the current model isn't in the server's list).
     */
    private displayModelSetting(containerEl: HTMLElement, textSetting: (name: string, desc: string, placeholder: string, value: string, apply: (value: string) => void) => Setting): Setting {
        const current = this.plugin.settings.embeddingModel;
        this.loadModels();
        const ids = this.models?.ids ?? null;
        const listed = ids ? embeddingModels(ids).filter((id) => !sameModel(id, current)) : [];
        const currentListed = ids?.some((id) => sameModel(id, current)) ?? false;
        const typing = this.typingModel || (ids !== null && !currentListed);

        // The list only has models already on the server; say how to get another one.
        const howToAdd = /:11434(\/|$)/.test(this.plugin.settings.embeddingEndpoint)
            ? 'To use another model, download it first (e.g. ollama pull mxbai-embed-large), then refresh this list.'
            : 'To use another model, download or enable it on your server first, then refresh this list.';
        const desc = this.models?.error
            ? `Couldn't get the server's model list: ${this.models.error} Choose "Other…" to type a model name.`
            : ids === null
                ? 'Loading the server\'s models…'
                : ids.length === 0
                    ? `The server lists no models. ${howToAdd}`
                    : `Embedding models installed on the server. ${howToAdd}`;

        const setting = new Setting(containerEl)
            .setName('Model')
            .setDesc(desc)
            .addDropdown(dropdown => {
                dropdown.addOption(current, current);
                for (const id of listed) dropdown.addOption(id, id);
                dropdown.addOption(OTHER_MODEL, 'Other…');
                dropdown.setValue(this.typingModel ? OTHER_MODEL : current);
                dropdown.onChange((value) => {
                    this.typingModel = value === OTHER_MODEL;
                    if (this.typingModel) this.display();
                    else this.chooseModel(value);
                });
            })
            .addExtraButton(button => button
                .setIcon('refresh-cw')
                .setTooltip('Refresh the list from the server')
                .onClick(() => this.loadModels(true)));

        if (typing) {
            textSetting('Model name', 'Any model name the server accepts, e.g. nomic-embed-text:v1.5, bge-m3, text-embedding-3-small.',
                DEFAULT_SETTINGS.embeddingModel, current, (model) => this.chooseModel(model));
        }

        // On Ollama, offer to download the recommended models that aren't installed yet.
        const missing = this.models?.ollama && ids
            ? RECOMMENDED_OLLAMA_MODELS.filter((m) => !ids.some((id) => sameModel(id, m.name)))
            : [];
        if (missing.length) {
            new Setting(containerEl)
                .setName('Recommended models')
                .setDesc(`Not installed: ${missing.map((m) => `${m.name} (${m.size})`).join(', ')}. Download ${missing.length === 1 ? 'it' : 'them'} to choose from the recommended embedding models.`)
                .addButton(button => button
                    .setButtonText(this.downloading ? 'Downloading…' : 'Download')
                    .setDisabled(this.downloading)
                    .setCta()
                    .onClick(async () => {
                        this.downloading = true;
                        this.display();
                        await this.plugin.downloadModels(missing.map((m) => m.name));
                        this.downloading = false;
                        this.loadModels(true);
                    }));
        }
        return setting;
    }

    /** Fetch the server's model list, once per endpoint and key unless forced. */
    private loadModels(force = false) {
        const { embeddingEndpoint, embeddingApiKeySecret } = this.plugin.settings;
        const source = `${embeddingEndpoint}|${embeddingApiKeySecret}`;
        if (!force && this.models?.source === source) return;
        const entry = this.models = { source, ids: null as string[] | null, error: null as string | null, ollama: false as boolean };
        Promise.all([
            this.plugin.listModels().then(
                (ids) => { entry.ids = ids; },
                (error) => { entry.ids = []; entry.error = errorMessage(error); },
            ),
            this.plugin.isOllama().then((ollama) => { entry.ollama = ollama; }),
        ]).finally(() => {
            if (this.models === entry) this.display();
        });
        if (force) this.display();
    }

    private chooseModel(embeddingModel: string) {
        const settings = this.plugin.settings;
        // The name field stays visible on its own if the chosen model isn't in the server's list.
        this.typingModel = false;
        if (!embeddingModel || embeddingModel === settings.embeddingModel) return this.display();
        // Follow the new model's recommended prefixes, unless the user customised them.
        const previous = suggestPrefixes(settings.embeddingModel);
        const customised = settings.queryPrefix !== previous.query || settings.documentPrefix !== previous.document;
        const next = suggestPrefixes(embeddingModel);
        this.apply({ embeddingModel, ...(customised ? {} : { queryPrefix: next.query, documentPrefix: next.document }) });
    }

    /** Apply embedding settings now, asking first if every block would need embedding again. */
    private apply(changes: Partial<EmbeddingSettings>) {
        const run = async () => {
            // updateEmbeddingSettings applies the values before its first await, so the redraw
            // shows them while the provider is checked and blocks are embedded.
            const done = this.plugin.updateEmbeddingSettings(changes);
            this.display();
            await done;
            this.display(); // show the outcome of checking the new settings (e.g. a model fallback)
        };
        if (this.plugin.needsReembedding(changes)) {
            new ReembedConfirmModal(this.app, run, () => this.display()).open();
        } else {
            void run();
        }
    }
}

/** A yes/no confirmation for a destructive action. */
class ConfirmModal extends Modal {
    constructor(app: App, private opts: { title: string; body: string; confirm: string; onConfirm: () => void }) {
        super(app);
    }

    onOpen() {
        const { contentEl, opts } = this;
        new Setting(contentEl).setHeading().setName(opts.title);
        contentEl.createEl('p', { text: opts.body });
        new Setting(contentEl)
            .addButton(button => button
                .setButtonText(opts.confirm)
                .setWarning()
                .onClick(() => { this.close(); opts.onConfirm(); }))
            .addButton(button => button
                .setButtonText('Cancel')
                .onClick(() => this.close()));
    }

    onClose() {
        this.contentEl.empty();
    }
}

class ReembedConfirmModal extends Modal {
    private confirmed = false;

    constructor(app: App, private onConfirm: () => void, private onCancel: () => void) {
        super(app);
    }

    onOpen() {
        const { contentEl } = this;
        new Setting(contentEl).setHeading().setName('Re-embed all notes?');
        contentEl.createEl('p', {
            text: 'Vectors from different models can\'t be compared, so every block will be embedded with the new model. This may take a while for a large vault; keyword search keeps working meanwhile. Vectors for the previous model are kept, so switching back is instant.'
        });
        new Setting(contentEl)
            .addButton(button => button
                .setButtonText('Switch and re-embed')
                .setCta()
                .onClick(() => { this.confirmed = true; this.close(); this.onConfirm(); }))
            .addButton(button => button
                .setButtonText('Cancel')
                .onClick(() => this.close()));
    }

    onClose() {
        this.contentEl.empty();
        if (!this.confirmed) this.onCancel(); // also on Escape: put the field back
    }
}

class SearchQueryModal extends Modal {
    constructor(app: App, private onSubmit: (query: string) => void) {
        super(app);
    }

    onOpen() {
        const { contentEl } = this;
        new Setting(contentEl).setHeading().setName('Search notes');

        const inputContainer = contentEl.createDiv('tezcat-modal-input-container');
        const input = inputContainer.createEl('input', {
            type: 'text',
            placeholder: 'Enter your search query...',
            cls: 'tezcat-input'
        });
        const submit = () => {
            const query = input.value.trim();
            if (!query) return;
            this.close();
            this.onSubmit(query);
        };
        new Setting(contentEl)
            .addButton(button => button.setButtonText('Search').setCta().onClick(submit))
            .addButton(button => button.setButtonText('Cancel').onClick(() => this.close()));

        input.focus();
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') submit();
        });
    }

    onClose() {
        this.contentEl.empty();
    }
}

class StatusModal extends Modal {
    constructor(app: App, private plugin: Tezcat) {
        super(app);
    }

    onOpen() {
        const { contentEl, plugin } = this;
        new Setting(contentEl).setHeading().setName('Tezcat status');

        const { text, problem } = plugin.statusSummary;
        const summary = contentEl.createDiv('tezcat-overall-status');
        summary.addClass(problem ? 'setup-required' : 'system-ready');
        summary.createEl('strong', { text });

        const { files, blocks, vectors } = plugin.indexStats;
        const details = contentEl.createDiv('system-status-details');
        const item = (title: string, value: string) => {
            const el = details.createDiv('tezcat-validation-item');
            el.createEl('strong', { text: title });
            el.createDiv({ cls: 'tezcat-validation-message', text: value });
        };
        item('Index', `${files} notes, ${blocks} blocks`);
        const [model, ...others] = plugin.storedModels;
        item('Semantic search', plugin.semanticEnabled
            ? `${vectors} block vectors from ${model ?? plugin.settings.embeddingModel} (weight ${plugin.settings.semanticWeight})`
            : 'Off: keyword search only');
        if (others.length) item('Also stored', `Vectors for ${others.join(', ')}`);

        new Setting(contentEl)
            .addButton(button => button.setButtonText('Update index').onClick(() => { this.close(); void plugin.updateIndex(); }))
            .addButton(button => button.setButtonText('Close').setCta().onClick(() => this.close()));
    }

    onClose() {
        this.contentEl.empty();
    }
}

class SearchResultsModal extends Modal {
    /** Owns what the rendered passages create; unloaded when the modal closes. */
    private renderScope = new Component();

    constructor(app: App, private query: string, private results: SearchResult[]) {
        super(app);
    }

    onOpen() {
        const { contentEl } = this;
        this.renderScope.load();
        new Setting(contentEl).setHeading().setName(`Search results for: "${this.query}"`);
        contentEl.createEl('p', { text: `Found ${this.results.length} matches` });

        const resultsContainer = contentEl.createDiv('tezcat-search-results');
        for (const result of this.results) {
            const resultEl = resultsContainer.createDiv('tezcat-search-result');
            const headerEl = resultEl.createDiv('tezcat-search-result-header');
            headerEl.createEl('strong', { text: result.noteName });
            resultEl.createDiv({ cls: 'tezcat-search-result-path', text: result.path });
            renderResultText(this.app, resultEl, result, this.renderScope);
            resultEl.onclick = () => {
                this.close();
                const file = this.app.vault.getFileByPath(result.path);
                if (file) void this.app.workspace.getLeaf(false).openFile(file, { eState: { line: result.line } });
            };
        }

        new Setting(contentEl).addButton(button => button.setButtonText('Close').onClick(() => this.close()));
    }

    onClose() {
        this.renderScope.unload();
        this.contentEl.empty();
    }
}
