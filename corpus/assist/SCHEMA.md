# Schema addendum: reports of other AI assistants

The second sample (pre-registered in [`PREREG-ASSISTANTS.md`](../../PREREG-ASSISTANTS.md)) holds reports of what people did with AI assistants **other than Claude**. Every rule of [`corpus/SCHEMA.md`](../SCHEMA.md) applies unchanged, including the phrasing rules for `text`: 15 to 35 words, present tense, starting with a verb, never naming the tool, the model, "AI", "LLM", "model" or "agent", never names or handles, no hype. The `title` follows the same rule about tool names, so a tagger who reads the title and text cannot tell which assistant was used.

Collectors write one JSON object per line to `corpus/assist/raw/<slice>.jsonl`, with `id` = `a-<slice>-NNN`. Five fields are added:

```json
{"id": "a-firmware-001", "title": "...", "text": "...", "domain": "devices-home", "source": "https://...", "who": "@handle", "date": "2025-04", "from_video": false, "confidence": "seen",
 "assistant": "chatgpt", "assistant_name": "ChatGPT (GPT-4o)", "model_family": "openai", "model_basis": "stated", "sampled_by": "material:consumer-device firmware or hardware"}
```

| field | rule |
|---|---|
| `assistant` | exactly one of `chatgpt` (any OpenAI chat product: ChatGPT, custom GPTs, ChatGPT agent, Operator, deep research), `codex` (OpenAI Codex: CLI, cloud, IDE extension, or the 2021 Codex model), `openai-api` (the reporter's own code calling OpenAI models), `gemini` (any Google Gemini product: app, CLI, AI Studio, API, Jules, NotebookLM), `github-copilot`, `microsoft-copilot` (Copilot app, Bing Chat, Microsoft 365 Copilot), `cursor`, `local-llm` (a model run on the reporter's own hardware: Ollama, llama.cpp, LM Studio, MLX, vLLM), `other` (any other non-Claude assistant: Perplexity, Grok, DeepSeek, Le Chat, Meta AI, Windsurf, Devin, Replit Agent, Lovable, v0, bolt, Aider or Cline with a non-Claude model, and so on). The one the report says did the work. |
| `assistant_name` | the product and model as the report names them, for example `"Gemini CLI (2.5 Pro)"`, `"Ollama, Qwen2.5-Coder 32B"`, `"Cursor (model not stated)"`. |
| `model_family` | the maker of the model that did the work: `openai`, `google`, `meta`, `mistral`, `alibaba`, `deepseek`, `xai`, `microsoft`, `moonshot`, `open-weights-unspecified` (a local model the report does not name), `other`, or `unknown`. Never `anthropic`: a report whose work was done by a Claude model is excluded, whatever product it ran in. |
| `model_basis` | `stated` if the report names the model or its maker; `product-default` if it does not, and the product **offered no Anthropic model at the report's date** (ChatGPT, Codex, the OpenAI API, every Gemini product, Grok, DeepSeek, Le Chat, Meta AI, consumer Microsoft Copilot and Bing Chat, and any local model); `unknown` otherwise (Cursor, Windsurf, Perplexity, Replit, Lovable, bolt, Aider, Cline, Amazon Q, Poe, and the like; GitHub Copilot from 2024-10-29; Microsoft 365 Copilot from 2025-09). With `unknown`, `model_family` is `unknown`. |
| `sampled_by` | the collector's slice: `move:<value>`, `material:<value>`, `for:<value>`, `assistant:<value>`, or `random:<route>`. One value, never a combination. |

## Exclusions

- The work was done with a Claude model, even inside a third-party product.
- The report compares assistants and no single non-Claude assistant did the work.
- The `source` URL is already in the Claude corpus (`corpus/raw/*.jsonl`) or in `corpus/sources_seen.txt`.
- No use is described (an announcement, a benchmark, an opinion, a product launch with no one using it).

## The primary analysis set

Items with `model_basis` of `stated` or `product-default`: the ones known to run a non-Anthropic model. Items with `unknown` are collected, tagged and drawn on the globe, and enter only the sensitivity analyses named in the pre-registration.
