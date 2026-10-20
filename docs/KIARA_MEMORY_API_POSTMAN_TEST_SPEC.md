# Kiara Memory API & Postman Test Specification

## 1. Environment

- Backend URL
  - Default local dev value: http://localhost:4000
  - Frontend resolves this via VITE_API_URL or a local default in the app config
- Auth requirements
  - The working-memory routes are protected by auth middleware
  - Requests must include a valid JWT bearer token
  - The authenticated user must match the requested userId
- Required env flags / runtime features
  - Redis enabled
  - MongoDB enabled for backup persistence
  - Optional: Pinecone and promotion worker enabled for semantic promotion
  - Optional: Gemini API key enabled for live memory / embedding / analyzer flows

Base headers for Postman:
- Authorization: Bearer <jwt_token>
- Content-Type: application/json

---

## 2. Test User

- userId: user_kiara_test_001
- sessionId: session_kiara_test_001
- conversationId: conv_kiara_test_001

Use one user for all write and isolation tests unless a separate user is explicitly required.

---

## 3. Dummy Memory Dataset

Identity:
- "My name is Roshan"

Preference:
- "I prefer dark themes"

Goal:
- "My goal is to build Kiara AI"

Project:
- "I am working on Kiara desktop automation"

Fact:
- "Kiara uses Redis and MongoDB"

Episode:
- "Yesterday I tested Notepad automation"

These are representative canonical memory entries designed to validate:
- identity resolution
- preference tracking
- project tracking
- fact grounding
- semantic memory extraction
- deduplication and recency behavior

---

## 4. WRITE ROUTES

### POST /api/working-memory/save

Purpose:
- Save a paired user-message + assistant-response turn
- Persist to Redis as working memory
- Attempt Mongo backup
- Trigger semantic extraction/promotion pipeline

Request:
POST {{baseUrl}}/api/working-memory/save
Headers:
- Authorization: Bearer {{token}}
- Content-Type: application/json

Body:
{
  "userId": "user_kiara_test_001",
  "sessionId": "session_kiara_test_001",
  "conversationId": "conv_kiara_test_001",
  "userMessage": "My name is Roshan",
  "aiResponse": "Nice to meet you, Roshan. I will remember that."
}

Expected response:
- HTTP 200 or 201 depending on implementation
- JSON success payload containing:
  - success: true
  - turnId or similar generated ID
  - counts or totals
  - any returned message metadata

Expected Redis state:
- A working-memory entry exists under the user-scoped Redis key
- The Redis key pattern is effectively:
  - memory:working:<userId>
- The stored entry should include the user/assistant text pair and timestamp
- Redis serialization is expected to include fields like:
  - T:<timestamp>
  - U:<user message>
  - K:<assistant response>

Expected Mongo state:
- If Mongo is connected, a ConversationTurn document is saved as backup
- Stored fields should include userId, sessionId, userMessage, assistantResponse, and timestamp metadata

Expected semantic state:
- Semantic memory extraction is attempted inline
- Redis semantic memory is updated under a user-specific semantic key
- Example pattern:
  - memory:longterm:semantic:<userId>

Expected promotion queue state:
- The promotion queue may be enqueued after the working-memory save
- Queue semantics should be user-scoped and non-blocking on save success
- Example key pattern:
  - memory:promotion:user:<userId>
  - memory:promotion:queue

Important validation:
- Save should succeed even if later semantic extraction or promotion fails
- The core turn save is the primary durable write path

---

### GET /api/working-memory/context

Purpose:
- Retrieve the current memory context for a user
- Used for prompt assembly or retrieval into the AI runtime

Request:
GET {{baseUrl}}/api/working-memory/context?userId=user_kiara_test_001
Headers:
- Authorization: Bearer {{token}}

Expected memories:
- Returns recent working memory and/or semantic memory relevant to the user
- Memory should include recent user/assistant turns and relevant extracted knowledge
- Results should be ordered by recency / relevance depending on retrieval strategy

Expected ordering:
- Most recent successful turns should appear first
- Relevance may be boosted for identity/contextual facts
- Duplicate or near-duplicate memory entries should be filtered

Expected user isolation:
- User A’s context must never include User B’s memory
- If userId is not authenticated or mismatched, request should fail

---

### DELETE /api/working-memory/wipe

Purpose:
- Clear working memory for a specific user

Request:
DELETE {{baseUrl}}/api/working-memory/wipe?userId=user_kiara_test_001
Headers:
- Authorization: Bearer {{token}}

Expected deletion:
- Redis working-memory state is removed or reset for the target user
- Semantic memory and associated queue states may be cleared or reset depending on implementation
- A success response should indicate deletion completed

Expected verification:
- A follow-up GET /api/working-memory/context should return empty or minimal context for that user
- No memory from that user should remain in the active Redis memory scope

---

## 5. LIVE MEMORY READ

### POST /api/live/token

Purpose:
- Request Gemini live token
- Memory should be injected into the prompt context before live session creation

Query example:
- "Mera naam kya hai?"
Expected:
- Response should reflect that the user identity is Roshan

Query example:
- "Main kis project par kaam kar raha hoon?"
Expected:
- Response should reflect that the user is working on Kiara desktop automation

Live-memory validation behavior:
- The query should reuse memory gathered from earlier save calls
- The model response should include the user’s identity/project context
- This validates the actual prompt-injection flow from MemoryService.prepareContext() into Gemini Live

---

## 6. Memory Isolation Tests

### Test: User A writes memory, User B reads

Step 1:
- User A saves:
  - "My name is Roshan"
  - "I am working on Kiara desktop automation"

Step 2:
- User B sends a context request with their own userId

Expected:
- User B must not see User A’s memory
- User B should only receive their own working/semantic memory
- Any cross-user data leak should be treated as a critical failure

---

## 7. Update / Correction Tests

### Identity overwrite test

Initial memory:
- "My name is Roshan"

Then update with:
- "My name is X"

Expected:
- The latest authoritative identity should win
- If there is a contradiction, the system should prefer the newest, more relevant user-stated identity
- Duplicate or stale identity values should not dominate the final context

---

## 8. Duplicate Memory Tests

### Duplicate fact repeated

Example:
- "Kiara uses Redis and MongoDB"
- "Kiara uses Redis and MongoDB"
- "Kiara uses Redis and MongoDB"

Expected:
- Duplicate extraction should not explode into repeated memory entries
- The system should deduplicate semantically similar facts
- Redis/semantic state should remain compact and not grow linearly from repeated identical input

---

## 9. Promotion Tests

Purpose:
- Validate delayed semantic long-term promotion from working memory into Pinecone/long-term vectorized memory

Flow:
1. Save enough conversation turns
2. Verify promotion queue has been enqueued
3. Confirm worker runs
4. Confirm Pinecone receives long-term embeddings or semantic entries
5. Verify live context retrieval can pull promoted memory later

Expected:
- Promotion should occur only when feature flags / queue / timing allow it
- Pinecone is optional and should not be required for the immediate working-memory save
- If Pinecone is unavailable, the system should continue with local Redis memory and degrade gracefully

---

## 10. Failure Tests

### Redis down
Expected:
- Working-memory save should fail and return backend error
- The system should log the failure clearly
- If Redis is down, semantic memory and queue writes will likely not occur

### Mongo down
Expected:
- Mongo backup failure should not block the primary Redis memory write
- Save should still succeed if Redis succeeded
- Mongo failure should be logged and non-fatal

### Pinecone unavailable
Expected:
- Promotion may fail or skip
- Main working-memory save should continue
- Long-term semantic memory should remain available via Redis if configured

### Gemini unavailable
Expected:
- Prompt generation or semantic analysis may fail gracefully
- The app should not crash the whole save path
- Context retrieval may fall back to other memory sources or return limited context

### Worker disabled
Expected:
- The immediate working-memory save should still work
- Promotion queue logic may be skipped or deferred
- No crash should occur

---

## 11. Final Route Matrix

| Route | Method | Purpose | Dummy Input | Expected Storage | Expected Read | Status |
|---|---|---|---|---|---|---|
| /api/working-memory/save | POST | Save paired memory turn | userMessage + aiResponse | Redis working memory, optional Mongo backup, semantic extraction, promotion queue | N/A | Active |
| /api/working-memory/context | GET | Read user memory context | userId | Redis semantic + working memory reads | Context returned to AI runtime | Active |
| /api/working-memory/wipe | DELETE | Clear user memory | userId | Redis wipe/reset | Empty or minimal context on re-read | Active |
| /api/live/token | POST | Generate live token and inject memory context | user query | Memory context assembled server-side | Prompt-aware live response | Active |

---

## Postman Notes

Recommended collection structure:
- Kiara Memory API
  - Save memory
  - Get memory context
  - Wipe memory
  - Live token request
  - Isolation test
  - Duplicate test
  - Promotion test
  - Failure test

Recommended checks:
- Response status is correct
- Authorization is required
- userId match is enforced
- context is user-scoped
- identity and semantic memory are deduplicated / corrected properly

---

This gives you a complete, implementation-aware memory API test specification aligned to the verified Kiara backend flow.
