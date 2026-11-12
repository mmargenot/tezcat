import { Editor, ItemView, WorkspaceLeaf, MarkdownView, Notice, Setting } from 'obsidian';
import type { SearchResult } from './search';
import { logger } from './logger';
import type Tezcat from './main';

const VIEW_TYPE = 'remembrance-search';

const PREVIEW_CHARS = 200;

class TezcatView extends ItemView {
  private resultsContainer!: HTMLElement;

  constructor(leaf: WorkspaceLeaf, private plugin: Tezcat) {
    super(leaf);
  }

  getViewType() {
    return VIEW_TYPE;
  }

  getDisplayText() {
    return 'Tezcat search';
  }

  getIcon() {
    return 'eye';
  }

  async onOpen() {
    const container = this.containerEl.children[1];
    container.empty();

    const header = container.createEl('div', { cls: 'tezcat-search-view-header' });
    new Setting(header).setHeading().setName('Tezcat search');

    this.resultsContainer = container.createEl('div', { cls: 'tezcat-search-results-container' });
    this.showEmptyState();
  }

  updateSearchResults(results: SearchResult[]) {
    this.resultsContainer.empty();
    if (results.length === 0) {
      this.showEmptyState();
      return;
    }
    this.resultsContainer.createEl('div', { cls: 'tezcat-search-count', text: `${results.length} results` });
    for (const result of results) this.createResultItem(result);
  }

  private showEmptyState() {
    const emptyEl = this.resultsContainer.createEl('div', { cls: 'tezcat-search-empty-state' });
    emptyEl.createEl('p', { text: 'Move your cursor around in a markdown file to see related content.' });
  }

  private createResultItem(result: SearchResult) {
    const itemEl = this.resultsContainer.createEl('div', { cls: 'tezcat-search-result-item' });

    itemEl.createEl('div', {
      cls: 'tezcat-search-result-text',
      text: result.text.length > PREVIEW_CHARS ? result.text.slice(0, PREVIEW_CHARS) + '…' : result.text,
    });

    const pathContainerEl = itemEl.createEl('div', { cls: 'tezcat-search-result-path-container' });
    pathContainerEl.createEl('div', { cls: 'tezcat-search-result-path', text: result.path });

    const actionsEl = itemEl.createEl('div', { cls: 'tezcat-search-result-actions' });
    const button = (text: string, onClick: () => void, cls?: string) => {
      actionsEl.createEl('button', { text, cls }).onclick = (e) => {
        e.stopPropagation();
        onClick();
      };
    };
    button('Insert text', () => this.insertAtCursor(result.text));
    button('Insert link', () => this.insertLink(result));
    button('Open', () => void this.openResult(result), 'mod-cta');

    // Click anywhere else on the result to copy its text
    itemEl.onclick = () => void this.copyToClipboard(result);
  }

  /** Insert into the editor the user was last working in (the panel itself has focus now). */
  private insertAtCursor(text: string) {
    // Inserting moves the cursor; don't let that trigger a new search right away.
    this.plugin.suppressSearchFor(2000);
    const editor = this.targetEditor()?.editor;
    if (editor) {
      editor.replaceSelection(text);
    } else {
      logger.warn('SearchView', 'No markdown editor to insert into');
    }
  }

  /** A link in the user's configured style (wikilink or Markdown, shortest path, etc.). */
  private insertLink(result: SearchResult) {
    const file = this.app.vault.getFileByPath(result.path);
    if (!file) return;
    const sourcePath = this.targetEditor()?.file?.path ?? '';
    this.insertAtCursor(this.app.fileManager.generateMarkdownLink(file, sourcePath));
  }

  private targetEditor(): MarkdownView | null {
    const leaf = this.app.workspace.getMostRecentLeaf();
    return leaf?.view instanceof MarkdownView ? leaf.view : null;
  }

  /** Open the note and select (or place the cursor at) the result's text. */
  private async openResult(result: SearchResult) {
    const file = this.app.vault.getFileByPath(result.path);
    if (!file) return;
    const leaf = this.app.workspace.getLeaf(false);
    await leaf.openFile(file);
    if (!(leaf.view instanceof MarkdownView)) return;
    const editor: Editor = leaf.view.editor;
    const from = { line: result.line, ch: 0 };
    const to = { line: result.endLine, ch: editor.getLine(result.endLine)?.length ?? 0 };
    if (this.plugin.settings.highlightBlockOnOpen) editor.setSelection(from, to);
    else editor.setCursor(from);
    editor.scrollIntoView({ from, to }, true);
    // Moving the cursor triggers a search around this text automatically.
  }

  private async copyToClipboard(result: SearchResult) {
    try {
      await navigator.clipboard.writeText(result.text);
      new Notice('Text copied to clipboard', 2000);
    } catch (error) {
      logger.error('SearchView', 'Failed to copy to clipboard', error);
      new Notice('Failed to copy to clipboard', 3000);
    }
  }
}

export { TezcatView, VIEW_TYPE };
