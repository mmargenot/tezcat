export interface DocLike {
	lineCount(): number;
	getLine(line: number): string;
}

const NEIGHBOUR_LINES = 10;

/**
 * Text around the cursor: up to `windowWords` words centred on the cursor, drawn from
 * nearby lines only so large notes stay cheap.
 */
export function cursorContext(doc: DocLike, cursor: { line: number; ch: number }, windowWords: number): string {
	const lineCount = doc.lineCount();
	if (lineCount === 0) return '';
	const line = Math.min(Math.max(cursor.line, 0), lineCount - 1);
	const from = Math.max(0, line - NEIGHBOUR_LINES);
	const to = Math.min(lineCount, line + NEIGHBOUR_LINES + 1);

	const words = (s: string) => s.split(/\s+/).filter(Boolean);
	const before: string[] = [];
	for (let i = from; i < line; i++) before.push(...words(doc.getLine(i)));
	const current = doc.getLine(line);
	before.push(...words(current.slice(0, cursor.ch)));
	const after: string[] = words(current.slice(cursor.ch));
	for (let i = line + 1; i < to; i++) after.push(...words(doc.getLine(i)));

	const half = Math.floor(windowWords / 2);
	// Use spare budget from one side on the other (e.g. cursor at the top of a note).
	const takeBefore = Math.min(before.length, Math.max(half, windowWords - after.length));
	const takeAfter = Math.min(after.length, windowWords - takeBefore);
	return [...before.slice(before.length - takeBefore), ...after.slice(0, takeAfter)].join(' ');
}
