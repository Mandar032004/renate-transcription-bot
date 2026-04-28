# Task Plan: Conversational Meeting Assistant

## Goal
Make the Meet bot more conversational and attentive by improving live context memory, company-knowledge retrieval, question capture, and faster streamed answering without changing the whole product architecture.

## Phases

| Phase | Status | Notes |
|---|---|---|
| 1. Inspect current VA flow | complete | Existing streaming is present; no meeting memory/retrieval. |
| 2. Design scoped implementation | complete | Local lexical retrieval + in-memory meeting context; no new services. |
| 3. Implement meeting memory + better brain retrieval | complete | Added chunked brain retrieval and rolling meeting memory. |
| 4. Improve question detection and answer prompting | complete | Added context-aware prompt and same-speaker follow-up handling. |
| 5. Verify | complete | Bot and repo typechecks passed; bot workspace and Docker image build passed. |

## Decisions
- Keep the existing wake-word architecture for now, but make it context-aware and faster.
- Avoid adding external vector DB/dependency in this pass; implement local lexical retrieval first.
- Same-speaker follow-ups are accepted only within a short post-answer window to avoid random interruptions.
- During `SPEAKING` and `THINKING`, human stop/question captions are now allowed through as interruption controls.

## Errors Encountered
| Error | Attempt | Resolution |
|---|---|---|
| Initial targeted patch to `answerer.ts` failed due to encoding-sensitive prompt text | 1 | Replaced the file cleanly with ASCII prompt text and preserved behavior. |
