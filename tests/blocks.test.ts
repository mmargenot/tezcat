import { describe, it, expect } from 'vitest';
import type { CachedMetadata, SectionCache } from 'obsidian';
import { extractBlocks, hashText, MIN_BLOCK_CHARS } from '../src/blocks';

/** Build a CachedMetadata whose sections are the given (type, text) parts joined by blank lines. */
function parse(parts: [type: string, text: string][]): { content: string; cache: CachedMetadata } {
    let content = '';
    const sections: SectionCache[] = [];
    for (const [type, text] of parts) {
        if (content) content += '\n\n';
        const startOffset = content.length;
        const startLine = content.split('\n').length - 1;
        content += text;
        sections.push({
            type,
            position: {
                start: { line: startLine, col: 0, offset: startOffset },
                end: { line: startLine + text.split('\n').length - 1, col: 0, offset: content.length },
            },
        });
    }
    return { content, cache: { sections } };
}

describe('extractBlocks', () => {
    it('keeps prose sections with their text, offsets and lines', () => {
        const { content, cache } = parse([
            ['heading', '# The Raven'],
            ['paragraph', 'Once upon a midnight dreary, while I pondered.'],
            ['list', '- weak and weary\n- quaint and curious'],
        ]);
        const blocks = extractBlocks(content, cache);
        expect(blocks.map((b) => b.type)).toEqual(['paragraph', 'list']); // heading is too short
        const [p, l] = blocks;
        expect(content.slice(p.start, p.end)).toBe(p.text);
        expect(l.line).toBe(4);
        expect(l.endLine).toBe(5);
    });

    it('skips code, tables, frontmatter and very short sections', () => {
        const { content, cache } = parse([
            ['yaml', '---\ntags: [poem, gothic, raven]\n---'],
            ['code', '```js\nconsole.log("a long enough code block");\n```'],
            ['table', '| a long | table row |\n| --- | --- |'],
            ['paragraph', 'short'],
            ['paragraph', 'Quoth the Raven, "Nevermore."'],
        ]);
        expect(extractBlocks(content, cache).map((b) => b.text)).toEqual(['Quoth the Raven, "Nevermore."']);
    });

    it('returns nothing when the file has not been parsed', () => {
        expect(extractBlocks('Some text that is long enough.', null)).toEqual([]);
    });

    it('gives identical text the same hash and different text a different one', () => {
        const { content, cache } = parse([
            ['paragraph', 'Deep into that darkness peering.'],
            ['paragraph', 'Deep into that darkness peering.'],
            ['paragraph', 'Long I stood there wondering, fearing.'],
        ]);
        const [a, b, c] = extractBlocks(content, cache);
        expect(a.hash).toBe(b.hash);
        expect(a.hash).not.toBe(c.hash);
    });
});

describe('hashText', () => {
    it('is stable and sensitive to small changes', () => {
        expect(hashText('nevermore')).toBe(hashText('nevermore'));
        expect(hashText('nevermore')).not.toBe(hashText('Nevermore'));
        expect(MIN_BLOCK_CHARS).toBeGreaterThan(0);
    });
});
