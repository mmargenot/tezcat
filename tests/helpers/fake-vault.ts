import type { CachedMetadata, SectionCache } from 'obsidian';
import type { FileContent, SourceFile, VaultSource } from '../../src/index_repository';

/** Parse Markdown into Obsidian-like sections: blank-line-separated paragraphs and headings. */
export function parseSections(content: string): CachedMetadata {
    const sections: SectionCache[] = [];
    const re = /[^\n]+(?:\n[^\n]+)*/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content))) {
        const start = m.index, end = m.index + m[0].length;
        const line = content.slice(0, start).split('\n').length - 1;
        sections.push({
            type: m[0].startsWith('#') ? 'heading' : 'paragraph',
            position: {
                start: { line, col: 0, offset: start },
                end: { line: line + m[0].split('\n').length - 1, col: 0, offset: end },
            },
        });
    }
    return { sections };
}

/** An in-memory vault. Each write bumps the file's mtime, like a real save. */
export class FakeVault implements VaultSource {
    private files = new Map<string, { content: string; mtime: number }>();
    private clock = 1;
    reads = 0;

    write(path: string, content: string) {
        this.files.set(path, { content, mtime: this.clock++ });
    }

    delete(path: string) {
        this.files.delete(path);
    }

    rename(from: string, to: string) {
        const f = this.files.get(from)!;
        this.files.delete(from);
        this.files.set(to, f);
    }

    file(path: string): SourceFile {
        const f = this.files.get(path)!;
        return { path, basename: path.replace(/^.*\//, '').replace(/\.md$/, ''), mtime: f.mtime, size: f.content.length };
    }

    listFiles(): SourceFile[] {
        return [...this.files.keys()].map((p) => this.file(p));
    }

    async read(path: string): Promise<FileContent | null> {
        this.reads++;
        const f = this.files.get(path);
        return f ? { file: this.file(path), content: f.content, cache: parseSections(f.content) } : null;
    }
}
