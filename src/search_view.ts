import { ItemView, WorkspaceLeaf, MarkdownView, Notice } from 'obsidian';
import { SearchResult } from './search_service';
import { logger } from './logger';
import { Position } from './note_processor';
import type Tezcat from './main';

const VIEW_TYPE = 'remembrance-search';

class TezcatView extends ItemView {
  private resultsContainer: HTMLElement;
  private lastActiveMarkdownView: MarkdownView | null = null;
  private plugin: Tezcat; // Reference to the main plugin

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
    // Get plugin reference from the leaf
    this.plugin = (leaf as any).plugin || (this.app as any).plugins.plugins.tezcat;
  }
  
  getViewType() {
    return VIEW_TYPE;
  }

  getDisplayText() {
    return 'Tezcat Search';
  }

  getIcon() {
    return 'eye';
  }

  async onOpen() {
    const container = this.containerEl.children[1];
    container.empty();
    
    const header = container.createEl('div', { cls: 'tezcat-search-view-header' });
    header.createEl('h4', { text: 'Tezcat Search' });

    this.resultsContainer = container.createEl('div', { cls: 'tezcat-search-results-container' });
    this.showEmptyState();
  }

  async onClose() {
    // Nothing to clean up.
  }

  async updateSearchResults(results: SearchResult[]) {
    this.resultsContainer.empty();
    
    if (results.length === 0) {
      this.showEmptyState();
      return;
    }

    // Show results count immediately
    const countEl = this.resultsContainer.createEl('div', { cls: 'tezcat-search-count' });
    countEl.textContent = `${results.length} results`;

    // Render results asynchronously in batches to avoid blocking the editor
    await this.renderResultsBatched(results);
  }

  private async renderResultsBatched(results: SearchResult[]) {
    const BATCH_SIZE = 3; // Render 3 items at a time
    
    for (let i = 0; i < results.length; i += BATCH_SIZE) {
      const batch = results.slice(i, i + BATCH_SIZE);
      
      // Render batch synchronously
      batch.forEach((result, batchIndex) => {
        this.createResultItem(result, i + batchIndex);
      });
      
      // Yield control back to the browser after each batch
      if (i + BATCH_SIZE < results.length) {
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    }
  }

  setLastActiveMarkdownView(view: MarkdownView | null) {
    this.lastActiveMarkdownView = view;
  }

  private showEmptyState() {
    const emptyEl = this.resultsContainer.createEl('div', { cls: 'tezcat-search-empty-state' });
    emptyEl.createEl('p', { text: 'Move your cursor around in a markdown file to see related content.' });
  }

  private createResultItem(result: SearchResult, index: number) {
    const itemEl = this.resultsContainer.createEl('div', { cls: 'tezcat-search-result-item' });

    // Result content (text for blocks)
    if (result.type === 'block') {
      const textEl = itemEl.createEl('div', { cls: 'tezcat-search-result-text' });
      textEl.textContent = result.text.length > 150 ? result.text.substring(0, 150) + '...' : result.text;
    }

    // Path with type and score
    const pathContainerEl = itemEl.createEl('div', { cls: 'tezcat-search-result-path-container' });

    const pathEl = pathContainerEl.createEl('div', { cls: 'tezcat-search-result-path' });
    pathEl.textContent = result.notePath;

    const metaEl = pathContainerEl.createDiv({ cls: 'tezcat-search-result-meta' });
    const typeSpan = metaEl.createEl('span', {
      text: result.type,
      cls: 'tezcat-search-result-type'
    });

    const scoreSpan = metaEl.createEl('span', {
      text: result.score.toFixed(3),
      cls: 'tezcat-search-result-score'
    });

    // Action buttons
    const actionsEl = itemEl.createEl('div', { cls: 'tezcat-search-result-actions' });

    if (result.type === 'note') {
      // For note results: only show "Insert Link" and "Open Note"

      // Insert link button
      const insertLinkBtn = actionsEl.createEl('button', { text: 'Insert Link' });
      insertLinkBtn.onclick = (e) => {
        e.stopPropagation();
        this.insertLink(result);
      };

      // Open note button
      const openNoteBtn = actionsEl.createEl('button', { text: 'Open Note', cls: 'mod-cta' });
      openNoteBtn.onclick = (e) => {
        e.stopPropagation();
        this.openNote(result);
      };

    } else if (result.type === 'block') {
      // For block results: show "Insert Block", "Insert Link", and "Open Note" (goes to block location)

      // Insert text button
      const insertTextBtn = actionsEl.createEl('button', { text: 'Insert Block' });
      insertTextBtn.onclick = (e) => {
        e.stopPropagation();
        this.insertText(result);
      };

      // Insert link button
      const insertLinkBtn = actionsEl.createEl('button', { text: 'Insert Link' });
      insertLinkBtn.onclick = (e) => {
        e.stopPropagation();
        this.insertLink(result);
      };

      // Open note button
      const openNoteBtn = actionsEl.createEl('button', { text: 'Open Note', cls: 'mod-cta' });
      openNoteBtn.onclick = (e) => {
        e.stopPropagation();
        this.openBlockInNote(result);
      };
    }

    // Hover effects are handled by CSS

    // Click to copy content to clipboard (default action)
    itemEl.onclick = () => this.copyToClipboard(result);
  }

  private insertText(result: SearchResult) {
    // Suppress search for 2 seconds after button click
    if (this.plugin && this.plugin.suppressSearchFor) {
      this.plugin.suppressSearchFor(2000);
    }
    
    // Try to get current active view first
    let targetView = this.app.workspace.getActiveViewOfType(MarkdownView);
    
    // If no active view, use the last known markdown view
    if (!targetView) {
      targetView = this.lastActiveMarkdownView;
    }
    
    if (targetView && targetView.editor) {
      const text = result.type === 'block' ? result.text : result.noteName;
      targetView.editor.replaceSelection(text);
    } else {
      logger.warn('SearchView', 'No valid markdown view found for text insertion');
    }
  }

  private insertLink(result: SearchResult) {
    // Suppress search for 2 seconds after button click
    if (this.plugin && this.plugin.suppressSearchFor) {
      this.plugin.suppressSearchFor(2000);
    }
    
    // Try to get current active view first
    let targetView = this.app.workspace.getActiveViewOfType(MarkdownView);
    
    // If no active view, use the last known markdown view
    if (!targetView) {
      targetView = this.lastActiveMarkdownView;
    }
    
    if (targetView && targetView.editor) {
      const linkText = `[[${result.notePath}|${result.noteName}]]`;
      targetView.editor.replaceSelection(linkText);
    } else {
      logger.warn('SearchView', 'No valid markdown view found for link insertion');
    }
  }

  private openNote(result: SearchResult) {
    this.app.workspace.openLinkText(result.notePath, '', false);
  }

  private async openBlockInNote(result: SearchResult) {
    // Open the note first
    await this.app.workspace.openLinkText(result.notePath, '', false);
    
    // If we have block position data, navigate to the block
    if (result.blockStartPosition) {
      // Small delay to ensure the editor is ready
      setTimeout(() => {
        const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (activeView && activeView.editor && result.blockStartPosition) {
          const editor = activeView.editor;
          
          // Set cursor to the start of the block
          editor.setCursor({
            line: result.blockStartPosition.line,
            ch: result.blockStartPosition.col
          });
          
          // Highlight the block if the setting is enabled
          if (this.plugin?.settings?.highlightBlockOnOpen && result.blockEndPosition) {
            editor.setSelection(
              { line: result.blockStartPosition.line, ch: result.blockStartPosition.col },
              { line: result.blockEndPosition.line, ch: result.blockEndPosition.col }
            );
          }
          
          // Scroll the block into view
          editor.scrollIntoView({
            from: { line: result.blockStartPosition.line, ch: result.blockStartPosition.col },
            to: { line: result.blockEndPosition?.line || result.blockStartPosition.line, ch: result.blockEndPosition?.col || result.blockStartPosition.col }
          });
          
          // Trigger a new search based on the block content we navigated to
          if (this.plugin && result.text) {
            // Use the block content itself as the search context
            (this.plugin as any).debouncedSearch(result.text);
          }
          
        }
      }, 100);
    }
  }

  private async copyToClipboard(result: SearchResult) {
    try {
      let textToCopy: string;
      let noticeMessage: string;

      if (result.type === 'block') {
        // For blocks: copy the block text
        textToCopy = result.text;
        noticeMessage = 'Block text copied to clipboard';
      } else {
        // For notes: copy a markdown link
        textToCopy = `[[${result.notePath}|${result.noteName}]]`;
        noticeMessage = 'Note link copied to clipboard';
      }

      // Copy to clipboard using the modern Clipboard API
      await navigator.clipboard.writeText(textToCopy);
      
      // Show success notice
      new Notice(noticeMessage, 2000);
      
    } catch (error) {
      logger.error('SearchView', 'Failed to copy to clipboard', error);
      new Notice('Failed to copy to clipboard', 3000);
    }
  }

}


export { TezcatView, VIEW_TYPE };
