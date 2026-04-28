# Findings

## Initial Notes
- User wants the bot to stay attentive throughout the meeting and answer company-related questions quickly and flexibly.
- Existing live test showed the bot can join Meet, enable captions, and speak.

## Voice Assistant Flow
- `bot/src/voiceAssistant/index.ts` receives every caption but currently suppresses or ignores most captions unless the wake word is detected.
- `QuestionAccumulator` captures same-speaker caption rows after wake word and settles after `VA_SETTLE_MS`.
- `answerer.ts` already supports OpenAI streaming into sentence chunks, which is good for latency.
- `brain.ts` loads the whole `.docx`/text file as one string. There is no retrieval or meeting context yet.
- The answer prompt is conservative and refuses anything absent from `<brain>`, which can make replies feel basic.

## Implemented Changes
- Brain loading now creates chunks and performs local lexical retrieval per question.
- Answering now receives company snippets, recent meeting captions, relevant earlier captions, extracted fact-like captions, and the previous bot answer.
- The assistant observes all human captions, even when no wake word is present, so it has context when invoked.
- After a bot answer, the same speaker can ask a short follow-up within a limited window without repeating the wake word.
