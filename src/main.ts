import { App, CachedMetadata, Component, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting, TAbstractFile, TFile, WorkspaceLeaf, normalizePath } from 'obsidian';
import { EditorView } from '@codemirror/view';
import { TezcatView, VIEW_TYPE, renderResultText } from './search_view';
import { EmbeddingService, OllamaEmbeddingProvider, OpenAIEmbeddingProvider, OllamaModelManager } from './embedding_service';
import { EmbeddingSpaceChanged, IndexRepository, type SourceFile, type VaultSource } from './index_repository';
import { SearchService, type SearchResult } from './search';
import { logger, LogLevel } from './logger';
import { cursorContext } from './context';


type EmbeddingProviderType = 'openai' | 'ollama';
type SearchCadence = 'always' | 'sometimes' | 'occasionally';

/** Wait this long after a file's last change before re-indexing it (Obsidian saves while you type). */
const INDEX_DELAY_MS = 2000;

/** Debounce before searching, per cadence setting. */
const SEARCH_DELAY_MS: Record<SearchCadence, number> = { always: 500, sometimes: 2000, occasionally: 8000 };

const RESULT_LIMIT = 10;

/** While the embedding provider is unreachable, check it again at most this often (on search). */
const SEMANTIC_RETRY_MS = 30_000;

/** Models offered per provider; the first is the default when switching provider. */
const EMBEDDING_MODELS: Record<EmbeddingProviderType, [id: string, label: string][]> = {
    ollama: [['nomic-embed-text:v1.5', 'Nomic Embed Text v1.5 (768d)'], ['bge-m3', 'BGE M3 (1024d)']],
    openai: [['text-embedding-3-small', 'Text Embedding 3 Small (1536d)'], ['text-embedding-3-large', 'Text Embedding 3 Large (3072d)']],
};

interface TezcatSettings {
    /** 0 = keyword search only; above 0 mixes in semantic matches; 1 = semantic only. */
    semanticWeight: number;
    embeddingProvider: EmbeddingProviderType;
    embeddingModel: string;
    openaiApiKey: string;
    ollamaBaseUrl: string;
    contextWindowWords: number;
    searchCadence: SearchCadence;
    logLevel: LogLevel;
    highlightBlockOnOpen: boolean;
    filterBoilerplate: boolean;
    filterCommonPhrasing: boolean;
}

const DEFAULT_SETTINGS: TezcatSettings = {
    semanticWeight: 0,
    embeddingProvider: 'ollama',
    embeddingModel: 'nomic-embed-text:v1.5',
    openaiApiKey: '',
    ollamaBaseUrl: 'http://localhost:11434',
    contextWindowWords: 64, // Smaller context window for more focused search
    searchCadence: 'always',
    logLevel: LogLevel.ERROR,
    highlightBlockOnOpen: true,
    filterBoilerplate: true,
    filterCommonPhrasing: true,
}

type EmbeddingSettings = Pick<TezcatSettings, 'embeddingProvider' | 'embeddingModel' | 'openaiApiKey' | 'ollamaBaseUrl'>;

const pickEmbeddingSettings = (s: TezcatSettings): EmbeddingSettings => ({
    embeddingProvider: s.embeddingProvider,
    embeddingModel: s.embeddingModel,
    openaiApiKey: s.openaiApiKey,
    ollamaBaseUrl: s.ollamaBaseUrl,
});

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
        this.settings = Object.assign({}, DEFAULT_SETTINGS, saved);
        return { firstRun: saved == null };
    }

    /** Persist settings. Search and display settings take effect immediately. */
    async saveSettings() {
        await this.saveData(this.settings);
        logger.setLevel(this.settings.logLevel);
    }

    /** Vectors from a different provider or model can't be compared, so every block is re-embedded. */
    changesEmbeddingModel(changes: EmbeddingSettings): boolean {
        return changes.embeddingProvider !== this.settings.embeddingProvider
            || changes.embeddingModel !== this.settings.embeddingModel;
    }

    /** Save new embedding settings and restart semantic search with them. */
    async updateEmbeddingSettings(changes: EmbeddingSettings): Promise<void> {
        Object.assign(this.settings, changes);
        await this.saveSettings();
        this.createEmbeddingService();
        new Notice('Settings saved.');
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
        if (this.settings.embeddingProvider === 'ollama') {
            const modelManager = new OllamaModelManager(this.settings.ollamaBaseUrl, logger);
            const provider = new OllamaEmbeddingProvider(this.settings.ollamaBaseUrl, this.settings.embeddingModel, logger);
            provider.setModelManager(modelManager);
            this.embeddingService = new EmbeddingService(provider, logger);
        } else {
            this.embeddingService = new EmbeddingService(
                new OpenAIEmbeddingProvider(this.settings.openaiApiKey, this.settings.embeddingModel, 'https://api.openai.com', logger),
                logger
            );
        }
    }

    /** Identifies the vector space of the configured model. */
    private get embeddingSpace() {
        return `${this.settings.embeddingProvider}:${this.settings.embeddingModel}`;
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
        if (!this.semanticEnabled || !this.indexReady) {
            this.refreshStatus();
            return;
        }
        const service = this.embeddingService;
        this.semanticRetryAt = Date.now() + SEMANTIC_RETRY_MS;
        try {
            await service.embeddingProvider.validate();
        } catch (error) {
            if (!quiet) logger.warn('Plugin', 'Embedding provider unavailable', error);
            this.semanticError = errorMessage(error);
            this.refreshStatus();
            if (!quiet) new Notice(`Tezcat: semantic search unavailable, using keyword search.\n${this.semanticError}`, 10000);
            return;
        }
        if (service !== this.embeddingService) return; // settings changed while validating
        await this.index.setEmbeddingSpace(this.embeddingSpace);
        this.search.embedQuery = (text) => service.embedText(text);
        void this.embedMissing();
    }

    /** Embed blocks that have no vector yet. One run at a time; later requests queue a re-run. */
    private async embedMissing() {
        if (!this.search.embedQuery) return;
        if (this.embedRun) { this.embedAgain = true; return; }
        const run = this.embedRun = new AbortController();
        const service = this.embeddingService;
        try {
            do {
                this.embedAgain = false;
                await this.index.embedMissing(this.vault, (texts) => service.embedTexts(texts), {
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
                .then(() => this.embedMissing());
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
        // The provider was unreachable when semantic search started: check again now and then,
        // so it resumes on its own once the provider is back. This search uses keywords meanwhile.
        if (this.semanticEnabled && this.semanticError && !this.search.embedQuery && Date.now() >= this.semanticRetryAt) {
            void this.updateSemanticSearch({ quiet: true });
        }
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

        if (this.plugin.semanticEnabled) this.displayEmbeddingSettings(containerEl, markDirty);

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

    private displayEmbeddingSettings(containerEl: HTMLElement, markDirty: () => void) {
        new Setting(containerEl).setHeading().setName('Embedding provider');
        containerEl.createEl('p', {
            text: 'Changing the provider or model re-embeds every block.',
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
    }

    private saveEmbeddingSettings() {
        const changes = { ...this.pending };
        const apply = async () => {
            // updateEmbeddingSettings applies the new values before its first await, so the
            // redraw shows them while the provider is checked and blocks are re-embedded.
            const done = this.plugin.updateEmbeddingSettings(changes);
            this.dirty = false;
            this.display();
            await done;
        };
        if (this.plugin.changesEmbeddingModel(changes)) {
            new ReembedConfirmModal(this.app, apply).open();
        } else {
            void apply();
        }
    }
}

class ReembedConfirmModal extends Modal {
    constructor(app: App, private onConfirm: () => void) {
        super(app);
    }

    onOpen() {
        const { contentEl } = this;
        new Setting(contentEl).setHeading().setName('Re-embed all notes?');
        contentEl.createEl('p', {
            text: 'Vectors from different models can\'t be compared, so every block will be embedded again with the new model. This may take a while for a large vault; keyword search keeps working meanwhile.'
        });
        new Setting(contentEl)
            .addButton(button => button
                .setButtonText('Save and re-embed')
                .setCta()
                .onClick(() => { this.close(); this.onConfirm(); }))
            .addButton(button => button
                .setButtonText('Cancel')
                .onClick(() => this.close()));
    }

    onClose() {
        this.contentEl.empty();
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
        item('Semantic search', plugin.semanticEnabled
            ? `${vectors} block vectors (weight ${plugin.settings.semanticWeight})`
            : 'Off: keyword search only');

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
