
import { randomUUID } from 'crypto';

export enum BlockType {
    PARAGRAPH = 'paragraph',  // Regular text blocks
    HEADING = 'heading',  // # Headers (any level)
    LIST = 'list',  // - Unordered or 1. Ordered lists
    BLOCKQUOTE = 'blockquote',  // > Quoted text
    CODE = 'code',  // ```code blocks```
    TABLE = 'table',  // | Markdown | tables |
    RULE = 'thematicBreak',  // --- or *** or ___ 'html', // <div>Raw HTML blocks</div> 
    LINKREF = 'linkReference',  // [ref]: https://example.com "Title"
    DEFINITION = 'definition',  // Definition lists (rarely used)
    YAML = 'yaml',  // --- YAML frontmatter ---
    MATH = 'math',  // $$ Math blocks $$
    CALLOUT = 'callout',  // > [!note] Callouts
    EMBED = 'embed',  // ![[Embedded content]]
    FOOTNOTE = 'footnote'  // [^1]: Footnote definitions
}

export interface Position {
    line: number,
    col: number,
    offset: number
}

export interface Block {
    id: string
    type: BlockType
    content: string
    obsidian_id: string | null
    start_position: Position
    end_position: Position
}


export class NoteProcessor {

    async getBlocksFromFile(content: string, metadata: any): Promise<Block[]> {
        const blocks: Block[] = [];
        
        if (metadata?.sections) {
            for (const section of metadata.sections) {
                const blockContent = content.substring(
                    section.position.start.offset,
                    section.position.end.offset
                );  // raw content from the block.
                
                //regex snippet from claude to extract the content id from the end of the line
                const idMatch = blockContent.match(/\^([a-zA-Z0-9-]+)\s*$/);
                const obsidianId = idMatch ? idMatch[1] : null;
            
                const start_position: Position = {
                    line: section.position.start.line,
                    col: section.position.start.col,
                    offset: section.position.start.offset
                }
                const end_position: Position = {
                    line: section.position.end.line,
                    col: section.position.end.col,
                    offset: section.position.end.offset
                }
                
                // Generate block id
                const blockId = randomUUID();

                const block: Block = {
                    id: blockId,
                    type: section.type as BlockType,  // cast to BlockType
                    content: blockContent,
                    obsidian_id: obsidianId,
                    start_position: start_position,
                    end_position: end_position
                }
            
                blocks.push(block);
            }
        }
        return blocks;
    }
}
