import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { IndexRepository, EmbeddingSpaceChanged } from '../src/index_repository';
import { FakeVault } from './helpers/fake-vault';

const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any;

let ns = 0;
let namespace: string;
const open = async () => {
    const repo = new IndexRepository(namespace, log);
    await repo.load();
    return repo;
};
const paths = (repo: IndexRepository, query: string, excludePath?: string) =>
    repo.keywordSearch(query, { limit: 10, excludePath }).map((h) => repo.getBlock(h.id)!.path);

/** Deterministic fake embedding: counts of a few letters. */
const fakeEmbed = vi.fn(async (texts: string[]) =>
    texts.map((t) => ['a', 'e', 'o', 'r', 'n'].map((c) => t.toLowerCase().split(c).length)));

let vault: FakeVault;

beforeEach(() => {
    namespace = `test-${++ns}`;
    fakeEmbed.mockClear();
    vault = new FakeVault();
    vault.write('poems/The Raven.md', '# The Raven\n\nOnce upon a midnight dreary, while I pondered, weak and weary.\n\nQuoth the Raven, "Nevermore."');
    vault.write('poems/Annabel Lee.md', 'It was many and many a year ago, in a kingdom by the sea.\n\nThat a maiden there lived whom you may know.');
    vault.write('notes/Lighthouse.md', 'A lighthouse keeper writes about the sea and the dreary storm.');
});

describe('IndexRepository: keyword search', () => {
    it('indexes the vault and ranks blocks with BM25', async () => {
        const repo = await open();
        expect(await repo.sync(vault)).toEqual({ indexed: 3, removed: 0 });
        expect(repo.stats).toMatchObject({ files: 3, blocks: 5 });
        expect(paths(repo, 'nevermore')).toEqual(['poems/The Raven.md']);
        expect(paths(repo, 'kingdom by the sea')[0]).toBe('poems/Annabel Lee.md');
    });

    it('matches any query term and tolerates punctuation in the query', async () => {
        const repo = await open();
        await repo.sync(vault);
        expect(new Set(paths(repo, '"dreary" - storm: (sea) OR'))).toEqual(
            new Set(['notes/Lighthouse.md', 'poems/The Raven.md', 'poems/Annabel Lee.md']));
    });

    it('excludes a file (the note being edited) before limiting', async () => {
        const repo = await open();
        await repo.sync(vault);
        expect(paths(repo, 'dreary sea', 'notes/Lighthouse.md')).not.toContain('notes/Lighthouse.md');
        expect(paths(repo, 'dreary sea', 'notes/Lighthouse.md').length).toBeGreaterThan(0);
    });

    it('returns nothing for a query of only stopwords', async () => {
        const repo = await open();
        await repo.sync(vault);
        expect(repo.keywordSearch('the and of a', { limit: 10 })).toEqual([]);
    });

    it('resolves hits to blocks with their location in the file', async () => {
        const repo = await open();
        await repo.sync(vault);
        const [hit] = repo.keywordSearch('nevermore', { limit: 1 });
        const { block } = repo.getBlock(hit.id)!;
        const content = (await vault.read('poems/The Raven.md'))!.content;
        expect(content.slice(block.start, block.end)).toBe('Quoth the Raven, "Nevermore."');
        expect(block.line).toBe(4);
    });
});

describe('IndexRepository: file changes', () => {
    it('re-indexing a file replaces its old blocks', async () => {
        const repo = await open();
        await repo.sync(vault);
        vault.write('notes/Lighthouse.md', 'The keeper now writes about tulips.');
        await repo.indexFile((await vault.read('notes/Lighthouse.md'))!);
        expect(paths(repo, 'storm')).toEqual([]); // only in the old text (the title still matches 'lighthouse')
        expect(paths(repo, 'tulips')).toEqual(['notes/Lighthouse.md']);
    });

    it('removing a file removes it from search', async () => {
        const repo = await open();
        await repo.sync(vault);
        await repo.removeFile('poems/The Raven.md');
        expect(paths(repo, 'nevermore')).toEqual([]);
        expect(repo.stats.files).toBe(2);
    });

    it('renaming a file moves its results to the new path', async () => {
        const repo = await open();
        await repo.sync(vault);
        vault.rename('poems/The Raven.md', 'poems/Raven (1845).md');
        await repo.renameFile('poems/The Raven.md', await vault.read('poems/Raven (1845).md'));
        expect(paths(repo, 'nevermore')).toEqual(['poems/Raven (1845).md']);
    });

    it('skips files Obsidian has not parsed yet', async () => {
        const repo = await open();
        await repo.indexFile({ file: vault.file('notes/Lighthouse.md'), content: 'whatever', cache: null });
        expect(repo.stats.files).toBe(0);
    });

    it('sync picks up new, changed and deleted files only', async () => {
        const repo = await open();
        await repo.sync(vault);
        vault.write('notes/New.md', 'A brand new note about ravens and lighthouses.');
        vault.write('poems/Annabel Lee.md', 'Rewritten entirely: chilling and killing.');
        vault.delete('notes/Lighthouse.md');
        vault.reads = 0;
        expect(await repo.sync(vault)).toEqual({ indexed: 2, removed: 1 });
        expect(vault.reads).toBe(2);
        expect(paths(repo, 'chilling')).toEqual(['poems/Annabel Lee.md']);
        expect(paths(repo, 'lighthouse')).toEqual([]); // deleted, and nothing else uses the exact word
        expect(paths(repo, 'lighthouses')).toEqual(['notes/New.md']);
    });
});

describe('IndexRepository: persistence', () => {
    it('reloads without re-reading unchanged files', async () => {
        const first = await open();
        await first.sync(vault);
        await first.flush();

        const second = await open();
        vault.reads = 0;
        expect(await second.sync(vault)).toEqual({ indexed: 0, removed: 0 });
        expect(vault.reads).toBe(0);
        expect(paths(second, 'nevermore')).toEqual(['poems/The Raven.md']);
    });

    it('re-indexes files changed after the keyword index was last saved (e.g. a crash)', async () => {
        // Freeze the clock: the save and the later edit happen in the same millisecond, the
        // case a timestamp comparison can't tell apart. Detection must not depend on timing.
        const now = vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
        try {
            const first = await open();
            await first.sync(vault); // saves the keyword index
            vault.write('notes/Lighthouse.md', 'Updated just before quitting: zeppelins.');
            await first.indexFile((await vault.read('notes/Lighthouse.md'))!);
            // no flush: the keyword index on disk predates this change

            const second = await open();
            expect(paths(second, 'zeppelins')).toEqual([]);
            await second.sync(vault);
            expect(paths(second, 'zeppelins')).toEqual(['notes/Lighthouse.md']);
        } finally {
            now.mockRestore();
        }
    });

    it('clear() empties the index and its storage', async () => {
        const repo = await open();
        await repo.sync(vault);
        await repo.clear();
        expect(repo.stats).toEqual({ files: 0, blocks: 0, vectors: 0 });
        const reopened = await open();
        expect(reopened.stats.files).toBe(0);
    });
});

describe('IndexRepository: vectors', () => {
    it('embeds each distinct block once and keeps vectors across reloads', async () => {
        vault.write('notes/Copy.md', 'Quoth the Raven, "Nevermore."'); // same text as a Raven block
        const repo = await open();
        await repo.sync(vault);
        await repo.setEmbeddingSpace('model-a');
        expect(repo.countMissingVectors()).toBe(5);
        expect(await repo.embedMissing(vault, fakeEmbed, { batchSize: 2 })).toBe(5);
        expect(repo.countMissingVectors()).toBe(0);
        expect([...repo.vectorEntries()]).toHaveLength(6); // the copy shares its vector

        const reopened = await open();
        expect(reopened.stats.vectors).toBe(5);
        expect(reopened.embeddingSpace).toBe('model-a');
    });

    it('only embeds changed blocks after an edit, and keeps vectors on rename', async () => {
        const repo = await open();
        await repo.sync(vault);
        await repo.setEmbeddingSpace('model-a');
        await repo.embedMissing(vault, fakeEmbed);

        vault.write('poems/The Raven.md', '# The Raven\n\nOnce upon a midnight dreary, while I pondered, weak and weary.\n\nA new final stanza.');
        await repo.indexFile((await vault.read('poems/The Raven.md'))!);
        vault.rename('poems/Annabel Lee.md', 'Annabel.md');
        await repo.renameFile('poems/Annabel Lee.md', await vault.read('Annabel.md'));

        fakeEmbed.mockClear();
        expect(await repo.embedMissing(vault, fakeEmbed)).toBe(1);
        expect(fakeEmbed.mock.calls[0][0]).toEqual(['A new final stanza.']);
    });

    it('drops vectors when the embedding model changes', async () => {
        const repo = await open();
        await repo.sync(vault);
        await repo.setEmbeddingSpace('model-a');
        await repo.embedMissing(vault, fakeEmbed);
        await repo.setEmbeddingSpace('model-a');
        expect(repo.stats.vectors).toBe(5);
        await repo.setEmbeddingSpace('model-b');
        expect(repo.stats.vectors).toBe(0);
        expect((await open()).stats.vectors).toBe(0);
    });

    it('drops vectors no block uses any more on sync', async () => {
        const repo = await open();
        await repo.sync(vault);
        await repo.setEmbeddingSpace('model-a');
        await repo.embedMissing(vault, fakeEmbed);
        vault.delete('poems/Annabel Lee.md');
        await repo.sync(vault);
        expect(repo.stats.vectors).toBe(3);
    });

    it('never stores vectors from a model that was switched away from mid-run', async () => {
        const repo = await open();
        await repo.sync(vault);
        await repo.setEmbeddingSpace('model-a');
        const slowEmbed = async (texts: string[]) => {
            await repo.setEmbeddingSpace('model-b');
            return fakeEmbed(texts);
        };
        await expect(repo.embedMissing(vault, slowEmbed)).rejects.toBeInstanceOf(EmbeddingSpaceChanged);
        expect(repo.stats.vectors).toBe(0);
    });

    it('stops when aborted', async () => {
        const repo = await open();
        await repo.sync(vault);
        await repo.setEmbeddingSpace('model-a');
        const controller = new AbortController();
        controller.abort();
        expect(await repo.embedMissing(vault, fakeEmbed, { signal: controller.signal })).toBe(0);
        expect(fakeEmbed).not.toHaveBeenCalled();
    });
});

describe('IndexRepository: note frequencies', () => {
    it('counts the notes containing each signature and term, through edits, deletes and reloads', async () => {
        for (const y of [1840, 1841, 1842]) vault.write(`stories/S${y}.md`, `_**by Edgar Allan Poe** (published ${y})_\n\nA tale about the sea, numbered ${y}.`);
        const repo = await open();
        await repo.sync(vault);
        const byline = 'by edgar allan poe published #';
        expect(repo.noteCount).toBe(6);
        expect(repo.notesWithSignature(byline)).toBe(3);

        vault.write('stories/S1840.md', 'Rewritten without the byline.');
        await repo.indexFile((await vault.read('stories/S1840.md'))!);
        await repo.removeFile('stories/S1841.md');
        expect(repo.notesWithSignature(byline)).toBe(1);

        await repo.flush();
        const reopened = await open();
        expect(reopened.notesWithSignature(byline)).toBe(1);
        expect(reopened.noteCount).toBe(5);
    });

    it('scores text by how rare its words are across notes', async () => {
        const repo = await open();
        for (let i = 0; i < 10; i++) vault.write(`common/${i}.md`, `Everyday filler words appear here, note ${i}.`);
        await repo.sync(vault);
        const filler = repo.informativeness('Everyday filler words appear here, note 7.');
        const distinctive = repo.informativeness('Quoth the Raven, "Nevermore."');
        expect(filler).toBeLessThan(2);
        expect(distinctive).toBeGreaterThan(filler + 3);
    });
});
