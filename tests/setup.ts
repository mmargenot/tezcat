/**
 * Vitest setup file for test environment configuration
 */

import { vi } from 'vitest';

// Mock the obsidian module globally
vi.mock('obsidian', () => ({
  Notice: vi.fn().mockImplementation((message: string, duration?: number) => ({
    setMessage: vi.fn(),
    hide: vi.fn()
  })),
  
  Plugin: vi.fn().mockImplementation((app: any, manifest: any) => ({
    app,
    manifest,
    addCommand: vi.fn(),
    addSettingTab: vi.fn(),
    registerEvent: vi.fn(),
    registerInterval: vi.fn(),
    loadData: vi.fn().mockResolvedValue({}),
    saveData: vi.fn().mockResolvedValue(undefined)
  })),
  
  Modal: vi.fn().mockImplementation((app: any) => ({
    app,
    contentEl: {
      empty: vi.fn(),
      createEl: vi.fn().mockReturnValue({
        createEl: vi.fn().mockReturnValue({}),
        createDiv: vi.fn().mockReturnValue({}),
        style: {},
        onclick: null,
        textContent: '',
        innerHTML: ''
      }),
      createDiv: vi.fn().mockReturnValue({
        createEl: vi.fn().mockReturnValue({}),
        style: {},
        innerHTML: ''
      })
    },
    open: vi.fn(),
    close: vi.fn()
  })),
  
  ItemView: vi.fn(),
  MarkdownView: vi.fn(),
  WorkspaceLeaf: vi.fn(),
  Editor: vi.fn(),
  App: vi.fn(),
  PluginSettingTab: vi.fn(),
  Setting: vi.fn()
}));