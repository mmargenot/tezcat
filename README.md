# `tezcat`

Tezcat is a [remembrance agent](https://www.bradleyrhodes.com/Papers/remembrance.html) for Obsidian. As you write, it shows passages from elsewhere in your vault that relate to what's around your cursor, so you can link, quote or revisit them without searching.

![Searching Edgar Allan Poe's corpus](./assets/tezcat_search_3.gif)

It works out of the box: keyword search needs no setup and no network. Semantic search, which finds related passages even when they use different words, is optional and uses an embedding model you choose, running locally or as a hosted service.

## Using it

Open the panel from the eye icon in the ribbon or the **Tezcat: Open panel** command. Results update as you type or move the cursor. Each result is a passage with the note it comes from:

- **Insert text** puts the passage at your cursor.
- **Insert link** inserts a link to the note, in the link format you've set in Obsidian.
- **Open** opens the note and selects the passage.
- Clicking elsewhere on a result copies its text.

The note you're editing is never shown in its own results, and at most two passages come from any one note.

## How search works

- **Keyword search (default).** Passages are ranked with BM25, the ranking used by most search engines, over the words around your cursor. It runs entirely inside Obsidian and needs nothing else.
- **Semantic search (optional).** Move the **Semantic search** slider in settings above 0 to blend in matches by meaning, using an embedding model. At 1, results are semantic only. If the embedding server is unavailable, Tezcat falls back to keyword results and the status bar says why.

Two filters, both on by default, keep repeated material out of results:

- **Filter detected boilerplate** hides passages repeated across five or more notes, such as templated headers and bylines, and shows any other repeated passage once.
- **Filter common phrasing** hides passages made only of words that are common across your vault (for vaults of 20 or more notes).

## Setting up semantic search

Tezcat works with any server that offers an OpenAI-compatible embeddings API. In settings, set the **Endpoint URL** and pick a **Model**; the model list comes from the server.

| Server | Endpoint URL | Notes |
|---|---|---|
| [Ollama](https://ollama.com/download) (default) | `http://localhost:11434/v1` | Runs locally. Settings offer to download recommended models (bge-m3, nomic-embed-text, qwen3-embedding:0.6b), or run `ollama pull <model>`. |
| [LM Studio](https://lmstudio.ai) | `http://localhost:1234/v1` | Runs locally. Download an embedding model in LM Studio and start its server. |
| llama.cpp server | `http://localhost:8080/v1` | Runs locally. Start it with an embedding model and `--embeddings`. |
| [OpenRouter](https://openrouter.ai) | `https://openrouter.ai/api/v1` | Hosted; needs an API key and is paid per use. |
| [OpenAI](https://platform.openai.com) | `https://api.openai.com/v1` | Hosted; needs an API key and is paid per use. |

- **API keys** are stored in Obsidian's secret storage, not in the plugin's settings file. Local servers don't need one.
- **Instruction prefixes** that some models expect (for example nomic-embed-text's `search_query:` / `search_document:`) are filled in automatically for known models. They're under **Advanced** if you need to change them.
- **Switching models** embeds your vault again with the new model. Vectors for the previous model are kept, so switching back is instant. If the configured model isn't available on the server, Tezcat uses the last model that worked and shows a warning under **Model**.
- **Test connection** embeds a short text and reports the result.
- **On mobile**, `localhost` is the phone itself, so a server running on your computer isn't reachable at `http://localhost:...`. Use your computer's network address (e.g. `http://192.168.1.5:11434/v1`, with the server set to accept network connections) or a hosted service. Keyword search works on mobile with no setup.

## Privacy and network use

- **Keyword search uses no network.** With the semantic slider at 0 (the default), Tezcat makes no network requests.
- **Semantic search sends text to the endpoint you configure:** the text of each passage in your vault when it's indexed or changes, and the text around your cursor when you search. With a local server (Ollama, LM Studio, llama.cpp) this stays on your machine. With a hosted service (OpenRouter, OpenAI), that text is sent to the service and you are charged for it under its terms; the whole vault is embedded once, then only changes.
- **Model downloads happen only when you click Download** in settings, from Ollama's model registry via your Ollama server.
- **The index is stored on each device** in Obsidian's app storage (IndexedDB), not in your vault, so sync tools don't copy it. It holds the positions of passages, a keyword index and word lists derived from your notes, and vectors; it can be rebuilt at any time with **Tezcat: Rebuild index**.
- Tezcat collects no telemetry.

## Commands

- **Open panel**
- **Search notes**: search with your own query instead of the cursor context.
- **Update index**: index new and changed notes now (normally automatic).
- **Rebuild index**: discard the index and build it again.
- **Show index status**: index size and semantic search status. Clicking the status bar icon shows the same.

## Upgrading from 1.x

- Tezcat 2.0 requires Obsidian 1.11.4 or later, and now also runs on mobile.
- Your settings carry over. An Ollama setup becomes the endpoint `http://localhost:11434/v1` with the same model; an OpenAI key moves into Obsidian's secret storage.
- Search starts in keyword-only mode. Move the **Semantic search** slider above 0 to use your embedding model again; blocks are embedded once more.
- The old database file (`tezcat.db` in the plugin folder) is deleted, and the index is rebuilt on first launch.
- Models are no longer downloaded automatically. Use the Download button in settings or `ollama pull <model>`.

## Troubleshooting

- The status bar icon shows what Tezcat is doing (`○` working, `✓` ready, `!` a problem); hover or click it for details. On mobile, where there's no status bar, use **Tezcat: Show index status**.
- If semantic search is unavailable, check that the server is running and use **Test connection**. Messages name the cause, such as an unreachable server, a missing model or a rejected key.
- If results look wrong, run **Tezcat: Rebuild index**.
- For more detail, set **Log level** to DEBUG under **Maintenance** and open the developer console (Cmd+Opt+I / Ctrl+Shift+I).

## Development

1. Clone the repository into `your_vault/.obsidian/plugins/tezcat`.
2. `npm install`
3. `npm run dev` to rebuild on changes, or `npm run build` for a production build.
4. `npm test` to run the tests.
5. Enable the plugin in Obsidian's settings.

See [CONTRIBUTING.md](CONTRIBUTING.md) for reporting issues and contributing changes.
