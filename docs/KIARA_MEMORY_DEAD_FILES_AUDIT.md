# KIARA MEMORY DEAD FILES AUDIT

**Repository:** `D:\Kiara`
**Audit date:** 2026-08-20
**Scope:** Current repository, including `kiara-server/`, `Kiara-ai/`, scripts, tests, archive files, startup code, routes, controllers, services, and frontend callers.
**Changes made:** This audit file only. No source file was modified or deleted.

## Method

Each memory-adjacent candidate was checked by filename, basename, exported symbol, CommonJS `require`, ES-module import, dynamic `require`, route mounting, controller/service/worker references, startup references, frontend references, package scripts, and directly executable tests.

Documentation and generated `dist/` output were not treated as runtime callers. A documentation mention does not make an implementation active. A direct executable test was retained as relevant even when no other file imports it.

## Pre-existing deleted files in the working tree

The current checkout already reports a large set of older memory/API files as deleted in `kiara-server` according to `git status`. These are pre-existing worktree changes, not deletions made by this audit, so they are not repeated as new safe-to-delete recommendations. Their absence from the current filesystem also means this audit cannot re-check their complete source contents.

The already-absent tracked paths include the old `MemoryProfile.js`, `LongTermMemory.js`, `memoryRoutes.js`, `memoryController.js`, `memoryService.js`, `memoryV6AnalyticsService.js`, `systemPromptBuilderV6.js`, the old memory model family (`EpisodicMemory.js`, `FollowUpMemory.js`, `GoalMemory.js`, `IdentityMemory.js`, `MemoryBase.js`, `MemoryJob.js`, `MemoryNameIndex.js`, `PreferenceMemory.js`, `ProjectMemory.js`, `RelationshipMemory.js`, `SacredMemory.js`, `ShortTermMemory.js`), the old bootstrap/cache/continuity/extraction/ranking/retrieval/storage services under `src/services/memory/`, and the old `src/services/workers/memoryWorkerService.js`.

The current active runtime instead uses the present `src/services/memory/` implementation, `workingMemory.routes.js`, and the current promotion/retrieval modules documented below. No deleted path is treated as proof that a still-present replacement is removable.

The statuses below mean:

1. **DEFINITELY ACTIVE** - directly used by the current runtime path.
2. **INDIRECTLY ACTIVE** - reached through an active service, validation runner, worker, or executable test.
3. **LEGACY BUT REFERENCED** - older or placeholder implementation still reached by current code or frontend behavior.
4. **DEFINITELY UNUSED** - no active import, dynamic import, route, controller, service, worker, startup, frontend, relevant script, or relevant test reference was found.
5. **DUPLICATE IMPLEMENTATION** - overlaps another implementation; deletion requires choosing between the two.
6. **UNKNOWN** - static analysis cannot establish safe removal confidently.

## Active architecture used as the reference point

The current backend runtime starts at `kiara-server/src/server.js`, mounts `workingMemory.routes.js` from `src/app.js`, and uses `MemoryService` through the working-memory controller. The main live path is:

`Kiara-ai/src/api/backendRealtime.ts` -> `/api/working-memory/save` -> `WorkingMemoryController` -> `MemoryService.saveTurn()` -> Redis/Mongo/semantic extraction -> promotion queue -> optional promotion worker/Pinecone.

Live prompt assembly uses:

`/api/live/token` -> `liveTokenService` -> `geminiService` -> `systemPromptBuilder` -> `MemoryService.prepareContext()`.

This reference path is important because names such as V6, LongTermMemory, and MemoryProfile appear in older or parallel code, but names alone do not establish that a file is dead.

---

## File inventory and status

### Backend active and indirectly active files

| Status | File | Evidence |
|---|---|---|
| DEFINITELY ACTIVE | `kiara-server/src/app.js` | Mounts `/api/working-memory` and `/api/live`. |
| DEFINITELY ACTIVE | `kiara-server/src/server.js` | Startup entry; imports and conditionally starts `promotionWorker`. |
| DEFINITELY ACTIVE | `kiara-server/src/routes/workingMemory.routes.js` | Defines the current working-memory API routes. |
| DEFINITELY ACTIVE | `kiara-server/src/controllers/workingMemory/workingMemory.controller.js` | Route controller; directly calls `MemoryService.saveTurn()` and other memory methods. |
| DEFINITELY ACTIVE | `kiara-server/src/middleware/workingMemory/workingMemory.middleware.js` | Used by `workingMemory.routes.js` for authentication binding and request validation. |
| DEFINITELY ACTIVE | `kiara-server/src/services/memory/index.js` | Directory import target; exports `memory.service.js` as the public memory entry point. |
| DEFINITELY ACTIVE | `kiara-server/src/services/memory/memory.service.js` | Imported by the working-memory controller and live system prompt builder. |
| DEFINITELY ACTIVE | `kiara-server/src/services/workingMemory/redisOperations.js` | Used by `MemoryService`, promotion, retrieval, consolidation, and validation. |
| DEFINITELY ACTIVE | `kiara-server/src/services/memory/extraction.js` | Imported and called by `MemoryService.saveTurn()` and promotion analysis code. |
| DEFINITELY ACTIVE | `kiara-server/src/services/memory/memoryStabilityGate.js` | Imported by `MemoryService`, `systemPromptBuilder`, and `geminiService`. |
| DEFINITELY ACTIVE | `kiara-server/src/services/live/systemPromptBuilder.js` | Imported by `geminiService`; calls `MemoryService.prepareContext()`. |
| DEFINITELY ACTIVE | `kiara-server/src/services/live/geminiService.js` | Current Gemini Live service; imports the live system prompt builder and memory gate. |
| DEFINITELY ACTIVE | `kiara-server/src/services/live/liveTokenService.js` | Imported by `liveRoutes.js` for token creation. |
| DEFINITELY ACTIVE | `kiara-server/src/routes/liveRoutes.js` | Current `/api/live/token` route. |
| DEFINITELY ACTIVE | `kiara-server/src/services/pineconeService.js` | Imported by promotion, retrieval, consolidation, validation, and other active services. |
| DEFINITELY ACTIVE | `kiara-server/src/utils/memory/memoryUtils.js` | Imported by `MemoryService`, promotion, retriever, validation, and embedding-related code. |
| DEFINITELY ACTIVE | `kiara-server/src/services/memory/utils/memoryLogger.js` | Imported by the active memory, Pinecone, embedding, Gemini, promotion, retrieval, and validation modules. |
| DEFINITELY ACTIVE | `kiara-server/src/services/memory/utils/memoryTrace.js` | Imported by app/request, frontend-facing controller, extraction, memory service, Gemini, and prompt code. |
| DEFINITELY ACTIVE | `kiara-server/src/services/memory/promotion/memoryAnalyzer.js` | Imported by `memoryPromotionService.js`. |
| DEFINITELY ACTIVE | `kiara-server/src/services/memory/promotion/memoryPromotionService.js` | Imported by `promotionWorker.js`; also called by `validationRunner.js`. |
| DEFINITELY ACTIVE | `kiara-server/src/services/memory/promotion/promotionWorker.js` | Imported by `server.js` and started when memory, Pinecone, and worker flags allow it. |
| DEFINITELY ACTIVE | `kiara-server/src/services/memory/retrieval/retriever.js` | Imported by `MemoryService`, the retrieval orchestrator, validation, and the infrastructure validation script. |
| DEFINITELY ACTIVE | `kiara-server/src/services/memory/retrieval/promptBuilder.js` | Imported by `MemoryService` and used during context assembly; also referenced by validation. |
| DEFINITELY ACTIVE | `kiara-server/src/services/memory/utils/memoryRetrievelOrchestrator.js` | Imported by `MemoryService`; also directly exercised by acceptance tests. |
| DEFINITELY ACTIVE | `kiara-server/src/services/memory/utils/queryAnalyzer.js` | Used by the retrieval orchestrator, retriever tests, and acceptance tests. |
| DEFINITELY ACTIVE | `kiara-server/src/services/memory/utils/contextBudget.js` | Used by the retrieval orchestrator and acceptance tests. |
| DEFINITELY ACTIVE | `kiara-server/src/services/memory/utils/deduplicationService.js` | Used by the retrieval orchestrator and acceptance tests. |
| DEFINITELY ACTIVE | `kiara-server/src/services/memory/utils/antiRepetitionTracker.js` | Used by the memory service, retrieval orchestrator, and acceptance tests. |
| DEFINITELY ACTIVE | `kiara-server/src/services/memory/utils/relevanceRanking.js` | Used by the retrieval orchestrator and acceptance tests. |
| DEFINITELY ACTIVE | `kiara-server/src/services/memory/utils/memoryIdentity.js` | Used by deduplication and acceptance tests. |
| DEFINITELY ACTIVE | `kiara-server/src/models/ConversationTurn.js` | Imported by `redisOperations.js` and written as the Mongo conversation backup. |
| INDIRECTLY ACTIVE | `kiara-server/src/services/memory/retrieval/strictRetriever.js` | Imported by `memory.service.js`; it also imports the active retriever. The import is a live dependency even though no separate route calls `searchStrict()` in the searched source. |
| INDIRECTLY ACTIVE | `kiara-server/src/services/memory/validation/validationRunner.js` | Imported by `scripts/run-memory-validation.js` and `scripts/validate-memory-infra.js`; it reaches promotion, Pinecone, retrieval, prompt, and consolidation code. |
| INDIRECTLY ACTIVE | `kiara-server/src/services/memory/consolidation/consolidationService.js` | Imported and called by `validationRunner.js`; it is not mounted as a production route or startup job. |
| INDIRECTLY ACTIVE | `kiara-server/src/services/memory/utils/memoryAcceptanceTests.js` | Directly executable with `node`; it imports and exercises active retrieval utilities. It is not referenced by the package script, but it is still a relevant test artifact and therefore is not proven safe to delete. |

### Frontend active and indirectly active files

| Status | File | Evidence |
|---|---|---|
| DEFINITELY ACTIVE | `Kiara-ai/src/api/backendRealtime.ts` | Posts `/api/working-memory/save`, fetches `/api/working-memory/context`, and is imported by `conversationMemory.ts`. |
| DEFINITELY ACTIVE | `Kiara-ai/src/ai/conversationMemory.ts` | Imported by connection/runtime code; remote-first persistence with IndexedDB fallback. |
| DEFINITELY ACTIVE | `Kiara-ai/src/ai/conversationRuntime.ts` | Imported by Live connection/runtime code; flushes user and assistant transcripts into conversation memory. |
| DEFINITELY ACTIVE | `Kiara-ai/src/ai/realtimeMemory.ts` | Imported by `useRealtimeAI`; coordinates memory preload, priming, and persistence. |
| DEFINITELY ACTIVE | `Kiara-ai/src/ai/connectionManager.ts` | Imports and calls `saveConversationTurn()` as part of the Live connection path. |
| DEFINITELY ACTIVE | `Kiara-ai/src/services/bootstrapEngine.ts` | Calls `/api/working-memory/context` during frontend context/bootstrap behavior. |
| DEFINITELY ACTIVE | `Kiara-ai/src/services/KiaraMemoryService.ts` | Imported by `useAutonomousIdentity`, `useKiaraMemory`, and `KiaraIdentityService`; it is a separate localStorage memory implementation, not an unused file. |
| DEFINITELY ACTIVE | `Kiara-ai/src/components/context/hooks/useKiaraMemory.ts` | Imports `KiaraMemoryService`; used by `KiaraMemoryPanel`. |
| DEFINITELY ACTIVE | `Kiara-ai/src/components/context/hooks/useAutonomousIdentity.ts` | Imports `KiaraMemoryService`; used by `HomePage`. |
| DEFINITELY ACTIVE | `Kiara-ai/src/services/KiaraIdentityService.ts` | Imports `KiaraMemoryService`. |
| INDIRECTLY ACTIVE | `Kiara-ai/src/components/KiaraMemoryPanel.tsx` | Uses `useKiaraMemory`; the component itself did not show a separate caller in the searched source, so its route/component registration is not fully established. |
| UNKNOWN | `Kiara-ai/src/pages/MemoryDebugPage.tsx` | Calls active working-memory debug/stats APIs, but no route import was found in the searched source. It may be manually registered or intentionally retained as a diagnostic page. |
| UNKNOWN | `Kiara-ai/src/utils/memoryDebugLogger.ts` | Memory-related frontend logger; direct usage was not established confidently in the narrowed reverse-reference search. |

### Related profile/context models

| Status | File | Evidence |
|---|---|---|
| DEFINITELY ACTIVE | `kiara-server/src/models/PersonProfile.js` | Imported by `identityController.js` and `realIdentityService.js`; active identity/profile behavior. |
| DEFINITELY ACTIVE | `kiara-server/src/controllers/identityController.js` | Queries `PersonProfile`; active identity route/controller surface. |
| DEFINITELY ACTIVE | `kiara-server/src/services/infrastructure/realIdentityService.js` | Repeatedly imports and uses `PersonProfile`; active identity infrastructure. |
| DEFINITELY UNUSED | `kiara-server/src/models/ActiveContext.js` | No import, dynamic import, route, controller, service, worker, startup, frontend, script, or relevant test reference was found. The current Live path passes `activeContext` as a request object and does not load this Mongoose model. |
| UNKNOWN | `MemoryProfile` / `LongTermMemory` files not present under the current source tree | The searched repository contains the TypeScript `LongTermMemory` type inside `KiaraMemoryService.ts`, but no standalone `MemoryProfile` implementation and no current backend `LongTermMemory` class/file. A missing file cannot be marked removable. |

---

## DEFINITELY UNUSED evidence

### File: `kiara-server/archive/v6/memoryV6AnalyticsService.js`

**PATH:**
`kiara-server/archive/v6/memoryV6AnalyticsService.js`

**WHY UNUSED:**
The file is located in the archive-only `v6` directory. Repository-wide search found no active import, dynamic import, route reference, controller reference, service reference, worker reference, startup reference, frontend reference, relevant script reference, or relevant test reference. Its only observed references were its own declarations and text in archived/diagnostic material. The current startup path imports `src/services/memory/promotion/promotionWorker.js`, not this V6 analytics service.

**REFERENCES FOUND:**
None.

**SEARCHED FOR:**
`memoryV6AnalyticsService`, `recordMetric`, `recordRecallAccuracy`, `recordContinuityScore`, `recordMemoryRetrievalLatency`, `recordPromptTokenUsage`, `recordRelationshipRecallAccuracy`, `getMetricsStats`, `getMemoryV6Health`.

**SAFE TO DELETE:**
YES

### File: `kiara-server/archive/v6/systemPromptBuilderV6.js`

**PATH:**
`kiara-server/archive/v6/systemPromptBuilderV6.js`

**WHY UNUSED:**
The file is located in the archive-only `v6` directory. Repository-wide search found no active import, dynamic import, route reference, controller reference, service reference, worker reference, startup reference, frontend reference, relevant script reference, or relevant test reference. The current Live path imports `src/services/live/systemPromptBuilder.js`; no caller imports `systemPromptBuilderV6.js`.

**REFERENCES FOUND:**
None.

**SEARCHED FOR:**
`systemPromptBuilderV6`, `buildV6SystemPrompt`, `sacredMemoryService`, `relationshipMemoryEngine`, `activeContextService`, `followUpMemoryService`.

**SAFE TO DELETE:**
YES

### File: `kiara-server/src/models/ActiveContext.js`

**PATH:**
`kiara-server/src/models/ActiveContext.js`

**WHY UNUSED:**
The model export `ActiveContext` has no repository caller. Search found no import or dynamic import of `./models/ActiveContext`, `../models/ActiveContext`, `../../models/ActiveContext`, or `ActiveContext` as a model dependency. No route, controller, service, worker, startup code, frontend code, script, or relevant test loads it. The current Live request uses an in-memory/request `activeContext` object and the active retrieval code receives that object through options; it does not use this Mongoose model.

**REFERENCES FOUND:**
None.

**SEARCHED FOR:**
`ActiveContext`, `activeContextSchema`, `models/ActiveContext`, `require('../models/ActiveContext')`, `require('../../models/ActiveContext')`.

**SAFE TO DELETE:**
YES

### File: `kiara-server/src/utils/memory/memoryLogger.js`

**PATH:**
`kiara-server/src/utils/memory/memoryLogger.js`

**WHY UNUSED:**
The file exports an older small logger API, but no source file imports its path or its exported methods. The active memory stack imports `kiara-server/src/services/memory/utils/memoryLogger.js` instead. Repository-wide search found no route, controller, service, worker, startup, frontend, script, or relevant test caller for this utility logger.

**REFERENCES FOUND:**
None.

**SEARCHED FOR:**
`src/utils/memory/memoryLogger.js`, `../utils/memory/memoryLogger`, `../../utils/memory/memoryLogger`, `factExtracted`, `factUpdated`, `factMerged`, `memoryRanked`, `recallMatch`, `promptBuilt`, `contextSent`, `currentTaskUpdated`.

**SAFE TO DELETE:**
YES

---

## LEGACY BUT REFERENCED

### `kiara-server/src/services/memory/longTermHandoff.js`

This is explicitly a placeholder: `prepareLongTermMemory(snapshot)` returns the snapshot unchanged. It is nevertheless imported by `memory.service.js` and called by snapshot timer/idle handoff code. It is not safe to classify as definitely unused.

### `Kiara-ai/src/services/KiaraMemoryService.ts`

This is a separate localStorage memory architecture with `LongTermMemory` types and local promotion/search methods. It is not the backend Redis/Pinecone implementation, but it is imported by `useKiaraMemory`, `useAutonomousIdentity`, and `KiaraIdentityService`. Its name and data model look older or parallel, but it is still referenced by active frontend features.

### `kiara-server/src/services/memory/memory.service.js` compatibility surface

The service contains compatibility wrappers for older `/api/working-memory` controller methods. The wrappers are inside an active service and are called by the active working-memory controller. They cannot be removed based on naming alone.

### `kiara-server/src/services/memory/utils/memoryAcceptanceTests.js`

This is not imported by the package script, but it is directly executable and contains a complete 14-test memory acceptance suite. It remains a relevant test artifact; static analysis does not prove that it can be deleted safely.

---

## DUPLICATE IMPLEMENTATION

### File A: `kiara-server/src/utils/memory/memoryLogger.js`
### File B: `kiara-server/src/services/memory/utils/memoryLogger.js`

**WHAT THEY BOTH DO:**
Both provide memory-specific logging helpers and console/event logging for memory operations.

**WHICH ONE IS ACTIVE:**
`kiara-server/src/services/memory/utils/memoryLogger.js` is active. It is imported by the active memory service, extraction/promotion/retrieval utilities, Pinecone service, Gemini service, embedding provider, validation runner, and related infrastructure.

**EVIDENCE:**
The active modules use paths such as `../utils/memoryLogger` from `src/services/memory/*` and `./memory/utils/memoryLogger` from `src/services/*`. No caller was found for `src/utils/memory/memoryLogger.js` or its older method names.

**WHICH ONE APPEARS SAFE TO REMOVE:**
`kiara-server/src/utils/memory/memoryLogger.js` appears safe to remove and is independently listed above as DEFINITELY UNUSED. Do not remove the service logger.

### File A: `kiara-server/archive/v6/systemPromptBuilderV6.js`
### File B: `kiara-server/src/services/live/systemPromptBuilder.js`

**WHAT THEY BOTH DO:**
Both build a system-prompt fragment containing user memory/context for Gemini-like responses.

**WHICH ONE IS ACTIVE:**
`kiara-server/src/services/live/systemPromptBuilder.js` is active through `geminiService.js` and the Live token route.

**EVIDENCE:**
The active path imports `systemPromptBuilder` from `src/services/live`; no caller imports the archived V6 builder. The V6 builder depends on archived services that are not present as current active modules.

**WHICH ONE APPEARS SAFE TO REMOVE:**
`kiara-server/archive/v6/systemPromptBuilderV6.js` appears safe to remove. The current Live builder must not be removed.

### File A: `Kiara-ai/src/services/KiaraMemoryService.ts`
### File B: `kiara-server/src/services/memory/memory.service.js`

**WHAT THEY BOTH DO:**
Both expose memory storage, promotion, retrieval, and context-oriented behavior.

**WHICH ONE IS ACTIVE:**
Both are referenced, but they are not interchangeable. The backend `memory.service.js` is active for server memory and Live prompt assembly; `KiaraMemoryService.ts` is active for local frontend identity/memory features and localStorage persistence.

**EVIDENCE:**
The frontend imports `KiaraMemoryService.ts` through identity and memory hooks, while the backend controller and Live builder import the backend service. The storage and public APIs differ: localStorage versus Redis/Mongo/Pinecone.

**WHICH ONE APPEARS SAFE TO REMOVE:**
Neither. This is overlapping responsibility, not proof of a removable duplicate.

---

## UNKNOWN

### `Kiara-ai/src/pages/MemoryDebugPage.tsx`

The file calls active `/api/working-memory/debug` and `/api/working-memory/stats` endpoints, but no route registration/import was found in the searched frontend source. It may be a manually opened diagnostic page or an unregistered page. Do not delete without confirming the router and deployment entry points outside static references.

### `Kiara-ai/src/components/KiaraMemoryPanel.tsx`

The component imports `useKiaraMemory`, but a separate component/page registration was not established in the searched source. Its hook dependency is active, so the component cannot be marked definitely unused from the available evidence.

### `Kiara-ai/src/utils/memoryDebugLogger.ts`

A memory-related frontend logger was found, but its complete caller set was not established confidently in the narrowed search. It is not a deletion candidate.

### Documentation and generated artifacts

`KIARA_MEMORY_COMPLETE_AUDIT.md`, `KIARA_MEMORY_FORENSIC_AUDIT.md`, `Kiara-ai/docs/Kiara_Memory_Workflow.md`, and generated `Kiara-ai/dist/` assets contain memory-related material or compiled code. Static implementation references do not prove whether documentation or build artifacts are intentionally retained. They are therefore not classified as safe-to-delete implementation files in this audit.

---

## SAFE TO DELETE

Only files proven unused by the static-analysis criteria:

- `kiara-server/archive/v6/memoryV6AnalyticsService.js`
- `kiara-server/archive/v6/systemPromptBuilderV6.js`
- `kiara-server/src/models/ActiveContext.js`
- `kiara-server/src/utils/memory/memoryLogger.js`

## DO NOT DELETE

Files that are active or indirectly active, including the current Redis/semantic/Pinecone pipeline, Live prompt path, frontend remote/local memory path, validation scripts, directly executable acceptance tests, and `PersonProfile` identity infrastructure.

## LEGACY BUT REFERENCED

- `kiara-server/src/services/memory/longTermHandoff.js`
- `Kiara-ai/src/services/KiaraMemoryService.ts`
- Compatibility methods inside `kiara-server/src/services/memory/memory.service.js`
- `kiara-server/src/services/memory/utils/memoryAcceptanceTests.js`

## DUPLICATES

- `kiara-server/src/utils/memory/memoryLogger.js` versus `kiara-server/src/services/memory/utils/memoryLogger.js`; the former is the unreferenced older logger.
- `kiara-server/archive/v6/systemPromptBuilderV6.js` versus `kiara-server/src/services/live/systemPromptBuilder.js`; the archived V6 builder is unreferenced.
- `Kiara-ai/src/services/KiaraMemoryService.ts` versus `kiara-server/src/services/memory/memory.service.js`; overlapping but non-interchangeable frontend/backend implementations, so neither is proven removable.

## UNKNOWN

- `Kiara-ai/src/pages/MemoryDebugPage.tsx`
- `Kiara-ai/src/components/KiaraMemoryPanel.tsx`
- `Kiara-ai/src/utils/memoryDebugLogger.ts`
- Documentation and generated memory artifacts whose retention policy is not established by code references

## DELETE ORDER

1. `kiara-server/archive/v6/memoryV6AnalyticsService.js`
2. `kiara-server/archive/v6/systemPromptBuilderV6.js`
3. `kiara-server/src/utils/memory/memoryLogger.js`
4. `kiara-server/src/models/ActiveContext.js`

This is a conservative order: remove archive-only files first, then the unreferenced duplicate logger, and remove the unreferenced model last after confirming no external deployment or migration process loads models by convention.
