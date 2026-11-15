import MiniSearch from 'minisearch';
import { clear, createStore, del, delMany, entries, get, promisifyRequest, set, setMany, type UseStore } from 'idb-keyval';
import type { CachedMetadata } from 'obsidian';
import { extractBlocks, hashText, type Block, type BlockRecord } from './blocks';
import type { Logger } from './logger';
import { contentTerms, processTerm, queryTerms, tokenize } from './text';
import { quantize, type QVec } from './vectors';

// ---------- vault access (an adapter over Obsidian's API lives in main.ts) ----------

export interface SourceFile {
	path: string;
	basename: string;
	mtime: number;
	size: number;
}

export interface FileContent {
	file: SourceFile;
	content: string;
	/** Obsidian's parsed sections for exactly this content; null if not parsed yet. */
	cache: CachedMetadata | null;
}

export interface VaultSource {
	listFiles(): SourceFile[];
	read(path: string): Promise<FileContent | null>;
}

// ---------- stored records ----------

/** What the index remembers about a file. Persisted per path. */
export interface FileRecord {
	path: string;
	mtime: number;
	size: number;
	/**
	 * Unique, increasing stamp for this version of the record (a timestamp, bumped if needed so
	 * no two records share one). The saved keyword index lists the stamp it holds per file.
	 */
	indexedAt: number;
	blocks: BlockRecord[];
	/** Distinct normalised content words across the note's blocks, for note frequencies. */
	terms: string[];
}

export interface IndexedBlock {
	id: string;
	path: string;
	block: BlockRecord;
}

export interface Hit {
	id: string;
	score: number;
}

export interface IndexStats {
	files: number;
	blocks: number;
	vectors: number;
}

/** Bump when the stored format changes; older data is discarded and rebuilt. */
const SCHEMA_VERSION = 3;

/** Vectors are kept for this many embedding models: the current one and the one before. */
const KEEP_MODELS = 2;

interface Meta {
	schemaVersion: number;
	/** The embedding model (vector space) in use; only its vectors are loaded and searched. */
	embeddingSpace: string | null;
	/** Models with stored vectors, most recent first (at most KEEP_MODELS). */
	storedSpaces: string[];
}

/** A stored vector. Keyed `${model id}|${block hash}` so one model's vectors form a key range. */
interface StoredVector extends QVec {
	hash: string;
}

const modelId = (space: string) => hashText(space);
const vectorKey = (space: string, hash: string) => `${modelId(space)}|${hash}`;
const modelRange = (space: string) => IDBKeyRange.bound(`${modelId(space)}|`, `${modelId(space)}|\uffff`);

/** Which version of a file the keyword index holds, and how many blocks it indexed for it. */
interface KeywordEntry {
	stamp: number;
	count: number;
}

interface KeywordSnapshot {
	json: string;
	entries: Record<string, KeywordEntry>;
}

interface KeywordDoc {
	id: string;
	path: string;
	title: string;
	text: string;
}

const KEYWORD_OPTIONS = {
	fields: ['title', 'text'],
	storeFields: ['path'],
	tokenize: (text: string) => tokenize(text),
	processTerm,
	// BM25+ ranking (MiniSearch's default). Title matches count for a little more.
	searchOptions: { boost: { title: 1.5 }, combineWith: 'OR' as const },
};

const KEYWORD_SAVE_DELAY_MS = 10_000;
const SYNC_YIELD_EVERY = 25;

/** Stable id for a block: its file path and position within the file. */
export const blockId = (path: string, index: number) => `${path}\u0000${index}`;

const yieldToUi = () => new Promise<void>((resolve) => window.setTimeout(resolve, 0));

export class EmbeddingSpaceChanged extends Error {}

/**
 * The search index: indexed files and their blocks, a BM25 keyword index over the blocks,
 * and block vectors keyed by content hash (so unchanged blocks keep their vectors across
 * edits, moves and renames).
 *
 * Everything lives in memory and is persisted per device in IndexedDB, in Obsidian's app
 * data rather than the vault, so sync tools never copy it. It is derived from the vault and
 * can be rebuilt at any time. All changes run one at a time.
 */
export class IndexRepository {
	private files = new Map<string, FileRecord>();
	private keyword = new MiniSearch<KeywordDoc>(KEYWORD_OPTIONS);
	private keywordEntries = new Map<string, KeywordEntry>();
	private keywordDirty = false;
	private keywordSaveTimer: number | null = null;
	/** Files whose saved keyword entries may be out of date (see load). */
	private keywordStale = new Set<string>();
	private vectors = new Map<string, QVec>();
	/** How many notes contain each normalised term, and each block signature. */
	private termNotes = new Map<string, number>();
	private signatureNotes = new Map<string, number>();
	private lastStamp = 0;
	private meta: Meta = { schemaVersion: SCHEMA_VERSION, embeddingSpace: null, storedSpaces: [] };
	private chain: Promise<unknown> = Promise.resolve();
	private readonly db: { meta: UseStore; files: UseStore; vectors: UseStore };

	/** @param namespace unique per vault; databases are named `${namespace}-*`. */
	constructor(namespace: string, private log: Logger) {
		// idb-keyval holds one object store per database, so use one database per kind.
		this.db = {
			meta: createStore(`${namespace}-meta`, 'kv'),
			files: createStore(`${namespace}-files`, 'kv'),
			vectors: createStore(`${namespace}-vectors`, 'kv'),
		};
	}

	// ---------- lifecycle ----------

	/** Load the saved index. Call once, before anything else. */
	load(): Promise<void> {
		return this.serial(async () => {
			const meta = await get<Meta>('meta', this.db.meta);
			if (meta?.schemaVersion !== SCHEMA_VERSION) {
				if (meta) this.log.info('Index', 'Saved index uses an older format; rebuilding');
				await this.clearStores();
				await set('meta', this.meta, this.db.meta);
				return;
			}
			this.meta = meta;

			for (const [, rec] of await entries<string, FileRecord>(this.db.files)) {
				this.files.set(rec.path, rec);
				this.countNote(rec, 1);
				this.lastStamp = Math.max(this.lastStamp, rec.indexedAt);
			}
			if (meta.embeddingSpace) await this.loadVectors(meta.embeddingSpace);

			// File records are written as each file is indexed; the keyword index is saved in
			// the background. Files whose record doesn't match the version in the saved keyword
			// index (e.g. changed just before a crash) are re-indexed by the next sync.
			const snap = await get<KeywordSnapshot>('keyword', this.db.meta);
			if (snap) {
				try {
					this.keyword = MiniSearch.loadJSON<KeywordDoc>(snap.json, KEYWORD_OPTIONS);
					this.keywordEntries = new Map(Object.entries(snap.entries));
				} catch (e) {
					this.log.warn('Index', 'Saved keyword index unreadable; rebuilding it', e);
					this.keyword = new MiniSearch<KeywordDoc>(KEYWORD_OPTIONS);
					this.keywordEntries.clear();
				}
			}
			for (const path of [...this.keywordEntries.keys()]) {
				if (!this.files.has(path)) this.removeKeywordEntries(path);
			}
			for (const rec of this.files.values()) {
				if (this.keywordEntries.get(rec.path)?.stamp !== rec.indexedAt) this.keywordStale.add(rec.path);
			}
			this.log.info('Index', `Loaded ${this.files.size} files, ${this.keyword.documentCount} keyword entries, ${this.vectors.size} vectors`);
		});
	}

	/**
	 * Bring the index up to date with the vault: index new and changed files (by mtime and
	 * size), drop deleted ones, and drop vectors no block uses any more.
	 */
	sync(source: VaultSource, onProgress?: (done: number, total: number) => void): Promise<{ indexed: number; removed: number }> {
		return this.serial(async () => {
			const files = source.listFiles();
			const present = new Set(files.map((f) => f.path));
			let removed = 0;
			for (const path of [...this.files.keys()]) {
				if (!present.has(path)) { await this.removeNow(path); removed++; }
			}
			const todo = files.filter((f) => {
				const rec = this.files.get(f.path);
				return !rec || rec.mtime !== f.mtime || rec.size !== f.size || this.keywordStale.has(f.path);
			});
			for (let i = 0; i < todo.length; i++) {
				onProgress?.(i, todo.length);
				const content = await source.read(todo[i].path);
				if (content) await this.indexNow(content);
				else await this.removeNow(todo[i].path);
				if (i % SYNC_YIELD_EVERY === SYNC_YIELD_EVERY - 1) await yieldToUi();
			}
			onProgress?.(todo.length, todo.length);
			this.keywordStale.clear();
			await this.dropUnusedVectors();
			await this.saveKeywordIndex();
			return { indexed: todo.length, removed };
		});
	}

	/** Discard the whole index, including vectors for every model. Follow with `sync` to rebuild. */
	clear(): Promise<void> {
		return this.serial(async () => {
			this.files.clear();
			this.termNotes.clear();
			this.signatureNotes.clear();
			this.keyword = new MiniSearch<KeywordDoc>(KEYWORD_OPTIONS);
			this.keywordEntries.clear();
			this.keywordStale.clear();
			this.keywordDirty = false;
			this.vectors.clear();
			await this.clearStores();
			const current = this.meta.embeddingSpace;
			this.meta = { ...this.meta, storedSpaces: current ? [current] : [] };
			await set('meta', this.meta, this.db.meta);
		});
	}

	/** Save the keyword index if it changed. Call on unload. */
	flush(): Promise<void> {
		return this.serial(() => this.saveKeywordIndex());
	}

	// ---------- file changes ----------

	/** Index (or re-index) one file from content and the sections parsed from it. */
	indexFile(content: FileContent): Promise<void> {
		return this.serial(async () => {
			await this.indexNow(content);
			this.scheduleKeywordSave();
		});
	}

	removeFile(path: string): Promise<void> {
		return this.serial(async () => {
			await this.removeNow(path);
			this.scheduleKeywordSave();
		});
	}

	/** Move a file's entries to its new path. Vectors are keyed by content, so none are lost. */
	renameFile(oldPath: string, content: FileContent | null): Promise<void> {
		return this.serial(async () => {
			await this.removeNow(oldPath);
			if (content) await this.indexNow(content);
			this.scheduleKeywordSave();
		});
	}

	// ---------- reads ----------

	get stats(): IndexStats {
		let blocks = 0;
		for (const f of this.files.values()) blocks += f.blocks.length;
		return { files: this.files.size, blocks, vectors: this.vectors.size };
	}

	getBlock(id: string): IndexedBlock | null {
		const sep = id.lastIndexOf('\u0000');
		const path = id.slice(0, sep);
		const block = this.files.get(path)?.blocks[Number(id.slice(sep + 1))];
		return block ? { id, path, block } : null;
	}

	get noteCount(): number { return this.files.size; }

	/** Number of notes containing a block with this signature (see text.signature). */
	notesWithSignature(sig: string): number {
		return this.signatureNotes.get(sig) ?? 0;
	}

	/**
	 * How distinctive a piece of text is within this vault: the sum, over its distinct
	 * normalised content words, of log(notes / notes containing the word), i.e. their IDF
	 * across notes. Near 0 when every word is in nearly every note (templated headers,
	 * filler); tens for ordinary prose.
	 */
	informativeness(text: string): number {
		const notes = this.files.size;
		let total = 0;
		for (const term of contentTerms(text)) total += Math.log(notes / Math.max(1, this.termNotes.get(term) ?? 0));
		return total;
	}

	/** BM25-ranked blocks for free text (e.g. the words around the cursor). */
	keywordSearch(text: string, { limit, excludePath }: { limit: number; excludePath?: string }): Hit[] {
		const terms = queryTerms(text);
		if (terms.length === 0) return [];
		return this.keyword
			.search(terms.join(' '), { filter: excludePath ? (r) => r.path !== excludePath : undefined })
			.slice(0, limit)
			.map((r) => ({ id: r.id as string, score: r.score }));
	}

	/** Every indexed block that has a vector in the current embedding space. */
	*vectorEntries(): Generator<{ id: string; path: string; vector: QVec }> {
		for (const f of this.files.values()) {
			for (let i = 0; i < f.blocks.length; i++) {
				const vector = this.vectors.get(f.blocks[i].hash);
				if (vector) yield { id: blockId(f.path, i), path: f.path, vector };
			}
		}
	}

	// ---------- vectors ----------

	get embeddingSpace(): string | null { return this.meta.embeddingSpace; }

	/** Models with stored vectors, most recent (the current one) first. */
	get storedSpaces(): readonly string[] { return this.meta.storedSpaces; }

	/**
	 * Switch the embedding model vectors come from and are searched against. Vectors from
	 * different models can't be compared, so only the new model's vectors are used. Vectors
	 * are kept for the previous model too, so switching back needs no re-embedding; older
	 * models' vectors are deleted.
	 */
	setEmbeddingSpace(space: string): Promise<void> {
		return this.serial(async () => {
			if (space === this.meta.embeddingSpace) return;
			const storedSpaces = [space, ...this.meta.storedSpaces.filter((s) => s !== space)];
			for (const old of storedSpaces.slice(KEEP_MODELS)) await this.deleteVectorsOf(old);
			this.meta = { ...this.meta, embeddingSpace: space, storedSpaces: storedSpaces.slice(0, KEEP_MODELS) };
			await set('meta', this.meta, this.db.meta);
			await this.loadVectors(space);
			// Blocks may have changed or gone while this model wasn't in use.
			await this.dropUnusedVectors();
			this.log.info('Index', `Embedding model is now ${space}; ${this.vectors.size} stored vectors`);
		});
	}

	/** How many vectors are stored for each model with stored vectors, current model first. */
	storedVectorCounts(): Promise<{ space: string; count: number }[]> {
		return this.serial(async () => Promise.all(this.meta.storedSpaces.map(async (space) => ({
			space,
			count: await this.db.vectors('readonly', (store) => promisifyRequest(store.count(modelRange(space)))),
		}))));
	}

	/**
	 * Delete one model's stored vectors. For the current model, blocks then need embedding
	 * again; for any other, switching back to it does.
	 */
	deleteStoredVectors(space: string): Promise<void> {
		return this.serial(async () => {
			await this.deleteVectorsOf(space);
			if (space === this.meta.embeddingSpace) {
				this.vectors.clear();
			} else {
				this.meta = { ...this.meta, storedSpaces: this.meta.storedSpaces.filter((s) => s !== space) };
				await set('meta', this.meta, this.db.meta);
			}
		});
	}

	/** Number of distinct blocks that still need a vector. */
	countMissingVectors(): number {
		return this.missingHashes().size;
	}

	/**
	 * Embed every block that has no vector yet, in batches, reading text from the vault.
	 * Stops early if `signal` is aborted; throws EmbeddingSpaceChanged if the embedding model
	 * changes mid-way, so vectors from the old model are never stored under the new one.
	 * Returns the number of blocks embedded.
	 */
	async embedMissing(
		source: VaultSource,
		embed: (texts: string[]) => Promise<ArrayLike<number>[]>,
		opts: { batchSize?: number; signal?: AbortSignal; onProgress?: (done: number, total: number) => void } = {},
	): Promise<number> {
		const { batchSize = 32, signal, onProgress } = opts;
		const space = this.meta.embeddingSpace;
		if (!space) return 0; // no embedding model chosen yet
		const missing = this.missingHashes();
		const total = missing.size;
		let done = 0;
		let batch: Block[] = [];

		const flushBatch = async () => {
			const raw = await embed(batch.map((b) => b.text));
			if (raw.length !== batch.length) throw new Error(`Expected ${batch.length} embeddings, got ${raw.length}`);
			await this.serial(async () => {
				if (this.meta.embeddingSpace !== space) throw new EmbeddingSpaceChanged();
				const vectors = batch.map((b, i) => ({ hash: b.hash, ...quantize(raw[i]) }));
				for (const v of vectors) this.vectors.set(v.hash, v);
				await setMany(vectors.map((v): [string, StoredVector] => [vectorKey(space, v.hash), v]), this.db.vectors);
			});
			done += batch.length;
			batch = [];
			onProgress?.(done, total);
		};

		onProgress?.(0, total);
		for (const [path, rec] of [...this.files]) {
			if (signal?.aborted) return done;
			if (!rec.blocks.some((b) => missing.has(b.hash))) continue;
			const content = await source.read(path);
			if (!content) continue;
			// Blocks whose file changed since indexing have new hashes; they're picked up once
			// the change is indexed.
			for (const block of extractBlocks(content.content, content.cache)) {
				if (!missing.delete(block.hash)) continue; // also skips identical blocks already queued
				batch.push(block);
				if (batch.length >= batchSize) {
					if (signal?.aborted) return done;
					await flushBatch();
				}
			}
		}
		if (batch.length && !signal?.aborted) await flushBatch();
		return done;
	}

	// ---------- internals (call only inside `serial`) ----------

	private serial<T>(task: () => Promise<T>): Promise<T> {
		const run = this.chain.then(task, task);
		this.chain = run.catch(() => {});
		return run;
	}

	private async indexNow({ file, content, cache }: FileContent) {
		// Not parsed yet: Obsidian reports a change once it is, which indexes the file then.
		if (!cache) return;
		const blocks = extractBlocks(content, cache);
		this.lastStamp = Math.max(Date.now(), this.lastStamp + 1);
		const terms = new Set<string>();
		for (const b of blocks) for (const t of contentTerms(b.text)) terms.add(t);
		const rec: FileRecord = {
			path: file.path,
			mtime: file.mtime,
			size: file.size,
			indexedAt: this.lastStamp,
			blocks: blocks.map(({ text: _text, ...block }) => block),
			terms: [...terms],
		};
		const previous = this.files.get(file.path);
		if (previous) this.countNote(previous, -1);
		this.files.set(file.path, rec);
		this.countNote(rec, 1);
		this.removeKeywordEntries(file.path);
		this.keyword.addAll(blocks.map((b, i) => ({ id: blockId(file.path, i), path: file.path, title: file.basename, text: b.text })));
		this.keywordEntries.set(file.path, { stamp: rec.indexedAt, count: blocks.length });
		this.keywordDirty = true;
		await set(file.path, rec, this.db.files);
	}

	private async removeNow(path: string) {
		this.removeKeywordEntries(path);
		const rec = this.files.get(path);
		if (!rec) return;
		this.countNote(rec, -1);
		this.files.delete(path);
		await del(path, this.db.files);
	}

	/** Add (+1) or remove (-1) a note's contribution to the term and signature note counts. */
	private countNote(rec: FileRecord, delta: 1 | -1) {
		const bump = (counts: Map<string, number>, key: string) => {
			const n = (counts.get(key) ?? 0) + delta;
			if (n > 0) counts.set(key, n);
			else counts.delete(key);
		};
		for (const term of rec.terms) bump(this.termNotes, term);
		for (const sig of new Set(rec.blocks.map((b) => b.sig))) bump(this.signatureNotes, sig);
	}

	private removeKeywordEntries(path: string) {
		const count = this.keywordEntries.get(path)?.count ?? 0;
		for (let i = 0; i < count; i++) {
			const id = blockId(path, i);
			if (this.keyword.has(id)) this.keyword.discard(id);
		}
		if (this.keywordEntries.delete(path)) this.keywordDirty = true;
	}

	private missingHashes(): Set<string> {
		const missing = new Set<string>();
		for (const f of this.files.values()) {
			for (const b of f.blocks) if (!this.vectors.has(b.hash)) missing.add(b.hash);
		}
		return missing;
	}

	private async dropUnusedVectors() {
		const used = new Set<string>();
		for (const f of this.files.values()) for (const b of f.blocks) used.add(b.hash);
		const space = this.meta.embeddingSpace;
		const unused = [...this.vectors.keys()].filter((h) => !used.has(h));
		for (const h of unused) this.vectors.delete(h);
		if (space && unused.length) await delMany(unused.map((h) => vectorKey(space, h)), this.db.vectors);
	}

	/** Load one model's stored vectors into memory, replacing whatever was loaded. */
	private async loadVectors(space: string) {
		const rows = await this.db.vectors('readonly', (store) => promisifyRequest(store.getAll(modelRange(space)) as IDBRequest<StoredVector[]>));
		this.vectors = new Map(rows.map((r) => [r.hash, { q: r.q, scale: r.scale }]));
	}

	private async deleteVectorsOf(space: string) {
		await this.db.vectors('readwrite', (store) => promisifyRequest(store.delete(modelRange(space))));
	}

	private async saveKeywordIndex() {
		if (this.keywordSaveTimer) { window.clearTimeout(this.keywordSaveTimer); this.keywordSaveTimer = null; }
		if (!this.keywordDirty) return;
		const snap: KeywordSnapshot = {
			json: JSON.stringify(this.keyword),
			entries: Object.fromEntries(this.keywordEntries),
		};
		this.keywordDirty = false;
		await set('keyword', snap, this.db.meta);
	}

	private scheduleKeywordSave() {
		if (this.keywordSaveTimer) window.clearTimeout(this.keywordSaveTimer);
		this.keywordSaveTimer = window.setTimeout(() => {
			this.keywordSaveTimer = null;
			void this.serial(() => this.saveKeywordIndex());
		}, KEYWORD_SAVE_DELAY_MS);
	}

	private async clearStores() {
		await Promise.all([clear(this.db.meta), clear(this.db.files), clear(this.db.vectors)]);
	}
}
