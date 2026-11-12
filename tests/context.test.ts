import { describe, it, expect } from 'vitest';
import { cursorContext, type DocLike } from '../src/context';

function doc(text: string): DocLike {
    const lines = text.split('\n');
    return { lineCount: () => lines.length, getLine: (i) => lines[i] };
}

const numbered = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(' ');

describe('cursorContext', () => {
    it('centres the window on the cursor', () => {
        const d = doc(numbered(100));
        const ch = numbered(50).length + 1; // cursor just before w50
        expect(cursorContext(d, { line: 0, ch }, 4)).toBe('w48 w49 w50 w51');
    });

    it('uses spare words after the cursor when the cursor is near the start', () => {
        const d = doc(numbered(100));
        expect(cursorContext(d, { line: 0, ch: 0 }, 4)).toBe('w0 w1 w2 w3');
    });

    it('uses spare words before the cursor when the cursor is near the end', () => {
        const text = numbered(100);
        expect(cursorContext(doc(text), { line: 0, ch: text.length }, 4)).toBe('w96 w97 w98 w99');
    });

    it('spans neighbouring lines', () => {
        const d = doc('alpha beta\ngamma delta\nepsilon zeta');
        expect(cursorContext(d, { line: 1, ch: 5 }, 4)).toBe('beta gamma delta epsilon');
    });

    it('only reads lines near the cursor', () => {
        const lines = Array.from({ length: 50 }, (_, i) => `line${i}`);
        expect(cursorContext(doc(lines.join('\n')), { line: 25, ch: 0 }, 1000).split(' '))
            .toEqual(lines.slice(15, 36));
    });

    it('returns an empty string for an empty document', () => {
        expect(cursorContext(doc(''), { line: 0, ch: 0 }, 10)).toBe('');
    });

    it('clamps a cursor past the end of the document', () => {
        expect(cursorContext(doc('one two'), { line: 9, ch: 99 }, 10)).toBe('one two');
    });
});
