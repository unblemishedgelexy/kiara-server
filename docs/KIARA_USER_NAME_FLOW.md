# Kiara User Name Flow: From Authenticated User to Gemini

This document explains exactly how the authenticated user’s `fullName` reaches the AI and how the model “remembers” the name without using hardcoded values.

## 1) Source of truth

The actual source of truth is the database user record for the currently authenticated user.

Relevant model:
- [kiara-server/src/models/User.js](../src/models/User.js)

The trusted identity fields are:
- `firstName`
- `lastName`
- `displayName`
- `fullName` (virtual getter, if present)

The runtime logic is:
1. take the logged-in user from the JWT/session
2. get that user by `userId`
3. produce a normalized full name from the DB record
4. inject it into the system prompt for the live Gemini session

Important:
- Kiara does not use a hardcoded name like `Roshan` as the user name.
- Developer names like `Roshan Badgujar` are only public product metadata, not the session user’s identity.
- The user name is pulled from the currently authenticated database user only.

---

## 2) Authenticated user reaches the request

The request-level auth flow happens here:
- [kiara-server/src/middleware/authMiddleware.js](../src/middleware/authMiddleware.js)

Flow:
- JWT access token is read from the request
- token is verified
- `payload.sub` / `payload.userId` / `payload.id` is mapped to `req.userId`

Example:

```js
function attachAuthUser(req, payload) {
  const userId = payload.sub || payload.userId || payload.id;
  req.userId = typeof userId === 'object' && userId !== null && userId.id ? userId.id : userId;
}
```

At this point, the backend knows: “this request belongs to this authenticated user.”

---

## 3) Live session starts and passes userId into Gemini token creation

The live token endpoint is here:
- [kiara-server/src/routes/liveRoutes.js](../src/routes/liveRoutes.js)

Important part:

```js
const userId = req.userId || null;
const token = await createLiveEphemeralToken(userId, {
  userQuery,
  sessionId,
  activeContext,
  lifecycleTrigger: req.lifecycleTrigger || 'LIVE_SESSION_START'
});
```

So the active authenticated user is already known before the Gemini session is created.

---

## 4) Gemini token creation receives the userId and builds dynamic system instruction

The real session construction happens here:
- [kiara-server/src/services/live/geminiService.js](../src/services/live/geminiService.js)

Inside `createLiveEphemeralToken(...)`:
- `requestingUserId` is captured
- `sessionId` is derived
- `systemPromptBuilder.buildSystemPrompt(requestingUserId, ...)` is invoked

This is the key step:

```js
if (requestingUserId && systemPromptBuilder && memoryGateOpen) {
  const built = await systemPromptBuilder.buildSystemPrompt(requestingUserId, {
    trigger: 'session_start',
    sessionId,
    activeContext,
  });

  if (built && built.systemPrompt) {
    dynamicSystemInstruction = `${GEMINI_LIVE_SYSTEM_INSTRUCTION}\n\n${built.systemPrompt}`;
  }
}
```

So the Gemini system instruction is not static. It is built dynamically using the authenticated user and their session context.

---

## 5) The actual user name is resolved from the database

This is the important step:
- [kiara-server/src/services/live/systemPromptBuilder.js](../src/services/live/systemPromptBuilder.js)

The builder does this:

```js
const user = await User.findById(userId).select('firstName lastName displayName fullName');
const fullName = normalizeUserFullName(user);
```

Then it creates a prompt fragment like:

```js
AUTHENTICATED USER CONTEXT
- Current authenticated user fullName: "Amit Sharma"
- Use the user's fullName naturally and sparingly when appropriate.
```

This fragment is injected into the final Gemini system instruction.

### Name normalization logic

```js
function normalizeUserFullName(user = null) {
  if (!user || typeof user !== 'object') return '';

  const directFullName = String(user.fullName || '').trim();
  if (directFullName) return directFullName;

  const firstName = String(user.firstName || '').trim();
  const lastName = String(user.lastName || '').trim();
  const displayName = String(user.displayName || '').trim();

  const fullName = [firstName, lastName].filter(Boolean).join(' ').trim();
  return fullName || displayName;
}
```

This guarantees:
- no hardcoded name
- no guessed name
- no fallback to `Roshan` or any developer name
- only the current authenticated user’s real trusted DB data

---

## 6) How AI “remembers” the name

The AI does not remember it in a magical internal way from the system alone.

The way it really works is:

1. the backend resolves the actual logged-in user from the database
2. it creates a dynamic system prompt fragment
3. this fragment is included in the Gemini session config as `systemInstruction`
4. Gemini receives that instruction at session creation time
5. the model therefore knows the current user identity while generating replies

The key final injection is here:
- [kiara-server/src/services/live/liveConfig.js](../src/services/live/liveConfig.js)

```js
return {
  model,
  responseModalities: ['AUDIO'],
  systemInstruction: options.systemInstruction || GEMINI_LIVE_SYSTEM_INSTRUCTION,
  voiceName,
};
```

Then that `systemInstruction` is passed into Gemini’s live session config, and the model sees it as part of the session context.

---

## 7) Why this is not a developer name leak

There is a distinction between:

### A) Authenticated user identity
This is dynamic and private to the logged-in user.
- comes from the DB user record
- tied to `req.userId`
- used to address the specific current user

### B) Product / developer metadata
This is public system context, not the current user’s identity.
- `Kiara`
- `Unblemished Galaxy`
- `Tejpal Mahor`
- `Roshan Badgujar`
- team names

This metadata is included only as public product context and is intentionally not used as the user-name source.

---

## 8) Real example

If the current authenticated user record is:

```js
{
  firstName: 'Amit',
  lastName: 'Sharma',
  displayName: 'Amit Sharma'
}
```

Then the prompt fragment becomes:

```txt
AUTHENTICATED USER CONTEXT
- Current authenticated user fullName: "Amit Sharma"
- Use the user's fullName naturally and sparingly when appropriate.
```

So the model can naturally say:

> "Amit, kya haal hai?"

or

> "Amit, ye kaam ho gaya?"

But it cannot invent a name, and it cannot substitute a developer name like `Roshan` as the end-user identity.

---

## 9) The exact chain in one line

`authenticated JWT user -> req.userId -> database user -> fullName -> systemPromptBuilder -> Gemini systemInstruction -> model sees current user identity`

That is the full process.

---

## 10) Short mental model

If you want the simplest explanation:

- Kiara does not “guess” the user name.
- It does not store names in a static prompt.
- It asks the database: “whose session is this?”
- It fetches that user’s real `fullName`
- It injects that exact name into the live session instruction
- Then the model knows how to address that user naturally in context

This is why the user name is dynamic, safe, and per-account.
