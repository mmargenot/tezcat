import { describe, it, expect } from 'vitest';
import { processTerm, queryTerms, stripMarkdown, tokenize } from '../src/text';

describe('stripMarkdown', () => {
    it('keeps link text and drops link targets', () => {
        expect(stripMarkdown('see [[Raven|the poem]] and [docs](https://x.y/z)')).toMatch(/see\s+the poem\s+and\s+docs\s*$/);
        expect(stripMarkdown('[[Notes/Annabel Lee#Stanza 2]]').trim()).toBe('Notes/Annabel Lee');
    });

    it('drops code, URLs, block ids and structural markers', () => {
        const out = stripMarkdown('# Title\n> quote\n- item `code` https://e.x ^abc-1\n```\nfn()\n```');
        expect(out).not.toMatch(/[#>`]|https|abc-1|fn\(\)/);
        expect(out).toMatch(/Title[\s\S]*quote[\s\S]*item/);
    });
});

describe('tokenize', () => {
    it('lowercases and splits on punctuation, keeping inner apostrophes', () => {
        expect(tokenize("Nevermore! Quoth the Raven's ghost—once.")).toEqual(['nevermore', 'quoth', 'the', "raven's", 'ghost', 'once']);
    });

    it('handles non-Latin letters and digits', () => {
        expect(tokenize('Café 1849 Ελλάδα')).toEqual(['café', '1849', 'ελλάδα']);
    });
});

describe('processTerm', () => {
    it('drops stopwords and very short terms', () => {
        expect(processTerm('the')).toBeNull();
        expect(processTerm('a')).toBeNull();
        expect(processTerm('Raven')).toBe('raven');
    });
});

describe('queryTerms', () => {
    it('returns distinct content terms in order', () => {
        expect(queryTerms('The raven, the RAVEN and the lost Lenore')).toEqual(['raven', 'lost', 'lenore']);
    });

    it('never produces query syntax, whatever the input', () => {
        expect(queryTerms('foo - bar: (baz) "qux" OR NEAR*')).toEqual(['foo', 'bar', 'baz', 'qux', 'near']);
    });

    it('caps the number of terms', () => {
        const text = Array.from({ length: 100 }, (_, i) => `word${i}`).join(' ');
        expect(queryTerms(text, 10)).toHaveLength(10);
    });
});
