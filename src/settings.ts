import { suggestPrefixes } from './embedding_service';
import { LogLevel } from './logger';

export type SearchCadence = 'always' | 'sometimes' | 'occasionally';

export interface TezcatSettings {
    /** 0 = keyword search only; above 0 mixes in semantic matches; 1 = semantic only. */
    semanticWeight: number;
    /** Base URL of an OpenAI-compatible embeddings API (Ollama, LM Studio, llama.cpp, OpenAI, ...). */
    embeddingEndpoint: string;
    embeddingModel: string;
    /** Name of the secret in Obsidian's secret storage holding the API key; '' for none. */
    embeddingApiKeySecret: string;
    /** Instruction prefixes the model expects (see suggestPrefixes). */
    queryPrefix: string;
    documentPrefix: string;
    contextWindowWords: number;
    searchCadence: SearchCadence;
    logLevel: LogLevel;
    highlightBlockOnOpen: boolean;
    filterBoilerplate: boolean;
    filterCommonPhrasing: boolean;
    /** The last model semantic search started with successfully; the fallback if the configured one is missing. */
    lastWorkingModel: { model: string; queryPrefix: string; documentPrefix: string } | null;
}

export const DEFAULT_SETTINGS: TezcatSettings = {
    semanticWeight: 0,
    embeddingEndpoint: 'http://localhost:11434/v1',
    embeddingModel: 'nomic-embed-text:v1.5',
    embeddingApiKeySecret: '',
    queryPrefix: suggestPrefixes('nomic-embed-text').query,
    documentPrefix: suggestPrefixes('nomic-embed-text').document,
    contextWindowWords: 64, // Smaller context window for more focused search
    searchCadence: 'always',
    logLevel: LogLevel.ERROR,
    highlightBlockOnOpen: true,
    filterBoilerplate: true,
    filterCommonPhrasing: true,
    lastWorkingModel: null,
}

export type EmbeddingSettings = Pick<TezcatSettings, 'embeddingEndpoint' | 'embeddingModel' | 'embeddingApiKeySecret' | 'queryPrefix' | 'documentPrefix'>;

/** The vector space a configuration embeds into (matches EmbeddingService.space). */
export const vectorSpaceOf = (s: Pick<TezcatSettings, 'embeddingModel' | 'documentPrefix'>) => `${s.embeddingModel}|${s.documentPrefix}`;

/** Secret name used for an API key migrated from an earlier version's settings. */
export const MIGRATED_KEY_SECRET = 'tezcat-api-key';

/**
 * Settings from versions before 2.0 named a provider (Ollama or OpenAI). Map them onto the
 * OpenAI-compatible endpoint, and move a plain-text OpenAI key into Obsidian's secret storage.
 * Returns true if anything changed.
 */
export function migrateSettings(saved: Record<string, unknown>, storeSecret: (name: string, value: string) => void): boolean {
    if (!('embeddingProvider' in saved)) return false;
    const model = typeof saved.embeddingModel === 'string' ? saved.embeddingModel : DEFAULT_SETTINGS.embeddingModel;
    if (saved.embeddingProvider === 'openai') {
        saved.embeddingEndpoint = 'https://api.openai.com/v1';
        if (typeof saved.openaiApiKey === 'string' && saved.openaiApiKey) {
            storeSecret(MIGRATED_KEY_SECRET, saved.openaiApiKey);
            saved.embeddingApiKeySecret = MIGRATED_KEY_SECRET;
        }
    } else {
        const base = typeof saved.ollamaBaseUrl === 'string' && saved.ollamaBaseUrl ? saved.ollamaBaseUrl : 'http://localhost:11434';
        saved.embeddingEndpoint = `${base.replace(/\/+$/, '')}/v1`;
    }
    const prefixes = suggestPrefixes(model);
    saved.queryPrefix = prefixes.query;
    saved.documentPrefix = prefixes.document;
    for (const old of ['embeddingProvider', 'openaiApiKey', 'ollamaBaseUrl', 'searchMode', 'vectorSize', 'chunkSize', 'chunkOverlap']) {
        delete saved[old];
    }
    return true;
}
