# KIARA MEMORY FORENSIC AUDIT

This audit is limited to the current repository state and intentionally avoids code changes or rewrites. It traces the live memory lifecycle as implemented in the active backend and frontend paths.

## Scope and method

Primary focus:
- kiara-server/
- Kiara-ai/

Evidence sources reviewed:
- kiara-server/src/app.js
- kiara-server/src/routes/liveRoutes.js
- kiara-server/src/routes/workingMemory.routes.js
- kiara-server/src/controllers/workingMemory/workingMemory.controller.js
- kiara-server/src/services/memory/memory.service.js
- kiara-server/src/services/workingMemory/redisOperations.js
- kiara-server/src/services/memory/extraction.js
- kiara-server/src/services/pineconeService.js
- kiara-server/src/services/memory/retrieval/retriever.js
- kiara-server/src/services/live/systemPromptBuilder.js
- kiara-server/src/services/live/geminiService.js
- kiara-server/src/services/memory/memoryStabilityGate.js
- Kiara-ai/src/api/backendRealtime.ts
- Kiara-ai/src/ai/conversationMemory.ts
- kiara-server/test-verification.js

No runtime server was started or code modified for this report. The findings below are drawn from the code path and repository verification artifacts.

---

## Executive summary

[VERIFIED]
- The active write path is: frontend save request -> working-memory controller -> MemoryService.saveTurn() -> WorkingMemoryRedis.saveConversationTurn() -> Redis working-memory list write.
- The active semantic-memory write path is separate and happens in MemoryService.saveTurn() immediately after the Redis write, using extractMemoryCandidates() and extractCanonicalSemanticMemories() from the extraction layer.
- Long-term memory is not the first-tier write path; Pinecone/vector storage is a later promotion pipeline backed by Redis promotion queue metadata and a worker flow.
- The live Gemini token path is gated by a stability gate. The system prompt builder returns an empty system prompt if the memory gate is closed, and the true live memory injection is protected by isMemoryEligible(userId, sessionId).
- The code explicitly protects user-originated identity facts from lower-confidence assistant-generated identity overwrites.

[NOT TESTED]
- No live Redis/Pinecone/Gemini behavior was directly observed in a running session during this audit.
- No end-to-end server run was performed to confirm production behavior under real traffic or environment variables.

[ SUSPECTED ]
- The system is designed to be layered and defensive, but it also contains multiple memory levels and multiple promotion paths, which increases the chance of inconsistency if configuration differs across environments or if Pinecone/Redis becomes partially unavailable.

---

## 1) Actual memory lifecycle in the live code

### 1.1 User input enters the app

[VERIFIED]
- The backend mounts the working-memory API in [kiara-server/src/app.js](kiara-server/src/app.js).
- The route file [kiara-server/src/routes/workingMemory.routes.js](kiara-server/src/routes/workingMemory.routes.js) exposes the save path: POST /api/working-memory/save.
- The controller [kiara-server/src/controllers/workingMemory/workingMemory.controller.js](kiara-server/src/controllers/workingMemory/workingMemory.controller.js) calls MemoryService.saveTurn().

Observed chain:
- POST /api/working-memory/save
- WorkingMemoryController.saveConversationTurn()
- MemoryService.saveTurn({ userId, sessionId, userMessage, aiResponse, ttl })

### 1.2 Working memory is written immediately to Redis

[VERIFIED]
- MemoryService.saveTurn() validates inputs and calls WorkingMemoryRedis.saveConversationTurn().
- In [kiara-server/src/services/workingMemory/redisOperations.js](kiara-server/src/services/workingMemory/redisOperations.js), saveConversationTurn() creates a normalized payload, pushes it to a Redis list under the key memory:working:<userId>, and expires that key.
- The key format is created by WorkingMemoryRedis.buildKey(userId): memory:working:<userId>.
- The stored format is compact: T:<timestamp>\nU:<user text>\nK:<assistant text>.

This is the primary short-term memory storage layer.

### 1.3 Semantic memory extraction happens after Redis write

[VERIFIED]
- In MemoryService.saveTurn(), after the Redis write, it calls:
  - extractMemoryCandidates(userMessage, { sourceRole: 'user' })
  - extractMemoryCandidates(aiResponse, { sourceRole: 'assistant' })
  - extractCanonicalSemanticMemories(userMessage, { sourceRole: 'user' })
  - extractCanonicalSemanticMemories(aiResponse, { sourceRole: 'assistant' })
- The extraction layer is [kiara-server/src/services/memory/extraction.js](kiara-server/src/services/memory/extraction.js).

Important logic:
- user and assistant inputs are processed separately.
- identity facts are treated as user-originating evidence when they come from the user.
- assistant-generated identity memory is filtered out before write.

### 1.4 Semantic memory is stored under user-specific Redis hashes

[VERIFIED]
- In redisOperations.js, the semantic memory hash key is generated by WorkingMemoryRedis.buildSemanticMemoryKey(userId): memory:longterm:semantic:<userId>.
- The method upsertSemanticMemories(userId, semanticMemories, options = {}) writes category buckets such as identity, goals, preferences, projects, relationships, facts.
- The implementation does a direct source-aware guard for identity memories before overwriting an existing record.

Guard present in code:
- if existingSource === 'user' and existingConfidence >= 0.9 and newSource === 'assistant' and newConfidence < existingConfidence -> skip update.

This is a concrete protection mechanism against user identity contamination from assistant output.

### 1.5 Promotion to long-term memory is asynchronous and queue-based

[VERIFIED]
- saveConversationTurn() ends by enqueueing a promotion candidate via enqueuePromotionCandidate(userId).
- Redis promotion metadata keys include:
  - memory:promotion:queue
  - memory:promotion:user:<userId>
  - memory:promotion:promoted:<userId>
- The process is placed on a queue with timestamps and retry scheduling, not written directly to Pinecone on every turn.
- The promotion pipeline is separate from the immediate Redis working-memory save.

This means the system treats STM (Redis) as the active working history and long-term memory as a later, partially asynchronous layer.

### 1.6 Long-term storage uses Pinecone but is optional and guarded

[VERIFIED]
- The vector service is [kiara-server/src/services/pineconeService.js](kiara-server/src/services/pineconeService.js).
- Pinecone is only initialized when env.pineconeApiKey and env.pineconeIndexName are present, and the package must exist.
- upsertLongTermVector() checks index availability and logs a skip if unavailable.
- queryLongTermVectors() also gracefully returns [] when Pinecone is unavailable.

The system is therefore not a hard dependency for basic conversation memory. It is a semantic/vector augmentation layer.

---

## 2) Identity protection and canonicalization rules

[VERIFIED]
The strongest evidence of safety policy is in the actual write path:

- [kiara-server/src/services/memory/memory.service.js](kiara-server/src/services/memory/memory.service.js)
  - user canonical entries are saved from the user message only.
  - assistant canonical entries are filtered: category === 'identity' is skipped.
  - logging explicitly states: assistant_identity_never_overwrites_user_identity.

- [kiara-server/src/services/workingMemory/redisOperations.js](kiara-server/src/services/workingMemory/redisOperations.js)
  - source-aware identity overwrite guard in upsertSemanticMemories().

This means the implementation intends to preserve user-originated identity facts even when the assistant says a different name or identity in a later turn.

### Canonicalization behavior

[VERIFIED]
- The classification engine in [kiara-server/src/services/memory/extraction.js](kiara-server/src/services/memory/extraction.js) distinguishes categories such as identity, relationship, project, goal, preference, skill, and fact.
- The code explicitly rejects discourse fragments and technical noise before candidate acceptance.
- A strong identity signal is expected to be text like name/naam/mera naam/meri naam.

The system is not blindly storing every assistant sentence as a fact; it is filtering for memory-like, user-specific signals.

---

## 3) Retrieval and context injection path

### 3.1 Query-time retrieval pipeline

[VERIFIED]
The live retrieval pipeline is:
- MemoryService._retrieveLongTerm(userId, userQuery)
- retriever.retrieve({ userId, query: userQuery, topK: 6 })
- retriever.queryNamespaces()
- pineconeService.queryLongTermVectors()
- rank/dedupe/score results

Relevant implementation:
- [kiara-server/src/services/memory/memory.service.js](kiara-server/src/services/memory/memory.service.js)
- [kiara-server/src/services/memory/retrieval/retriever.js](kiara-server/src/services/memory/retrieval/retriever.js)
- [kiara-server/src/services/pineconeService.js](kiara-server/src/services/pineconeService.js)

The retriever analyzes query intent, chooses namespaces, scores matches, deduplicates, and then boosts memory access stats.

### 3.2 Gemini live memory injection is not unconditional

[VERIFIED]
- [kiara-server/src/routes/liveRoutes.js](kiara-server/src/routes/liveRoutes.js) calls createLiveEphemeralToken() for /api/live/token.
- [kiara-server/src/services/live/liveTokenService.js](kiara-server/src/services/live/liveTokenService.js) forwards to geminiService.
- [kiara-server/src/services/live/systemPromptBuilder.js](kiara-server/src/services/live/systemPromptBuilder.js) only builds a system prompt if trigger is provided and userId is present.
- It calls MemoryService.prepareContext() only after checking isMemoryEligible(userId, sessionId).

The gate is enforced by [kiara-server/src/services/memory/memoryStabilityGate.js](kiara-server/src/services/memory/memoryStabilityGate.js).

Observed gate behavior:
- missing userId or sessionId => false
- unhealthy live session => false
- healthy live session after required conditions => true
- default allowed state only when userId and sessionId exist, but the real gate can still lock memory off when the session is unhealthy

This is significant: the system prompt can be empty even when memory exists in Redis, because the live pipeline is gated before context injection.

---

## 4) Frontend memory path

### 4.1 Remote save path

[VERIFIED]
- The frontend uses a remote memory save path in Kiara-ai/src/api/backendRealtime.ts.
- This route posts turn content to /api/working-memory/save.

### 4.2 Local fallback memory path

[VERIFIED]
- Kiara-ai/src/ai/conversationMemory.ts contains a local IndexedDB-style fallback and snapshot loader.
- This is a frontend-side persistence path but it is not the same as the server-side Redis semantic memory path.

The key distinction is:
- server-side working memory uses Redis and is the active backend-memory layer.
- frontend local memory is a fallback or local conversation cache, not the canonical semantic identity store.

---

## 5) Storage keys and data separation

[VERIFIED]
The code clearly separates these layers:

- Working conversation memory:
  - memory:working:<userId>

- Semantic memory:
  - memory:longterm:semantic:<userId>

- Promotion queue metadata:
  - memory:promotion:queue
  - memory:promotion:user:<userId>

- Promoted episode tracking:
  - memory:promotion:promoted:<userId>

- Relationship data:
  - memory:relationships:user:<userId>

- Memory stats:
  - memory:stats:<memoryId>

This separation indicates a deliberate architecture: conversation history, semantic facts, relationship graph, and LTM vector storage are not all mixed into the same data structure.

---

## 6) What is actually verified in the repository

[VERIFIED]
- Memory saves are written to Redis immediately.
- Semantic canonical extraction is performed separately and source-sensitive.
- Assistant identity facts are explicitly filtered out.
- User identity facts are protected from lower-confidence assistant overwrite attempts.
- Live Gemini context injection is performed only when the memory gate says the session is eligible.
- Pinecone retrieval is query-based and optional.

## 7) What is not directly verified here

[NOT TESTED]
- No live Redis instance was inspected under a running server.
- No Pinecone index was queried or verified in a live environment.
- No actual Gemini Live token session was generated and inspected.
- No end-to-end memory behavior was run against a real authenticated user flow.

## 8) Repository verification artifact

[TESTED - repository artifact only, not executed here]
- [kiara-server/test-verification.js](kiara-server/test-verification.js) is a verification script designed to confirm the specific scenario: user identity is preserved while AI-generated assistant identity contamination is rejected.

The script's expected behavior is:
- user says "Mera naam Roshan hai."
- assistant later says a different identity like "Abhi"
- working memory still contains the full conversation
- semantic memory should retain only canonical user identity value such as Roshan

This file is useful evidence of intended behavior, but it is not equivalent to a live runtime test result unless executed in a running environment.

---

## 9) Final assessment

[VERIFIED]
The repository is implementing a layered memory system with the following real behavior:

1. Immediate short-term memory save to Redis.
2. Separate semantic fact extraction and canonicalization.
3. User-originated identity protection against assistant overwrite.
4. Async long-term promotion via Redis queue.
5. Optional Pinecone vector retrieval.
6. Context injection into Gemini only when the stability gate approves.

[ MISSING ]
The main missing fact is live runtime verification:
- actual saved keys and values under a real Redis instance
- actual Pinecone records for a user
- actual Gemini prompt content the model receives
- actual success/failure behavior under real user sessions and real environment variables

Without runtime evidence, the code shows the intended design, but not the full production behavior under live traffic or misconfiguration.

## Bottom line

The memory architecture is not a single flat memory store. It is intentionally multi-layered:
- STM: Redis working memory
- semantic memory: Redis hash with category-based facts
- relationship memory: Redis relationship hashes
- long-term memory: Pinecone/vector layer reached via asynchronous promotion and retrieval
- live prompt: gated memory system prompt injected into Gemini

The strongest single fact from the implementation is that user identity is explicitly protected from assistant overwrite in the canonical semantic layer, and the live prompt is gated by liveness/stability, not just by raw memory availability.
