import { requestUrl, type RequestUrlParam, type RequestUrlResponse } from 'obsidian';
import type { Logger } from './logger';

export type EmbedKind = 'query' | 'document';

export interface Prefixes {
	query: string;
	document: string;
}

/**
 * Instruction prefixes some embedding models are trained with. Leaving them out noticeably
 * lowers retrieval quality (nomic-embed-text, for example, expects them).
 */
const KNOWN_PREFIXES: [RegExp, Prefixes][] = [
	[/nomic-embed/i, { query: 'search_query: ', document: 'search_document: ' }],
	[/embeddinggemma/i, { query: 'task: search result | query: ', document: 'title: none | text: ' }],
	// Qwen3-Embedding: an instruction on queries only (format from the model card).
	[/qwen3-embedding/i, { query: 'Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery:', document: '' }],
	[/(^|[/:-])(multilingual-)?e5-/i, { query: 'query: ', document: 'passage: ' }],
	[/bge-(small|base|large)-en|mxbai-embed|snowflake-arctic-embed/i,
		{ query: 'Represent this sentence for searching relevant passages: ', document: '' }],
];

/** Prefixes recommended for a model (empty for models that don't use them, e.g. bge-m3). */
export function suggestPrefixes(model: string): Prefixes {
	return KNOWN_PREFIXES.find(([re]) => re.test(model))?.[1] ?? { query: '', document: '' };
}

/** Ollama treats "name" and "name:latest" as the same model. */
export const sameModel = (a: string, b: string) => modelKey(a) === modelKey(b);
const modelKey = (model: string) => model.trim().replace(/:latest$/, '');

/** Name patterns of common embedding model families (servers don't say which models embed). */
const EMBEDDING_MODEL_NAME = /embed|bge|(^|[/_:-])e5-|gte|minilm|mpnet|nomic|mxbai|arctic|jina|sentence|instructor/i;

/**
 * The embedding models among a server's models, by name. Servers like Ollama list chat
 * models too; if no name looks like an embedding model, all are returned.
 */
export function embeddingModels(ids: string[]): string[] {
	const likely = ids.filter((id) => EMBEDDING_MODEL_NAME.test(id));
	return (likely.length ? likely : ids).slice().sort((a, b) => a.localeCompare(b));
}

/**
 * Embedding models worth having on an Ollama server, offered for download together. The 0.6B
 * Qwen3 variant is used because the untagged name is the 8B model (4.7 GB).
 */
export const RECOMMENDED_OLLAMA_MODELS: { name: string; size: string }[] = [
	{ name: 'bge-m3', size: '1.2 GB' },
	{ name: 'nomic-embed-text:v1.5', size: '274 MB' },
	{ name: 'qwen3-embedding:0.6b', size: '639 MB' },
];

export interface EmbeddingConfig {
	/** Base URL of an OpenAI-compatible API, e.g. http://localhost:11434/v1 */
	endpoint: string;
	model: string;
	apiKey: string | null;
	prefixes: Prefixes;
}

export type EmbeddingFailure = 'unreachable' | 'unauthorized' | 'model-not-found' | 'no-endpoint' | 'other';

/**
 * Identifies a vector space: vectors are only comparable when produced by the same model with
 * the same document prefix. (Not the endpoint: the same model served elsewhere produces the
 * same vectors.)
 */
export const vectorSpace = (model: string, documentPrefix: string) => `${modelKey(model)}|${documentPrefix}`;

export class EmbeddingError extends Error {
	constructor(readonly reason: EmbeddingFailure, message: string) {
		super(message);
	}
}

export type Request = (params: RequestUrlParam) => Promise<RequestUrlResponse>;

const BATCH_SIZE = 32;
/** Guard so one huge block can't exceed a model's context (roughly 4 characters per token). */
const MAX_CHARS = 6000;
const MAX_ATTEMPTS = 3;

/**
 * Embeddings from any server with an OpenAI-compatible API (POST {endpoint}/embeddings):
 * Ollama, LM Studio, llama.cpp, LocalAI, vLLM, OpenAI and others.
 */
export class EmbeddingService {
	private readonly url: string;
	private readonly base: string;

	constructor(
		readonly config: EmbeddingConfig,
		private log: Logger,
		private request: Request = (params) => requestUrl(params),
		private wait: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
	) {
		this.base = config.endpoint.trim().replace(/\/+$/, '');
		this.url = `${this.base}/embeddings`;
	}

	/** This configuration's vector space (see vectorSpace). */
	get space(): string {
		return vectorSpace(this.config.model, this.config.prefixes.document);
	}

	/** Model ids the server offers (GET {endpoint}/models). */
	async listModels(): Promise<string[]> {
		let res: RequestUrlResponse;
		try {
			res = await this.request({ url: `${this.base}/models`, method: 'GET', headers: this.headers(), throw: false });
		} catch (e) {
			throw new EmbeddingError('unreachable', `Could not connect to ${this.base}. Is the server running? (${(e as Error).message})`);
		}
		if (res.status !== 200) throw this.failure(res);
		const data = (res.json as { data?: { id?: unknown }[] } | undefined)?.data;
		if (!Array.isArray(data)) throw new EmbeddingError('other', `Unexpected response from ${this.base}/models`);
		return data.map((m) => m.id).filter((id): id is string => typeof id === 'string');
	}

	/** Ollama's native API sits beside its OpenAI-compatible one: the endpoint without /v1. */
	private get ollamaBase(): string {
		return this.base.replace(/\/v1$/, '');
	}

	/** Whether the endpoint is an Ollama server (it answers Ollama's /api/version). */
	async isOllama(): Promise<boolean> {
		try {
			const res = await this.request({ url: `${this.ollamaBase}/api/version`, method: 'GET', throw: false });
			return res.status === 200 && typeof (res.json as { version?: unknown } | undefined)?.version === 'string';
		} catch {
			return false;
		}
	}

	/** Download a model onto an Ollama server. Resolves when the download has finished. */
	async pullOllamaModel(model: string): Promise<void> {
		let res: RequestUrlResponse;
		try {
			res = await this.request({
				url: `${this.ollamaBase}/api/pull`, method: 'POST', headers: this.headers(),
				body: JSON.stringify({ model, stream: false }), throw: false,
			});
		} catch (e) {
			throw new EmbeddingError('unreachable', `Could not connect to ${this.ollamaBase}. Is Ollama running? (${(e as Error).message})`);
		}
		const status = (res.json as { status?: string } | undefined)?.status;
		if (res.status !== 200 || status !== 'success') throw this.failure(res);
	}

	private headers(): Record<string, string> {
		const headers: Record<string, string> = { 'Content-Type': 'application/json' };
		if (this.config.apiKey) headers.Authorization = `Bearer ${this.config.apiKey}`;
		return headers;
	}

	async embedQuery(text: string): Promise<number[]> {
		return (await this.embed([text], 'query'))[0];
	}

	embedDocuments(texts: string[]): Promise<number[][]> {
		return this.embed(texts, 'document');
	}

	/** Embed a short text to confirm the endpoint, model and key work. */
	async check(): Promise<{ dimensions: number; ms: number }> {
		const started = Date.now();
		const [vector] = await this.embed(['Tezcat connection check'], 'document');
		return { dimensions: vector.length, ms: Date.now() - started };
	}

	private async embed(texts: string[], kind: EmbedKind): Promise<number[][]> {
		const prefix = this.config.prefixes[kind];
		const out: number[][] = [];
		for (let i = 0; i < texts.length; i += BATCH_SIZE) {
			out.push(...await this.post(texts.slice(i, i + BATCH_SIZE).map((t) => prefix + t.slice(0, MAX_CHARS))));
		}
		return out;
	}

	private async post(input: string[]): Promise<number[][]> {
		const headers = this.headers();
		const body = JSON.stringify({ model: this.config.model, input });

		for (let attempt = 1; ; attempt++) {
			let res: RequestUrlResponse;
			try {
				res = await this.request({ url: this.url, method: 'POST', headers, body, throw: false });
			} catch (e) {
				// Network-level failure (server not running, wrong host): retrying won't help.
				throw new EmbeddingError('unreachable', `Could not connect to ${this.url}. Is the server running? (${(e as Error).message})`);
			}
			const retryable = res.status === 429 || res.status >= 500;
			if (retryable && attempt < MAX_ATTEMPTS) {
				const retryAfter = Number(res.headers?.['retry-after']);
				const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** (attempt - 1);
				this.log.debug('Embeddings', `HTTP ${res.status}; retrying in ${delay} ms`);
				await this.wait(delay);
				continue;
			}
			if (res.status !== 200) throw this.failure(res);

			const data = (res.json as { data?: { index?: number; embedding?: number[] }[] } | undefined)?.data;
			if (!Array.isArray(data) || data.length !== input.length || data.some((d) => !Array.isArray(d.embedding))) {
				throw new EmbeddingError('other', `Unexpected response from ${this.url}: expected ${input.length} embeddings`);
			}
			// Items carry their position; don't rely on the order they arrive in.
			return [...data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0)).map((d) => d.embedding!);
		}
	}

	private failure(res: RequestUrlResponse): EmbeddingError {
		let detail = '';
		try {
			const json = res.json as { error?: { message?: string } | string } | undefined;
			detail = typeof json?.error === 'string' ? json.error : json?.error?.message ?? '';
		} catch { /* not JSON */ }
		detail ||= String(res.text ?? '').slice(0, 200);
		const { model } = this.config;
		if (res.status === 401 || res.status === 403) {
			return new EmbeddingError('unauthorized', `The server rejected the API key (HTTP ${res.status}). ${detail}`.trim());
		}
		// Ollama: 404 "model ... not found, try pulling it first"; OpenAI: 404 "The model ... does
		// not exist"; some servers use 400.
		if ((res.status === 404 || res.status === 400) && /model/i.test(detail) && /not found|does not exist|unknown|no such/i.test(detail)) {
			return new EmbeddingError('model-not-found', `Model "${model}" isn't available on this server (with Ollama: ollama pull ${model}). ${detail}`.trim());
		}
		if (res.status === 404) {
			return new EmbeddingError('no-endpoint', `No embeddings API at ${this.url} (HTTP 404). Check the endpoint URL; it usually ends in /v1.`);
		}
		return new EmbeddingError('other', `${this.url} returned HTTP ${res.status}. ${detail}`.trim());
	}
}
