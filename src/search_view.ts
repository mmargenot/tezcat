import { ItemView, WorkspaceLeaf, MarkdownView, Notice } from 'obsidian';
import { SearchResult } from './search_service';
import { logger } from './logger';

const VIEW_TYPE = 'remembrance-search';

class RemembranceView extends ItemView {
  private resultsContainer: HTMLElement;
  private lastActiveMarkdownView: MarkdownView | null = null;
  private plugin: any; // Reference to the main plugin

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
    
    // Create header
    const header = container.createEl('div', { cls: 'search-view-header' });
    header.createEl('h4', { text: 'Tezcat Search' });
    
    // Create results container
    this.resultsContainer = container.createEl('div', { cls: 'search-results-container' });
    this.resultsContainer.style.padding = '8px';
    this.resultsContainer.style.overflowY = 'auto';
    this.resultsContainer.style.height = 'calc(100% - 60px)';
    
    // Show initial empty state
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
    const countEl = this.resultsContainer.createEl('div', { cls: 'search-count' });
    countEl.textContent = `${results.length} results`;
    countEl.style.fontSize = '0.9em';
    countEl.style.color = 'var(--text-muted)';
    countEl.style.marginBottom = '12px';

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
    logger.debug('SearchView', `Set last active markdown view: ${view?.file?.path || 'none'}`);
  }

  private showEmptyState() {
    const emptyEl = this.resultsContainer.createEl('div', { cls: 'search-empty-state' });
    emptyEl.style.textAlign = 'center';
    emptyEl.style.color = 'var(--text-muted)';
    emptyEl.style.marginTop = '40px';
    emptyEl.createEl('p', { text: 'Move your cursor around in a markdown file to see related content.' });
  }

  private createResultItem(result: SearchResult, index: number) {
    const itemEl = this.resultsContainer.createEl('div', { cls: 'search-result-item' });
    itemEl.style.padding = '12px';
    itemEl.style.marginBottom = '8px';
    itemEl.style.border = '1px solid var(--background-modifier-border)';
    itemEl.style.borderRadius = '4px';
    itemEl.style.cursor = 'pointer';

    // Result content (text for chunks)
    if (result.type === 'chunk') {
      const textEl = itemEl.createEl('div', { cls: 'search-result-text' });
      textEl.textContent = result.text.length > 150 ? result.text.substring(0, 150) + '...' : result.text;
      textEl.style.fontSize = '0.85em';
      textEl.style.lineHeight = '1.4';
      textEl.style.marginBottom = '8px';
    }

    // Path with type and score
    const pathContainerEl = itemEl.createEl('div', { cls: 'search-result-path-container' });
    pathContainerEl.style.display = 'flex';
    pathContainerEl.style.justifyContent = 'space-between';
    pathContainerEl.style.alignItems = 'center';
    pathContainerEl.style.marginBottom = '8px';

    const pathEl = pathContainerEl.createEl('div', { cls: 'search-result-path' });
    pathEl.textContent = result.notePath;
    pathEl.style.color = 'var(--text-muted)';
    pathEl.style.fontSize = '0.8em';

    const metaEl = pathContainerEl.createDiv({ cls: 'search-result-meta' });
    metaEl.innerHTML = `<span style="background: var(--background-modifier-border); padding: 2px 6px; border-radius: 3px; font-size: 0.8em;">${result.type}</span> <span style="color: var(--text-muted); font-size: 0.8em;">${result.score.toFixed(3)}</span>`;

    // Action buttons
    const actionsEl = itemEl.createEl('div', { cls: 'search-result-actions' });
    actionsEl.style.marginTop = '8px';
    actionsEl.style.display = 'flex';
    actionsEl.style.gap = '8px';

    if (result.type === 'note') {
      // For note results: only show "Insert Link" and "Open Note"
      
      // Insert link button
      const insertLinkBtn = actionsEl.createEl('button', { text: 'Insert Link' });
      insertLinkBtn.style.fontSize = '0.8em';
      insertLinkBtn.style.padding = '4px 8px';
      insertLinkBtn.onclick = (e) => {
        e.stopPropagation();
        this.insertLink(result);
      };

      // Open note button
      const openNoteBtn = actionsEl.createEl('button', { text: 'Open Note', cls: 'mod-cta' });
      openNoteBtn.style.fontSize = '0.8em';
      openNoteBtn.style.padding = '4px 8px';
      openNoteBtn.onclick = (e) => {
        e.stopPropagation();
        this.openNote(result);
      };
      
    } else if (result.type === 'chunk') {
      // For chunk results: show "Insert Text", "Insert Link", and "Open Note" (goes to chunk location)
      
      // Insert text button
      const insertTextBtn = actionsEl.createEl('button', { text: 'Insert Text' });
      insertTextBtn.style.fontSize = '0.8em';
      insertTextBtn.style.padding = '4px 8px';
      insertTextBtn.onclick = (e) => {
        e.stopPropagation();
        this.insertText(result);
      };

      // Insert link button
      const insertLinkBtn = actionsEl.createEl('button', { text: 'Insert Link' });
      insertLinkBtn.style.fontSize = '0.8em';
      insertLinkBtn.style.padding = '4px 8px';
      insertLinkBtn.onclick = (e) => {
        e.stopPropagation();
        this.insertLink(result);
      };

      // Open note button
      const openNoteBtn = actionsEl.createEl('button', { text: 'Open Note', cls: 'mod-cta' });
      openNoteBtn.style.fontSize = '0.8em';
      openNoteBtn.style.padding = '4px 8px';
      openNoteBtn.onclick = (e) => {
        e.stopPropagation();
        this.openNote(result);
      };
    }

    // Hover effects
    itemEl.onmouseenter = () => {
      itemEl.style.backgroundColor = 'var(--background-modifier-hover)';
    };

    itemEl.onmouseleave = () => {
      itemEl.style.backgroundColor = '';
    };

    // Click to copy content to clipboard (default action)
    itemEl.onclick = () => this.copyToClipboard(result);
  }

  private insertText(result: SearchResult) {
    logger.debug('SearchView', `Insert text clicked for result: ${result.noteName}`);
    
    // Suppress search for 2 seconds after button click
    if (this.plugin && this.plugin.suppressSearchFor) {
      this.plugin.suppressSearchFor(2000);
    }
    
    // Try to get current active view first
    let targetView = this.app.workspace.getActiveViewOfType(MarkdownView);
    logger.debug('SearchView', `Current active view: ${targetView?.file?.path || 'none'}`);
    
    // If no active view, use the last known markdown view
    if (!targetView) {
      targetView = this.lastActiveMarkdownView;
      logger.debug('SearchView', `Using last active view: ${targetView?.file?.path || 'none'}`);
    }
    
    if (targetView && targetView.editor) {
      const text = result.type === 'chunk' ? result.text : result.noteName;
      logger.debug('SearchView', `Inserting text: ${text.substring(0, 50)}...`);
      targetView.editor.replaceSelection(text);
      logger.debug('SearchView', 'Text inserted successfully');
    } else {
      logger.warn('SearchView', 'No valid markdown view found for text insertion');
    }
  }

  private insertLink(result: SearchResult) {
    logger.debug('SearchView', `Insert link clicked for result: ${result.noteName}`);
    
    // Suppress search for 2 seconds after button click
    if (this.plugin && this.plugin.suppressSearchFor) {
      this.plugin.suppressSearchFor(2000);
    }
    
    // Try to get current active view first
    let targetView = this.app.workspace.getActiveViewOfType(MarkdownView);
    logger.debug('SearchView', `Current active view: ${targetView?.file?.path || 'none'}`);
    
    // If no active view, use the last known markdown view
    if (!targetView) {
      targetView = this.lastActiveMarkdownView;
      logger.debug('SearchView', `Using last active view: ${targetView?.file?.path || 'none'}`);
    }
    
    if (targetView && targetView.editor) {
      const linkText = `[[${result.notePath}|${result.noteName}]]`;
      logger.debug('SearchView', `Inserting link: ${linkText}`);
      targetView.editor.replaceSelection(linkText);
      logger.debug('SearchView', 'Link inserted successfully');
    } else {
      logger.warn('SearchView', 'No valid markdown view found for link insertion');
    }
  }

  private openNote(result: SearchResult) {
    this.app.workspace.openLinkText(result.notePath, '', false);
  }

  private async copyToClipboard(result: SearchResult) {
    try {
      let textToCopy: string;
      let noticeMessage: string;

      if (result.type === 'chunk') {
        // For chunks: copy the chunk text
        textToCopy = result.text;
        noticeMessage = 'Chunk text copied to clipboard';
        logger.debug('SearchView', `Copied chunk text to clipboard: ${textToCopy.substring(0, 50)}...`);
      } else {
        // For notes: copy a markdown link
        textToCopy = `[[${result.notePath}|${result.noteName}]]`;
        noticeMessage = 'Note link copied to clipboard';
        logger.debug('SearchView', `Copied note link to clipboard: ${textToCopy}`);
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


export { RemembranceView, VIEW_TYPE };
