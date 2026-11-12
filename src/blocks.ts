import type { CachedMetadata } from 'obsidian';
import { signature } from './text';

/** Section types worth indexing. Code, tables, YAML, math, etc. are skipped. */
const INDEXED_TYPES = new Set(['paragraph', 'heading', 'list', 'blockquote', 'callout']);

/** Blocks shorter than this (after trimming) carry too little signal to index. */
export const MIN_BLOCK_CHARS = 16;

export interface BlockRecord {
	/** Content hash of the block text. Vectors are keyed by this, so moves/renames keep them. */
	hash: string;
	type: string;
	/** Character offsets into the file content. */
	start: number;
	end: number;
	/** 0-based line numbers, for navigation. */
	line: number;
	endLine: number;
	/** Template signature (see text.signature): identical for blocks that differ only in formatting or numbers. */
	sig: string;
}

export interface Block extends BlockRecord {
	text: string;
}

/**
 * Split a file into indexable blocks using Obsidian's parsed sections.
 * `content` must be the text the `cache` was computed from.
 */
export function extractBlocks(content: string, cache: CachedMetadata | null): Block[] {
	const blocks: Block[] = [];
	for (const section of cache?.sections ?? []) {
		if (!INDEXED_TYPES.has(section.type)) continue;
		const { start, end } = section.position;
		const text = content.slice(start.offset, end.offset).trim();
		if (text.length < MIN_BLOCK_CHARS) continue;
		const sig = signature(text);
		if (!sig) continue; // no words at all (e.g. a "* * *" scene break): nothing to find it by
		blocks.push({
			hash: hashText(text),
			type: section.type,
			start: start.offset,
			end: end.offset,
			line: start.line,
			endLine: end.line,
			sig,
			text,
		});
	}
	return blocks;
}

/**
 * Fast, non-cryptographic 53-bit string hash (cyrb53), as base-36.
 * Only used to detect changed blocks and key cached vectors.
 */
export function hashText(text: string, seed = 0): string {
	let h1 = 0xdeadbeef ^ seed;
	let h2 = 0x41c6ce57 ^ seed;
	for (let i = 0; i < text.length; i++) {
		const ch = text.charCodeAt(i);
		h1 = Math.imul(h1 ^ ch, 2654435761);
		h2 = Math.imul(h2 ^ ch, 1597334677);
	}
	h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
	h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
	return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}
