import { describe, it, expect, vi } from 'vitest';
import type { RequestUrlParam, RequestUrlResponse } from 'obsidian';
import { EmbeddingError, EmbeddingService, embeddingModels, sameModel, suggestPrefixes, type EmbeddingConfig } from '../src/embedding_service';

const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any;

const response = (status: number, json: unknown, headers: Record<string, string> = {}): RequestUrlResponse =>
    ({ status, json, text: JSON.stringify(json), headers, arrayBuffer: new ArrayBuffer(0) }) as RequestUrlResponse;

/** A fake server that embeds each input as [length, index-in-request]. */
const echoServer = () => vi.fn(async (req: RequestUrlParam) => {
    const { input } = JSON.parse(req.body as string) as { input: string[] };
    return response(200, { data: input.map((t, index) => ({ index, embedding: [t.length, index] })) });
});

const config = (over: Partial<EmbeddingConfig> = {}): EmbeddingConfig => ({
    endpoint: 'http://localhost:11434/v1/',
    model: 'nomic-embed-text',
    apiKey: null,
    prefixes: { query: 'search_query: ', document: 'search_document: ' },
    ...over,
});

const noWait = async () => {};

describe('suggestPrefixes', () => {
    it('knows models that need instruction prefixes', () => {
        expect(suggestPrefixes('nomic-embed-text:v1.5')).toEqual({ query: 'search_query: ', document: 'search_document: ' });
        expect(suggestPrefixes('intfloat/multilingual-e5-large').query).toBe('query: ');
        expect(suggestPrefixes('BAAI/bge-small-en-v1.5').document).toBe('');
    });

    it('suggests none for models that do not use them', () => {
        expect(suggestPrefixes('bge-m3')).toEqual({ query: '', document: '' });
        expect(suggestPrefixes('text-embedding-3-small')).toEqual({ query: '', document: '' });
    });
});

describe('EmbeddingService', () => {
    it('posts to {endpoint}/embeddings with the model, prefixes and key', async () => {
        const request = echoServer();
        const service = new EmbeddingService(config({ apiKey: 'sk-test' }), log, request, noWait);
        await service.embedQuery('raven');
        const [req] = request.mock.calls[0];
        expect(req.url).toBe('http://localhost:11434/v1/embeddings');
        expect(req.headers?.Authorization).toBe('Bearer sk-test');
        expect(JSON.parse(req.body as string)).toEqual({ model: 'nomic-embed-text', input: ['search_query: raven'] });
        await service.embedDocuments(['lenore']);
        expect(JSON.parse(request.mock.calls[1][0].body as string).input).toEqual(['search_document: lenore']);
    });

    it('sends no Authorization header without a key', async () => {
        const request = echoServer();
        await new EmbeddingService(config(), log, request, noWait).embedQuery('x');
        expect(request.mock.calls[0][0].headers).not.toHaveProperty('Authorization');
    });

    it('batches large inputs and keeps results in input order', async () => {
        const request = vi.fn(async (req: RequestUrlParam) => {
            const { input } = JSON.parse(req.body as string) as { input: string[] };
            const data = input.map((t, index) => ({ index, embedding: [Number(t.split(' ')[1])] }));
            return response(200, { data: data.reverse() }); // server returns them out of order
        });
        const service = new EmbeddingService(config({ prefixes: { query: '', document: '' } }), log, request, noWait);
        const texts = Array.from({ length: 70 }, (_, i) => `text ${i}`);
        const vectors = await service.embedDocuments(texts);
        expect(request).toHaveBeenCalledTimes(3); // 32 + 32 + 6
        expect(vectors.map((v) => v[0])).toEqual(texts.map((_, i) => i));
    });

    it('retries on rate limits and server errors, then gives up', async () => {
        const wait = vi.fn(async (_ms: number) => {});
        const flaky = vi.fn()
            .mockResolvedValueOnce(response(429, { error: 'slow down' }, { 'retry-after': '2' }))
            .mockResolvedValueOnce(response(503, { error: 'busy' }))
            .mockImplementation(echoServer());
        expect(await new EmbeddingService(config(), log, flaky, wait).embedQuery('x')).toHaveLength(2);
        expect(wait.mock.calls.map((c) => c[0])).toEqual([2000, 2000]);

        const down = vi.fn(async () => response(500, { error: 'boom' }));
        await expect(new EmbeddingService(config(), log, down, noWait).embedQuery('x')).rejects.toThrow(/HTTP 500/);
        expect(down).toHaveBeenCalledTimes(3);
    });

    it('explains common failures', async () => {
        const fail = (res: RequestUrlResponse | Error) => new EmbeddingService(config(), log,
            vi.fn(async () => { if (res instanceof Error) throw res; return res; }), noWait).check();

        await expect(fail(new Error('net::ERR_CONNECTION_REFUSED'))).rejects.toThrow(/Is the server running\?/);
        await expect(fail(response(401, { error: { message: 'bad key' } }))).rejects.toThrow(/rejected the API key.*bad key/);
        await expect(fail(response(404, { error: 'model "nomic-embed-text" not found, try pulling it first' })))
            .rejects.toThrow(/ollama pull nomic-embed-text/);
        await expect(fail(response(404, 'page not found'))).rejects.toThrow(/usually ends in \/v1/);
        await expect(fail(response(200, { data: [] }))).rejects.toBeInstanceOf(EmbeddingError);
    });

    it('classifies failures, so callers can tell a missing model from a down server', async () => {
        const reason = async (res: RequestUrlResponse | Error) => {
            const service = new EmbeddingService(config(), log, vi.fn(async () => { if (res instanceof Error) throw res; return res; }), noWait);
            return service.check().catch((e: EmbeddingError) => e.reason);
        };
        expect(await reason(new Error('ECONNREFUSED'))).toBe('unreachable');
        expect(await reason(response(401, {}))).toBe('unauthorized');
        expect(await reason(response(404, { error: 'model "foo" not found, try pulling it first' }))).toBe('model-not-found'); // Ollama
        expect(await reason(response(404, { error: { message: 'The model `foo` does not exist' } }))).toBe('model-not-found'); // OpenAI
        expect(await reason(response(400, { error: 'unknown model: foo' }))).toBe('model-not-found');
        expect(await reason(response(404, 'Not Found'))).toBe('no-endpoint');
        expect(await reason(response(400, { error: 'input too long' }))).toBe('other');
    });

    it('does not retry when the server cannot be reached', async () => {
        const request = vi.fn(async () => { throw new Error('ECONNREFUSED'); });
        await expect(new EmbeddingService(config(), log, request, noWait).check()).rejects.toThrow(EmbeddingError);
        expect(request).toHaveBeenCalledTimes(1);
    });

    it('reports dimensions from a connection check', async () => {
        const result = await new EmbeddingService(config(), log, echoServer(), noWait).check();
        expect(result.dimensions).toBe(2);
    });

    it('identifies the vector space by model and document prefix, not endpoint', () => {
        const a = new EmbeddingService(config(), log);
        expect(new EmbeddingService(config({ endpoint: 'http://127.0.0.1:11434/v1' }), log).space).toBe(a.space);
        expect(new EmbeddingService(config({ model: 'bge-m3' }), log).space).not.toBe(a.space);
        expect(new EmbeddingService(config({ prefixes: { query: '', document: '' } }), log).space).not.toBe(a.space);
    });
});

describe('model lists', () => {
    it('lists the server\'s models from {endpoint}/models', async () => {
        const request = vi.fn(async (_req: RequestUrlParam) => response(200, { data: [{ id: 'bge-m3:latest' }, { id: 'llama3:8b' }] }));
        const ids = await new EmbeddingService(config({ apiKey: 'k' }), log, request, noWait).listModels();
        expect(ids).toEqual(['bge-m3:latest', 'llama3:8b']);
        expect(request.mock.calls[0][0]).toMatchObject({ url: 'http://localhost:11434/v1/models', method: 'GET' });
        expect(request.mock.calls[0][0].headers?.Authorization).toBe('Bearer k');
    });

    it('explains why the list could not be fetched', async () => {
        const down = vi.fn(async () => { throw new Error('ECONNREFUSED'); });
        await expect(new EmbeddingService(config(), log, down, noWait).listModels()).rejects.toThrow(/Is the server running/);
    });

    it('picks out embedding models by name, or keeps everything if none match', () => {
        expect(embeddingModels(['llama3:8b', 'nomic-embed-text:v1.5', 'bge-m3:latest', 'qwen2.5:7b', 'text-embedding-3-small', 'gpt-4o']))
            .toEqual(['bge-m3:latest', 'nomic-embed-text:v1.5', 'text-embedding-3-small']);
        expect(embeddingModels(['zeta', 'alpha'])).toEqual(['alpha', 'zeta']);
    });

    it('treats an Ollama ":latest" tag as the same model, including for the vector space', () => {
        expect(sameModel('bge-m3', 'bge-m3:latest')).toBe(true);
        expect(sameModel('bge-m3', 'bge-m3:567m')).toBe(false);
        const a = new EmbeddingService(config({ model: 'bge-m3' }), log);
        expect(new EmbeddingService(config({ model: 'bge-m3:latest' }), log).space).toBe(a.space);
    });
});
