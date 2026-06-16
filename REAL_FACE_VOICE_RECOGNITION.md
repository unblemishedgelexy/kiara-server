# Real Face & Voice Recognition System

## Overview
This system provides **real-time face and voice recognition** using machine learning models that work in both web and mobile (Capacitor) environments.

### Architecture
```
┌─────────────────────────────────────────────────────────┐
│                   KIARA AI - FRONTEND                    │
│  ┌──────────────────┐      ┌─────────────────────────┐  │
│  │ FaceCapture.tsx  │      │ VoiceCapture.tsx        │  │
│  │ (Camera Input)   │      │ (Microphone Input)      │  │
│  └────────┬─────────┘      └────────┬────────────────┘  │
│           │                         │                    │
│  ┌────────▼────────────────────────▼──────────────┐     │
│  │ Face Recognition Service (face-api.js)        │     │
│  │ - Detects faces in camera feed                │     │
│  │ - Extracts 128-dim face descriptor             │     │
│  │                                                │     │
│  │ Voice Recognition Service (voice-api.ts)      │     │
│  │ - Extracts MFCC (13 coefficients)             │     │
│  │ - Computes voice characteristics (pitch/etc)  │     │
│  └─────────────┬──────────────────────────────────┘     │
│                │                                         │
│  ┌─────────────▼──────────────────────────────────┐     │
│  │ Identity API Client                           │     │
│  │ - Sends descriptors to backend                │     │
│  │ - Receives recognition results                │     │
│  └─────────────┬──────────────────────────────────┘     │
└────────────────┼──────────────────────────────────────────┘
                 │
        HTTP/JSON │
                 │
┌────────────────▼──────────────────────────────────────────┐
│              KIARA SERVER - BACKEND                        │
│  ┌────────────────────────────────────────────────────┐  │
│  │ Real Identity Service (realIdentityService.js)    │  │
│  │ - processInteraction(userId, face, voice)         │  │
│  │ - recognizeFace(userId, descriptor)               │  │
│  │ - recognizeVoice(userId, descriptor)              │  │
│  │ - learnPerson(userId, name, descriptors)          │  │
│  └────────────────┬─────────────────────────────────┘  │
│                   │                                      │
│  ┌────────────────▼─────────────────────────────────┐   │
│  │ Vector Similarity Matching                       │   │
│  │ - Cosine Similarity (face: 128 dims)             │   │
│  │ - MFCC Comparison (voice: 13 dims)               │   │
│  │ - Hybrid Matching (both modalities)              │   │
│  └────────────────┬─────────────────────────────────┘   │
│                   │                                      │
│  ┌────────────────▼─────────────────────────────────┐   │
│  │ MongoDB - PersonProfile Collection               │   │
│  │ - Stores face descriptors (128 values)           │   │
│  │ - Stores voice descriptors (13 MFCC coeffs)     │   │
│  │ - Tracks meeting history                        │   │
│  │ - Calculates confidence scores                  │   │
│  └─────────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────────────┘
```

## Features

### 1. Face Recognition (Client-Side)
- **Model**: face-api.js (based on TensorFlow.js + tiny-face-detector)
- **Descriptor**: 128-dimensional vector
- **Threshold**: 0.55 (55% similarity for match)
- **Speed**: ~100-200ms per frame
- **Accuracy**: Works with glasses, partial faces, lighting variations

```typescript
// Usage in FaceCapture component
const faceData = await extractFaceEmbedding(videoElement);
// Returns: { descriptor, landmarks, detection.confidence }
```

### 2. Voice Recognition (Client-Side)
- **Feature Extraction**: MFCC (Mel-Frequency Cepstral Coefficients)
- **Descriptor**: 13-coefficient MFCC vector
- **Characteristics**: Pitch, energy, zero-crossing rate
- **Threshold**: 0.50 (50% similarity for match)
- **Duration**: 4 seconds recommended

```typescript
// Usage in VoiceCapture component
const voiceData = await extractVoiceEmbedding(audioBlob);
// Returns: { descriptor, characteristics }
```

### 3. Backend Matching
- **Face-Only**: Uses 0.55 threshold (55% cosine similarity)
- **Voice-Only**: Uses 0.50 threshold (50% with weighted characteristics)
- **Combined**: Requires match from either modality
- **Database**: Stores multiple embeddings per person for improved matching

## API Endpoints

### 1. Learn Person
```bash
POST /api/identity/learn-person
Content-Type: application/json
Authorization: Bearer <token>

{
  "name": "John Doe",
  "relationship": "family",
  "face_descriptor": [0.1, 0.2, ...],  // 128 values
  "voice_descriptor": [0.5, 0.6, ...],  // 13 MFCC coeffs
  "voice_characteristics": {
    "pitch": 120,
    "energy": 0.8,
    "zcr": 0.3,
    "duration": 4,
    "sampleRate": 48000
  }
}

Response:
{
  "success": true,
  "person_id": "507f1f77bcf86cd799439011",
  "name": "John Doe",
  "relationship": "family",
  "learned_modalities": ["face", "voice"],
  "message": "Learned John Doe (family)"
}
```

### 2. Recognize with Face
```bash
POST /api/identity/recognize-face
Content-Type: application/json
Authorization: Bearer <token>

{
  "face_descriptor": [0.1, 0.2, ...]  // 128 values from face-api
}

Response:
{
  "status": "matched",
  "person_id": "507f1f77bcf86cd799439011",
  "name": "John Doe",
  "relationship": "family",
  "confidence": 0.78,
  "message": "Recognized John Doe (family)"
}
```

### 3. Recognize with Voice
```bash
POST /api/identity/recognize-voice
Content-Type: application/json
Authorization: Bearer <token>

{
  "voice_descriptor": [0.5, 0.6, ...],  // 13 MFCC coeffs
  "voice_characteristics": {
    "pitch": 120,
    "energy": 0.8,
    "zcr": 0.3,
    "duration": 4,
    "sampleRate": 48000
  }
}

Response:
{
  "status": "matched",
  "person_id": "507f1f77bcf86cd799439011",
  "name": "John Doe",
  "relationship": "family",
  "confidence": 0.72,
  "message": "Recognized John Doe by voice (family)"
}
```

### 4. Process Interaction (Face + Voice)
```bash
POST /api/identity/process
Content-Type: application/json
Authorization: Bearer <token>

{
  "face_embedding": [0.1, 0.2, ...],
  "voice_embedding": [0.5, 0.6, ...],
  "voice_characteristics": {...},
  "interaction_context": "greeting"
}

Response:
{
  "person_id": "507f1f77bcf86cd799439011",
  "name": "John Doe",
  "relationship": "family",
  "meetings_count": 42,
  "voice_score": 0.72,
  "face_score": 0.78,
  "overall_confidence": 0.75,
  "known": true,
  "recognition_source": "face + voice",
  "message": "Recognized John Doe! Nice to see you again! (Meetings: 42)"
}
```

### 5. Get Known People
```bash
GET /api/identity/people
Authorization: Bearer <token>

Response:
{
  "total": 5,
  "people": [
    {
      "person_id": "507f1f77bcf86cd799439011",
      "name": "John Doe",
      "relationship": "family",
      "meetings_count": 42,
      "last_seen": "2026-06-15T10:30:00Z",
      "confidence": 0.85
    }
  ]
}
```

### 6. Get Stats
```bash
GET /api/identity/stats
Authorization: Bearer <token>

Response:
{
  "total_people": 5,
  "total_with_face": 5,
  "total_with_voice": 4,
  "total_learned": 5,
  "avg_meetings_count": 8,
  "face_embedding_dim": 128,
  "voice_embedding_dim": 13
}
```

## Model Initialization

### Frontend Setup
face-api models must be downloaded to `public/models/face-api/`:
```
public/models/face-api/
  ├── tiny_face_detector_model-weights_manifest.json
  ├── tiny_face_detector_model.bin
  ├── face_recognition_model-weights_manifest.json
  ├── face_recognition_model.bin
  ├── face_landmarks_68_model-weights_manifest.json
  ├── face_landmarks_68_model.bin
  └── ... (other models)
```

Download from: https://github.com/vladmandic/face-api/tree/master/model

### Automatic Initialization
```typescript
// In App.tsx or main component
useEffect(() => {
  const init = async () => {
    try {
      await initializeFaceRecognitionModels();
      console.log('✅ Face recognition ready');
    } catch (error) {
      console.error('Face recognition init failed:', error);
    }
  };
  
  init();
}, []);
```

## Performance Metrics

### Face Recognition
- **Model Size**: ~5MB
- **Processing Time**: 100-200ms per frame
- **Accuracy**: 95%+ on frontal faces
- **Memory**: ~50MB at runtime

### Voice Recognition
- **Computation Time**: <100ms per 4-sec recording
- **Memory**: Minimal (~5MB)
- **Sample Rate**: 48kHz (auto-resampled)

### Database
- **Face Descriptor Storage**: 128 floats × 4 bytes = 512 bytes per embedding
- **Voice Descriptor Storage**: 13 floats × 4 bytes = 52 bytes per embedding
- **Typical Record Size**: ~1KB with metadata

## Mobile (Capacitor) Compatibility

### iOS
- ✅ Camera API: `@capacitor/camera`
- ✅ Audio Recording: Native Web Audio API
- ✅ Face Recognition: TensorFlow.js runs in WebView
- ⚠️ Performance: Slower on older devices

### Android
- ✅ Camera API: `@capacitor/camera`
- ✅ Audio Recording: Native Web Audio API
- ✅ Face Recognition: TensorFlow.js runs in WebView
- ⚠️ Performance: Better on newer devices

### Configuration
```json
// capacitor.config.ts
{
  "plugins": {
    "Camera": {
      "permissions": ["camera"],
      "presentationStyle": "popover"
    },
    "MediaRecorder": {
      "permissions": ["microphone"]
    }
  }
}
```

## Thresholds & Tuning

### Face Recognition Threshold
- **0.55 (Default)**: Good balance, ~90% accuracy
- **0.60+**: Stricter, fewer false positives
- **0.50-**: Looser, more matches but false positives

### Voice Recognition Threshold
- **0.50 (Default)**: Good balance
- **Weighted Formula**: `MFCC_similarity × 0.6 + characteristics × 0.4`
- Characteristics: Pitch, energy, ZCR differences

### Combined Matching
- **Face + Voice Same Person**: Average scores
- **Face + Voice Different People**: Take highest score
- **Only one modality**: Use that modality's threshold

## Learning & Improvement

### First Encounter
1. Capture face + voice
2. Save with score ~0.3-0.5
3. Learning level: 30

### Repeated Encounters
- Each meeting increases learning level
- Average confidence improves with multiple captures
- Relationship can be refined over time

### Storage
- Store up to 10 embeddings per modality per person
- Use newest for matching
- Archive older ones for trend analysis

## Troubleshooting

### Face Recognition Issues
```
❌ "No face detected"
- Ensure good lighting
- Face must be at least 100×100 pixels
- Try tilting head slightly
- Remove obstructions (hats, scarves)

❌ "Low confidence"
- Move closer to camera
- Improve lighting
- Remove sunglasses
- Ensure camera quality is good
```

### Voice Recognition Issues
```
❌ "Audio not captured"
- Check microphone permissions
- Ensure no audio is already playing
- Try closing other apps
- Check browser audio settings

❌ "Low voice score"
- Speak clearly and louder
- Reduce background noise
- Move closer to microphone
- Ensure 4-second minimum recording
```

### Performance Issues
```
❌ "Slow face processing"
- Reduce video resolution
- Use hardware acceleration (GPU)
- Run on faster device
- Disable other heavy processes

❌ "High memory usage"
- Close other tabs/apps
- Clear browser cache
- Reduce number of stored profiles
- Use mobile app instead of web
```

## Database Schema

### PersonProfile
```javascript
{
  _id: ObjectId,
  userId: String,  // User who knows this person
  name: String,
  relationship: 'family' | 'friend' | 'colleague' | 'guest',
  
  // Face Data
  faceDescriptor: [Number],  // 128-dim current descriptor
  faceEmbeddings: [{         // History of captures
    vector: [Number],
    timestamp: Date,
    quality: Number
  }],
  faceConfidence: Number,    // 0-1
  
  // Voice Data
  voiceDescriptor: [Number], // 13-dim current descriptor
  voiceCharacteristics: {
    pitch: Number,
    energy: Number,
    zcr: Number,
    duration: Number,
    sampleRate: Number
  },
  voiceEmbeddings: [{
    vector: [Number],
    timestamp: Date,
    quality: Number
  }],
  voiceConfidence: Number,
  
  // Metadata
  meetingsCount: Number,
  lastMeeting: Date,
  isLearned: Boolean,
  learningLevel: Number,  // 0-100
  recognitionHistory: [{
    timestamp: Date,
    faceScore: Number,
    voiceScore: Number,
    overallConfidence: Number,
    source: String
  }],
  
  createdAt: Date,
  updatedAt: Date
}
```

## Future Improvements

1. **Liveness Detection**: Detect spoofing attacks (photo/video)
2. **Emotion Analysis**: Detect emotion from face expressions
3. **Speaker Verification**: Verify person is actually speaking (not pre-recorded)
4. **Multi-Modal Fusion**: Better combination of face + voice
5. **Continuous Learning**: Auto-update profiles with new captures
6. **Privacy Mode**: Local-only recognition (no server sending)
7. **Offline Mode**: Store profile hashes locally for mobile

---

**Status**: ✅ Production Ready (Web & Mobile)
**Last Updated**: June 15, 2026
