import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { IndexRepository } from '../src/index_repository';
import { SearchService, fuse } from '../src/search';
import { FakeVault } from './helpers/fake-vault';

const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any;

/** Toy embedding: one dimension per topic word, so "semantic" neighbours are predictable. */
const TOPICS = ['bird', 'sea', 'love', 'death', 'night'];
const embedText = (t: string) => {
    const s = t.toLowerCase();
    return TOPICS.map((w) => (s.includes(w) ? 1 : 0) + 0.01);
};

let ns = 0;
let vault: FakeVault;
let repo: IndexRepository;
let search: SearchService;

beforeEach(async () => {
    vault = new FakeVault();
    vault.write('Raven.md', 'Quoth the raven, a bird of ill omen, at night.\n\nNevermore, said the black bird.');
    vault.write('Annabel Lee.md', 'In a kingdom by the sea she lived with no other thought than to love.\n\nHer tomb by the sounding sea.');
    vault.write('Conqueror Worm.md', 'Lo! tis a gala night within the lonesome latter years. The play is the tragedy, Man, its hero the Conqueror Worm: death.');
    repo = new IndexRepository(`search-${++ns}`, log);
    await repo.load();
    await repo.sync(vault);
    search = new SearchService(repo, async (p) => (await vault.read(p))?.content ?? null, log);
});

const enableSemantic = async () => {
    await repo.setEmbeddingSpace('toy');
    await repo.embedMissing(vault, async (texts) => texts.map(embedText));
    search.embedQuery = vi.fn(async (t: string) => embedText(t));
};

describe('fuse', () => {
    const k = [{ id: 'a', score: 9 }, { id: 'b', score: 5 }];
    const s = [{ id: 'b', score: 0.9 }, { id: 'c', score: 0.8 }];

    it('returns one side unchanged at the extremes', () => {
        expect(fuse(k, s, 0)).toBe(k);
        expect(fuse(k, s, 1)).toBe(s);
    });

    it('ranks items found by both retrievers first, and leans with the weight', () => {
        expect(fuse(k, s, 0.5)[0].id).toBe('b');
        expect(fuse([{ id: 'a', score: 1 }], [{ id: 'c', score: 1 }], 0.8)[0].id).toBe('c');
        expect(fuse([{ id: 'a', score: 1 }], [{ id: 'c', score: 1 }], 0.2)[0].id).toBe('a');
    });
});

describe('SearchService', () => {
    it('keyword search returns current block text and position', async () => {
        const [top] = await search.search('nevermore', { semanticWeight: 0, limit: 5 });
        expect(top).toMatchObject({ path: 'Raven.md', noteName: 'Raven', text: 'Nevermore, said the black bird.', line: 2, endLine: 2 });
    });

    it('does not embed anything at weight 0', async () => {
        await enableSemantic();
        await search.search('bird', { semanticWeight: 0, limit: 5 });
        expect(search.embedQuery).not.toHaveBeenCalled();
    });

    it('semantic search finds related blocks without shared words', async () => {
        await enableSemantic();
        // No word in common with the vault, but the toy model maps it onto the sea/love topics
        expect(await search.search('seashore lovers', { semanticWeight: 0, limit: 5 })).toEqual([]);
        const results = await search.search('seashore lovers', { semanticWeight: 1, limit: 5 });
        expect(results[0].path).toBe('Annabel Lee.md');
    });

    it('blends both at intermediate weights', async () => {
        await enableSemantic();
        const results = await search.search('gala night', { semanticWeight: 0.5, limit: 5 });
        expect(results.map((r) => r.path)).toContain('Conqueror Worm.md');
        expect(search.embedQuery).toHaveBeenCalledTimes(1);
    });

    it('reports a failing embedding service once, and clears it when it recovers', async () => {
        await enableSemantic();
        log.warn.mockClear();
        const working = search.embedQuery!;
        search.embedQuery = vi.fn(async () => { throw new Error('connection refused'); });
        await search.search('nevermore', { semanticWeight: 0.5, limit: 5 });
        await search.search('nevermore', { semanticWeight: 0.5, limit: 5 });
        expect(search.semanticError).toBe('connection refused');
        expect(log.warn).toHaveBeenCalledTimes(1);

        search.embedQuery = working;
        await search.search('nevermore', { semanticWeight: 0.5, limit: 5 });
        expect(search.semanticError).toBeNull();
    });

    it('falls back to keyword results when no vectors exist or embedding fails', async () => {
        search.embedQuery = vi.fn(async (t: string) => embedText(t));
        expect((await search.search('nevermore', { semanticWeight: 1, limit: 5 }))[0]?.path).toBe('Raven.md');

        await enableSemantic();
        search.embedQuery = vi.fn(async () => { throw new Error('server down'); });
        expect((await search.search('nevermore', { semanticWeight: 0.7, limit: 5 }))[0]?.path).toBe('Raven.md');
        expect(log.warn).toHaveBeenCalled();
    });

    it('excludes the current note and caps results per note', async () => {
        const all = await search.search('bird sea', { semanticWeight: 0, limit: 10, maxPerNote: 1 });
        expect(all.filter((r) => r.path === 'Raven.md')).toHaveLength(1);
        const excluded = await search.search('bird sea', { semanticWeight: 0, limit: 10, excludePath: 'Raven.md' });
        expect(excluded.map((r) => r.path)).not.toContain('Raven.md');
    });

    it('skips blocks whose file changed after indexing', async () => {
        vault.write('Raven.md', 'Entirely different text now, no omens here.\n\nStill nothing.');
        expect(await search.search('nevermore', { semanticWeight: 0, limit: 5 })).toEqual([]);
    });

    it('returns nothing for empty context', async () => {
        expect(await search.search('   ', { semanticWeight: 0.5, limit: 5 })).toEqual([]);
    });
});

describe('SearchService: boilerplate', () => {
    /** A vault like the test vault: every note opens with a templated byline. */
    const templatedVault = async () => {
        const v = new FakeVault();
        const topics = ['raven', 'lighthouse', 'pendulum', 'masque', 'maelstrom', 'tarn', 'gold', 'cask', 'heart', 'usher',
            'ligeia', 'eleonora', 'morella', 'berenice', 'silence', 'shadow', 'eldorado', 'ulalume', 'lenore', 'annabel',
            'tamerlane', 'israfel', 'helen', 'dreamland', 'bells'];
        topics.forEach((t, i) => v.write(`notes/${t}.md`,
            `_**by Edgar Allan Poe** (published ${1830 + i})_\n\nA story of the ${t}, its ${t} keeper and the ${t} omen.`));
        // Unique to one note (not a template), but every word is in nearly every note.
        v.write('notes/raven.md', (await v.read('notes/raven.md'))!.content + '\n\nThe omen, the keeper, the story.');
        // the same stanza quoted in two notes
        v.write('notes/quoted-a.md', 'Thy naiad airs have brought me home to the glory that was Greece.');
        v.write('notes/quoted-b.md', 'Thy naiad airs have brought me home to the glory that was Greece!');
        const r = new IndexRepository(`boilerplate-${++ns}`, log);
        await r.load();
        await r.sync(v);
        return { v, s: new SearchService(r, async (p) => (await v.read(p))?.content ?? null, log) };
    };

    it('leaves out a template repeated across many notes', async () => {
        const { s } = await templatedVault();
        const results = await s.search('by Edgar Allan Poe (published 1849) the raven omen', { semanticWeight: 0, limit: 10 });
        expect(results.length).toBeGreaterThan(0);
        expect(results.some((r) => /Edgar Allan Poe/.test(r.text))).toBe(false);
        expect(results[0].text).toMatch(/raven/);
    });

    it('leaves out passages with almost no distinctive words', async () => {
        const { s } = await templatedVault();
        const results = await s.search('the omen, the keeper, the story', { semanticWeight: 0, limit: 10 });
        expect(results.length).toBeGreaterThan(0);
        expect(results.map((r) => r.text)).not.toContain('The omen, the keeper, the story.');
    });

    it('shows a passage repeated in several notes only once', async () => {
        const { s } = await templatedVault();
        const results = await s.search('naiad airs glory Greece', { semanticWeight: 0, limit: 10 });
        expect(results.filter((r) => /naiad/.test(r.text))).toHaveLength(1);
    });

    it('shows everything when the filters are turned off', async () => {
        const { s } = await templatedVault();
        const off = { semanticWeight: 0, limit: 10, filterBoilerplate: false, filterCommonPhrasing: false };
        const bylines = await s.search('by Edgar Allan Poe (published 1849)', off);
        expect(bylines.filter((r) => /Edgar Allan Poe/.test(r.text)).length).toBeGreaterThan(1);
        expect((await s.search('the omen, the keeper, the story', off)).map((r) => r.text)).toContain('The omen, the keeper, the story.');
        expect((await s.search('naiad airs glory Greece', off)).filter((r) => /naiad/.test(r.text))).toHaveLength(2);
    });

    it('applies each filter independently', async () => {
        const { s } = await templatedVault();
        const onlyPhrasing = await s.search('by Edgar Allan Poe (published 1849)', { semanticWeight: 0, limit: 10, filterBoilerplate: false });
        // the byline is both templated and uninformative, so the phrasing filter alone still hides it
        expect(onlyPhrasing.some((r) => /Edgar Allan Poe/.test(r.text))).toBe(false);
        const onlyBoilerplate = await s.search('the omen, the keeper, the story', { semanticWeight: 0, limit: 10, filterCommonPhrasing: false });
        expect(onlyBoilerplate.map((r) => r.text)).toContain('The omen, the keeper, the story.');
    });

    it('does not judge informativeness in a small vault', async () => {
        // The 3-note vault from the other tests: everything is too rare/common to judge.
        vault.write('Short.md', '"Yes," he said, quite sure of it.');
        await repo.sync(vault);
        const results = await search.search('yes he said', { semanticWeight: 0, limit: 10 });
        expect(results.map((r) => r.path)).toContain('Short.md');
    });
});
