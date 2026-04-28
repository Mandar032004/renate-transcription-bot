# Progress

## 2026-04-27
- Started implementation pass for conversational meeting assistant upgrades.
- Created planning files.
- Inspected the existing voice assistant modules. Found streaming is already present; missing pieces are meeting memory, retrieval, and richer prompt context.
- Implemented `meetingMemory.ts`, chunked brain retrieval, context-aware answering, and follow-up handling.
- Verification passed: `npm run typecheck --workspace @renate/bot`, `npm run typecheck`, `npm run build --workspace @renate/bot`, and `docker compose build bot`.
- Added barge-in behavior: human "stop" aborts playback, and human questions during bot speech interrupt the current answer and start a new capture.
- Tightened answer style prompt to be warmer but more grounded and less salesy.

## 2026-04-28
- User feedback after live test: bot speaks before speaker finishes; sometimes "hallucinates"; should be interruptible at any point; should never go blank on company facts; should sound more human. Latency is good — preserve it.
- Plan accepted: (1) adaptive settle (base 800ms, ~500ms after terminal punctuation, ~1100ms mid-clause); (2) send entire brain to LLM, drop temp to 0.1, tighten grounding rules; (3) any human caption mid-reply triggers barge-in; broaden stop words; (4) new persona prompt with worked examples; (5) replace brain.docx with brain.md combining old product copy + new company facts pasted by user.
- Pronunciation override added: `Renate` rewritten to `Ren-ate` at TTS layer (env `TTS_RENATE_PRONUNCIATION`), so Sarvam pronounces the brand as "ren-ATE" not "re-na-te".
- FAQ semantic cache added (`bot/src/voiceAssistant/answerCache.ts`). 8 seed FAQs in `brain-faqs.json` (about, founder, pricing, screening, voice interview, comparison, fundraise, contact). Pre-synthesizes WAVs and embeds variants at boot via `text-embedding-3-small`. On a hit (cosine ≥ 0.78), plays the cached WAV directly — no LLM, no runtime Sarvam call. Misses fall through to existing LLM stream path.
- Cache removed the same day. OpenAI account hit `insufficient_quota` 429 at first boot, blocking both embeddings and completions. User asked to drop the cache for now and revisit later. Reverted: deleted `answerCache.ts` and `brain-faqs.json`, removed `BRAIN_FAQS_PATH`/`VA_CACHE_THRESHOLD`/`OPENAI_EMBEDDING_MODEL` config, removed `BRAIN_FAQS_HOST_PATH` worker env, removed FAQ mount from compose. Bot is back to pre-cache state with all the other 2026-04-28 conversational improvements intact.
