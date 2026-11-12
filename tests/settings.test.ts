import { describe, it, expect, vi } from 'vitest';
import { EmbeddingService } from '../src/embedding_service';
import { DEFAULT_SETTINGS, MIGRATED_KEY_SECRET, migrateSettings, vectorSpaceOf } from '../src/settings';

describe('migrateSettings', () => {
    it('maps v1 Ollama settings onto the OpenAI-compatible endpoint', () => {
        const saved: Record<string, unknown> = {
            embeddingProvider: 'ollama', ollamaBaseUrl: 'http://192.168.1.5:11434/', embeddingModel: 'nomic-embed-text:v1.5',
            openaiApiKey: '', searchMode: 'hybrid', vectorSize: 768, chunkSize: 128, chunkOverlap: 16, searchCadence: 'sometimes',
        };
        const storeSecret = vi.fn();
        expect(migrateSettings(saved, storeSecret)).toBe(true);
        expect(saved).toEqual({
            embeddingEndpoint: 'http://192.168.1.5:11434/v1',
            embeddingModel: 'nomic-embed-text:v1.5',
            queryPrefix: 'search_query: ',
            documentPrefix: 'search_document: ',
            searchCadence: 'sometimes', // unrelated settings are kept
        });
        expect(storeSecret).not.toHaveBeenCalled();
    });

    it('moves a v1 OpenAI key into secret storage and out of the settings', () => {
        const saved: Record<string, unknown> = { embeddingProvider: 'openai', embeddingModel: 'text-embedding-3-small', openaiApiKey: 'sk-secret' };
        const storeSecret = vi.fn();
        migrateSettings(saved, storeSecret);
        expect(storeSecret).toHaveBeenCalledWith(MIGRATED_KEY_SECRET, 'sk-secret');
        expect(saved).toMatchObject({ embeddingEndpoint: 'https://api.openai.com/v1', embeddingApiKeySecret: MIGRATED_KEY_SECRET, queryPrefix: '', documentPrefix: '' });
        expect(JSON.stringify(saved)).not.toContain('sk-secret');
    });

    it('uses Ollama defaults when v1 settings left them empty', () => {
        const saved: Record<string, unknown> = { embeddingProvider: 'ollama' };
        migrateSettings(saved, vi.fn());
        expect(saved.embeddingEndpoint).toBe('http://localhost:11434/v1');
        expect(saved.embeddingModel).toBeUndefined(); // the default model applies
    });

    it('leaves current settings alone', () => {
        const saved: Record<string, unknown> = { embeddingEndpoint: 'http://localhost:1234/v1', embeddingModel: 'bge-m3' };
        expect(migrateSettings(saved, vi.fn())).toBe(false);
        expect(saved).toEqual({ embeddingEndpoint: 'http://localhost:1234/v1', embeddingModel: 'bge-m3' });
    });
});

describe('DEFAULT_SETTINGS', () => {
    it('defaults to keyword search, with semantic settings ready for a local Ollama', () => {
        expect(DEFAULT_SETTINGS.semanticWeight).toBe(0);
        expect(DEFAULT_SETTINGS.embeddingEndpoint).toBe('http://localhost:11434/v1');
        expect(DEFAULT_SETTINGS.documentPrefix).toBe('search_document: ');
    });

    it('identifies the vector space exactly as the embedding service does', () => {
        const settings = { ...DEFAULT_SETTINGS, embeddingModel: 'bge-m3', documentPrefix: 'doc: ' };
        const service = new EmbeddingService({ endpoint: settings.embeddingEndpoint, model: settings.embeddingModel, apiKey: null,
            prefixes: { query: settings.queryPrefix, document: settings.documentPrefix } }, { debug() {} } as any);
        expect(vectorSpaceOf(settings)).toBe(service.space);
    });
});
