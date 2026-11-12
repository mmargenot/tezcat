import { hashText } from './blocks';
import type { Hit, IndexRepository } from './index_repository';
import type { Logger } from './logger';
import { cosine, normalize } from './vectors';

export interface SearchResult {
	path: string;
	/** File name without extension. */
	noteName: string;
	/** The block's current text. */
	text: string;
	/** 0-based lines the block spans. */
	line: number;
	endLine: number;
	score: number;
}

export interface SearchOptions {
	/** 0 = keyword (BM25) only, 1 = semantic only, in between = both, weighted. */
	semanticWeight: number;
	limit: number;
	/** Leave out this file entirely (normally the note being edited). */
	excludePath?: string;
	/** At most this many results per note, so one long note can't fill the list. */
	maxPerNote?: number;
	/** Hide templates repeated across notes, and show any other repeated passage once (default true). */
	filterBoilerplate?: boolean;
	/** Hide passages made only of words common across the vault (default true). */
	filterCommonPhrasing?: boolean;
}

/** RRF smoothing constant; 60 is the value from the original RRF paper. */
const RRF_K = 60;
/**
 * Each retriever contributes this many times `limit` candidates to fusion; generous, since
 * boilerplate and duplicates are filtered out afterwards.
 */
const POOL_FACTOR = 10;

/**
 * Boilerplate filtering. A block is left out of results if either:
 * - the same template (see text.signature) appears in at least TEMPLATE_MIN_NOTES notes,
 *   e.g. a byline or header repeated across a vault; or
 * - it carries almost no information: its informativeness (see
 *   IndexRepository.informativeness) is below MIN_INFORMATION, i.e. less than one word that
 *   appears in about a third of notes. Applied only from MIN_NOTES_FOR_IDF notes up, since
 *   word frequencies mean little in a tiny vault.
 */
const TEMPLATE_MIN_NOTES = 5;
const MIN_INFORMATION = 1.0;
const MIN_NOTES_FOR_IDF = 20;

/**
 * Weighted Reciprocal Rank Fusion. Rank-based, so BM25 scores (unbounded) and cosine
 * similarities never need to be put on one scale.
 */
export function fuse(keyword: Hit[], semantic: Hit[], semanticWeight: number): Hit[] {
	const w = Math.min(1, Math.max(0, semanticWeight));
	if (w === 0) return keyword;
	if (w === 1) return semantic;
	const scores = new Map<string, number>();
	keyword.forEach((h, rank) => scores.set(h.id, (scores.get(h.id) ?? 0) + (1 - w) / (RRF_K + rank + 1)));
	semantic.forEach((h, rank) => scores.set(h.id, (scores.get(h.id) ?? 0) + w / (RRF_K + rank + 1)));
	return [...scores].map(([id, score]) => ({ id, score })).sort((a, b) => b.score - a.score);
}

/**
 * Finds blocks related to a piece of text: keyword matches, semantic matches, or a weighted
 * mix of both, read back from the vault so results always show current text.
 */
export class SearchService {
	/** Embeds a search query; null when semantic search isn't configured. */
	embedQuery: ((text: string) => Promise<ArrayLike<number>>) | null = null;

	constructor(
		private repo: IndexRepository,
		/** Current content of a file, or null if it no longer exists. */
		private read: (path: string) => Promise<string | null>,
		private log: Logger,
	) {}

	async search(text: string, opts: SearchOptions): Promise<SearchResult[]> {
		const { limit, excludePath, maxPerNote = 2, filterBoilerplate = true, filterCommonPhrasing = true } = opts;
		if (!text.trim()) return [];
		const pool = { limit: limit * POOL_FACTOR, excludePath };

		let semantic: Hit[] = [];
		let weight = Math.min(1, Math.max(0, opts.semanticWeight));
		if (weight > 0) {
			try {
				semantic = await this.semanticSearch(text, pool);
			} catch (e) {
				this.log.warn('Search', 'Semantic search failed; showing keyword results only', e);
			}
			// No vectors yet, or the embedding service failed: fall back to keyword search.
			if (semantic.length === 0) weight = 0;
		}
		const keyword = weight < 1 ? this.repo.keywordSearch(text, pool) : [];
		return this.toResults(fuse(keyword, semantic, weight), { limit, maxPerNote, filterBoilerplate, filterCommonPhrasing });
	}

	private async semanticSearch(text: string, { limit, excludePath }: { limit: number; excludePath?: string }): Promise<Hit[]> {
		if (!this.embedQuery || this.repo.stats.vectors === 0) return [];
		const query = normalize(await this.embedQuery(text));
		const hits: Hit[] = [];
		for (const { id, path, vector } of this.repo.vectorEntries()) {
			if (path === excludePath || vector.q.length !== query.length) continue;
			hits.push({ id, score: cosine(query, vector) });
		}
		hits.sort((a, b) => b.score - a.score);
		return hits.slice(0, limit);
	}

	/**
	 * Resolve hits to current block text, skipping boilerplate, repeats of a result already
	 * shown, and blocks that changed since indexing.
	 */
	private async toResults(
		hits: Hit[],
		{ limit, maxPerNote, filterBoilerplate, filterCommonPhrasing }: { limit: number; maxPerNote: number; filterBoilerplate: boolean; filterCommonPhrasing: boolean },
	): Promise<SearchResult[]> {
		const contents = new Map<string, Promise<string | null>>();
		const perNote = new Map<string, number>();
		const seenSignatures = new Set<string>();
		const useInformation = filterCommonPhrasing && this.repo.noteCount >= MIN_NOTES_FOR_IDF;
		const results: SearchResult[] = [];
		for (const hit of hits) {
			if (results.length >= limit) break;
			const found = this.repo.getBlock(hit.id);
			if (!found) continue;
			const { path, block } = found;
			if ((perNote.get(path) ?? 0) >= maxPerNote) continue;
			// Cheap checks first: no file read needed.
			if (filterBoilerplate && (seenSignatures.has(block.sig) || this.repo.notesWithSignature(block.sig) >= TEMPLATE_MIN_NOTES)) continue;
			if (!contents.has(path)) contents.set(path, this.read(path));
			const content = await contents.get(path)!;
			const blockText = content?.slice(block.start, block.end).trim();
			// The file changed since it was indexed and this block moved or changed; its
			// re-index is on the way.
			if (!blockText || hashText(blockText) !== block.hash) continue;
			if (useInformation && this.repo.informativeness(blockText) < MIN_INFORMATION) continue;
			seenSignatures.add(block.sig);
			perNote.set(path, (perNote.get(path) ?? 0) + 1);
			results.push({
				path,
				noteName: path.replace(/^.*\//, '').replace(/\.md$/, ''),
				text: blockText,
				line: block.line,
				endLine: block.endLine,
				score: hit.score,
			});
		}
		return results;
	}
}
