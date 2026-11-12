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
