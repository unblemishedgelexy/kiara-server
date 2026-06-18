jest.mock('../src/models/PersonProfile', () => {
  // In-memory mock DB for tests; constructor's save will persist into _db
  const _db = [];

  function PersonProfile(data = {}) {
    const idStr = data._id && data._id.toString ? data._id.toString() : `new-profile-${Date.now()}-${Math.floor(Math.random()*10000)}`;
    const id = data._id || { toString: () => idStr, equals(other) { const o = other && other.toString ? other.toString() : other; return idStr === o; } };
    Object.assign(this, { _id: id, userId: data.userId || 'user1', name: data.name || null, relationship: data.relationship || 'guest', faceDescriptor: data.faceDescriptor || null, voiceDescriptor: data.voiceDescriptor || null, voiceCharacteristics: data.voiceCharacteristics || null, faceEmbeddings: data.faceEmbeddings || [], voiceEmbeddings: data.voiceEmbeddings || [], learningLevel: data.learningLevel || 0, recognitionHistory: data.recognitionHistory || [], meetingsCount: data.meetingsCount || 0, lastMeeting: data.lastMeeting || null, faceConfidence: data.faceConfidence || 0, voiceConfidence: data.voiceConfidence || 0 });

    this.save = jest.fn().mockImplementation(async () => {
      // If a profile with identical descriptors already exists for this user,
      // treat save as idempotent and return the existing profile to avoid duplicates.
      const match = _db.find((p) => p.userId === this.userId && (
        (this.faceDescriptor && p.faceDescriptor && JSON.stringify(p.faceDescriptor) === JSON.stringify(this.faceDescriptor)) ||
        (this.voiceDescriptor && p.voiceDescriptor && JSON.stringify(p.voiceDescriptor) === JSON.stringify(this.voiceDescriptor))
      ));

      if (match) {
        // merge fields into existing record
        Object.assign(match, this);
        return match;
      }

      const existingIndex = _db.findIndex((p) => p._id.toString() === this._id.toString());
      if (existingIndex === -1) {
        _db.push(this);
      } else {
        _db[existingIndex] = this;
      }
      return this;
    });

    return this;
  }

  PersonProfile._db = _db;

  PersonProfile.findById = jest.fn(async (id) => _db.find((p) => p._id.toString() === id) || null);
  PersonProfile.find = jest.fn(async (query) => {
    if (!query || !query.userId) return _db.slice();
    return _db.filter((p) => p.userId === query.userId);
  });

  PersonProfile._inFlight = new Map();
  PersonProfile.findOneAndUpdate = jest.fn(async (filter, update, options) => {
    // Find existing by matching filter keys (support exact array equality)
    const matches = (doc) => {
      for (const k of Object.keys(filter || {})) {
        const v = filter[k];
        if (Array.isArray(v)) {
          if (!Array.isArray(doc[k]) || JSON.stringify(doc[k]) !== JSON.stringify(v)) return false;
        } else {
          if (doc[k] !== v) return false;
        }
      }
      return true;
    };

    // Also support descriptorKey matching
    const matchesWithDescriptorKey = (doc) => {
      if (filter && filter.descriptorKey) {
        return doc.descriptorKey === filter.descriptorKey;
      }
      return matches(doc);
    };

    // Ensure only one upsert for the same filter runs at a time (simulate DB atomicity)
    const key = JSON.stringify(filter || {});
    const existing = _db.find(matchesWithDescriptorKey) || null;
    if (existing) return existing;

    if (options && options.upsert) {
      if (PersonProfile._inFlight.has(key)) {
        // wait for the in-flight creation to finish, then return the created doc
        await PersonProfile._inFlight.get(key);
        return _db.find(matchesWithDescriptorKey) || null;
      }

      let resolveInFlight;
      const inflightPromise = new Promise((res) => { resolveInFlight = res; });
      PersonProfile._inFlight.set(key, inflightPromise);
      try {
        const setOnInsert = (update && update.$setOnInsert) ? update.$setOnInsert : {};
        const newDoc = new (PersonProfile)(setOnInsert);
        for (const k of Object.keys(filter || {})) {
          newDoc[k] = filter[k];
        }
        await newDoc.save();
        return newDoc;
      } finally {
        resolveInFlight();
        PersonProfile._inFlight.delete(key);
      }
    }

    return null;
  });

  return PersonProfile;
});

const PersonProfile = require('../src/models/PersonProfile');
const realIdentityService = require('../src/services/realIdentityService');

describe('realIdentityService.learnPerson', () => {
  beforeEach(() => {
    // Reset the in-memory DB and mocks
    PersonProfile._db.length = 0;
    PersonProfile.findById.mockReset();
    PersonProfile.find.mockReset();
    PersonProfile.findById.mockImplementation(async (id) => PersonProfile._db.find((p) => p._id.toString() === id) || null);
    PersonProfile.find.mockImplementation(async (query) => {
      if (!query || !query.userId) return PersonProfile._db.slice();
      return PersonProfile._db.filter((p) => p.userId === query.userId);
    });
  });

  function makeProfile(overrides = {}) {
    const p = {
      _id: {
        toString() {
          return overrides._id?.toString?.() || 'profile-1';
        },
        equals(other) {
          if (!other) return false;
          return this.toString() === (other.toString ? other.toString() : other);
        },
      },
      userId: 'user1',
      name: 'Aryan',
      relationship: 'guest',
      faceDescriptor: [1, 0, 0],
      voiceDescriptor: null,
      voiceCharacteristics: null,
      faceEmbeddings: [],
      voiceEmbeddings: [],
      learningLevel: 10,
      ...overrides,
    };
    p.save = jest.fn().mockResolvedValue(p);
    return p;
  }

  it('updates the existing profile when person_id belongs to the same user', async () => {
    const profile = makeProfile({ _id: { toString: () => 'profile-1' }, name: 'Aryan', userId: 'user1', relationship: 'guest', learningLevel: 20 });
    PersonProfile.findById.mockResolvedValue(profile);

    const result = await realIdentityService.learnPerson(
      'user1',
      'profile-1',
      'Tarun',
      'friend',
      null,
      null,
      null,
    );

    expect(PersonProfile.findById).toHaveBeenCalledWith('profile-1');
    expect(profile.name).toBe('Tarun');
    expect(profile.relationship).toBe('friend');
    expect(profile.learningLevel).toBe(40);
    expect(profile.save).toHaveBeenCalled();
    expect(result.person_id).toBe('profile-1');
    expect(result.name).toBe('Tarun');
    expect(result.relationship).toBe('friend');
  });

  it('does not update a profile from a different user and creates a new profile instead', async () => {
    const foreignProfile = makeProfile({ _id: { toString: () => 'foreign-profile' }, userId: 'user2' });
    PersonProfile.findById.mockResolvedValue(foreignProfile);
    PersonProfile.find.mockResolvedValue([]);

    const result = await realIdentityService.learnPerson(
      'user1',
      'foreign-profile',
      'Tarun',
      'guest',
      null,
      null,
      null,
    );

    expect(PersonProfile.findById).toHaveBeenCalledWith('foreign-profile');
    expect(PersonProfile.find).toHaveBeenCalledWith({ userId: 'user1' });
    expect(result.person_id).toBeDefined();
    expect(result.name).toBe('Tarun');
    expect(result.relationship).toBe('guest');
  });

  it('finds and updates an existing profile using face descriptor similarity when no person_id is provided', async () => {
    const existingProfile = makeProfile({ _id: { toString: () => 'profile-2' }, name: 'Aryan', faceDescriptor: [0.3, 0.4, 0.3], learningLevel: 0 });
    PersonProfile.findById.mockResolvedValue(null);
    PersonProfile.find.mockResolvedValue([existingProfile]);

    const faceDescriptor = [0.3, 0.4, 0.3];
    const result = await realIdentityService.learnPerson(
      'user1',
      null,
      'Tarun',
      'friend',
      faceDescriptor,
      null,
      null,
    );

    expect(PersonProfile.findById).toHaveBeenCalledTimes(0);
    expect(PersonProfile.find).toHaveBeenCalledWith({ userId: 'user1' });
    expect(existingProfile.name).toBe('Tarun');
    expect(existingProfile.relationship).toBe('friend');
    expect(existingProfile.faceEmbeddings.length).toBe(1);
    expect(existingProfile.faceEmbeddings[0].vector).toEqual(faceDescriptor);
    expect(result.person_id).toBe('profile-2');
    expect(result.name).toBe('Tarun');
  });

  it('finds and updates an existing profile using voice descriptor similarity when no person_id is provided', async () => {
    const existingProfile = makeProfile({ _id: { toString: () => 'profile-3', equals(other) { return this.toString() === (other?.toString ? other.toString() : other); } }, name: 'Aryan', faceDescriptor: null, voiceDescriptor: [0.5, 0.5, 0.5], learningLevel: 5 });
    PersonProfile.findById.mockResolvedValue(null);
    PersonProfile.find.mockResolvedValue([existingProfile]);

    const voiceDescriptor = [0.5, 0.5, 0.5];
    const result = await realIdentityService.learnPerson(
      'user1',
      null,
      'Rahul',
      'colleague',
      null,
      voiceDescriptor,
      null,
    );

    expect(PersonProfile.find).toHaveBeenCalledWith({ userId: 'user1' });
    expect(existingProfile.name).toBe('Rahul');
    expect(existingProfile.relationship).toBe('colleague');
    expect(existingProfile.voiceEmbeddings.length).toBe(1);
    expect(existingProfile.voiceEmbeddings[0].vector).toEqual(voiceDescriptor);
    expect(result.person_id).toBe('profile-3');
  });

  it('when both face and voice descriptors match the same profile, confidence/learning increases and person_id preserved', async () => {
    const existingProfile = makeProfile({ _id: { toString: () => 'profile-4', equals(other) { return this.toString() === (other?.toString ? other.toString() : other); } }, name: 'Aryan', faceDescriptor: [0.2, 0.2, 0.2], voiceDescriptor: [0.2, 0.2, 0.2], learningLevel: 0 });
    PersonProfile.findById.mockResolvedValue(null);
    PersonProfile.find.mockResolvedValue([existingProfile]);

    const faceDescriptor = [0.2, 0.2, 0.2];
    const voiceDescriptor = [0.2, 0.2, 0.2];

    const result = await realIdentityService.learnPerson(
      'user1',
      null,
      'Tarun',
      'friend',
      faceDescriptor,
      voiceDescriptor,
      null,
    );

    expect(result.person_id).toBe('profile-4');
    expect(existingProfile.faceEmbeddings.length).toBe(1);
    expect(existingProfile.voiceEmbeddings.length).toBe(1);
    expect(existingProfile.learningLevel).toBeGreaterThan(0);
  });

  it('creates a new profile when descriptors do not match any existing profile (different face)', async () => {
    PersonProfile.findById.mockResolvedValue(null);
    // existing profiles have very different descriptors
    const existingProfile = makeProfile({ _id: { toString: () => 'profile-5', equals(other) { return this.toString() === (other?.toString ? other.toString() : other); } }, faceDescriptor: [0, 0, 0], voiceDescriptor: [0, 0, 0] });
    PersonProfile.find.mockResolvedValue([existingProfile]);

    const faceDescriptor = [1, 1, 1];
    const result = await realIdentityService.learnPerson('user1', null, 'NewGuy', 'guest', faceDescriptor, null, null);

    expect(PersonProfile.find).toHaveBeenCalledWith({ userId: 'user1' });
    expect(result.person_id).toBeDefined();
    expect(result.person_id).not.toBe('profile-5');
  });

  it('creates a new profile when voice descriptor does not match any existing profile (different voice)', async () => {
    PersonProfile.findById.mockResolvedValue(null);
    const existingProfile = makeProfile({ _id: { toString: () => 'profile-6', equals(other) { return this.toString() === (other?.toString ? other.toString() : other); } }, faceDescriptor: null, voiceDescriptor: [0, 0, 0] });
    PersonProfile.find.mockResolvedValue([existingProfile]);

    const voiceDescriptor = [1, 1, 1];
    const result = await realIdentityService.learnPerson('user1', null, 'NewVoice', 'guest', null, voiceDescriptor, null);

    expect(result.person_id).toBeDefined();
    expect(result.person_id).not.toBe('profile-6');
  });

  it('logs a warning when face and voice match different existing profiles and does not create a duplicate', async () => {
    PersonProfile.findById.mockResolvedValue(null);
    const faceMatch = makeProfile({ _id: { toString: () => 'face-match', equals(other) { return this.toString() === (other?.toString ? other.toString() : other); } }, faceDescriptor: [0.9, 0.9, 0.9], voiceDescriptor: null });
    const voiceMatch = makeProfile({ _id: { toString: () => 'voice-match', equals(other) { return this.toString() === (other?.toString ? other.toString() : other); } }, faceDescriptor: null, voiceDescriptor: [0.9, 0.9, 0.9] });
    PersonProfile.find.mockResolvedValue([faceMatch, voiceMatch]);

    const faceDescriptor = [0.9, 0.9, 0.9];
    const voiceDescriptor = [0.9, 0.9, 0.9];

    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await realIdentityService.learnPerson('user1', null, 'Mixed', 'guest', faceDescriptor, voiceDescriptor, null);

    // should pick one of the matches, not create a new profile
    expect(result.person_id === 'face-match' || result.person_id === 'voice-match').toBeTruthy();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  describe('concurrent learning', () => {
    it('creates only one profile for multiple simultaneous face-only learnPerson calls', async () => {
      PersonProfile.findById.mockResolvedValue(null);

      const faceDescriptor = [0.11, 0.22, 0.33];

      const calls = Array.from({ length: 4 }).map(() => realIdentityService.learnPerson('user1', null, 'Concurrent', 'friend', faceDescriptor, null, null));

      const results = await Promise.all(calls);

      expect(PersonProfile._db.length).toBe(1);
      const unique = new Set(results.map((r) => r.person_id));
      expect(unique.size).toBe(1);
      expect(PersonProfile._db[0].faceEmbeddings.length).toBe(1);
    });

    it('creates only one profile for multiple simultaneous voice-only learnPerson calls', async () => {
      PersonProfile.findById.mockResolvedValue(null);

      const voiceDescriptor = [0.4, 0.5, 0.6];

      const calls = Array.from({ length: 6 }).map(() => realIdentityService.learnPerson('user1', null, 'ConcurrentVoice', 'colleague', null, voiceDescriptor, null));

      const results = await Promise.all(calls);

      expect(PersonProfile._db.length).toBe(1);
      const unique = new Set(results.map((r) => r.person_id));
      expect(unique.size).toBe(1);
      expect(PersonProfile._db[0].voiceEmbeddings.length).toBe(1);
    });

    it('creates only one profile for multiple simultaneous face+voice learnPerson calls', async () => {
      PersonProfile.findById.mockResolvedValue(null);

      const faceDescriptor = [0.7, 0.8, 0.9];
      const voiceDescriptor = [0.7, 0.8, 0.9];

      const calls = Array.from({ length: 8 }).map(() => realIdentityService.learnPerson('user1', null, 'Both', 'friend', faceDescriptor, voiceDescriptor, null));

      const results = await Promise.all(calls);

      expect(PersonProfile._db.length).toBe(1);
      const unique = new Set(results.map((r) => r.person_id));
      expect(unique.size).toBe(1);
      expect(PersonProfile._db[0].faceEmbeddings.length).toBe(1);
      expect(PersonProfile._db[0].voiceEmbeddings.length).toBe(1);
    });

    it('handles explicit teaching and passive recognition concurrently', async () => {
      PersonProfile.findById.mockResolvedValue(null);

      const faceDescriptor = [0.12, 0.13, 0.14];

      // One requester provides name (explicit teaching), other is passive (no name)
      const teach = realIdentityService.learnPerson('user1', null, 'Teacher', 'mentor', faceDescriptor, null, null);
      const passive = realIdentityService.learnPerson('user1', null, null, null, faceDescriptor, null, null);

      const [rTeach, rPassive] = await Promise.all([teach, passive]);

      expect(PersonProfile._db.length).toBe(1);
      const unique = new Set([rTeach.person_id, rPassive.person_id]);
      expect(unique.size).toBe(1);
      expect(PersonProfile._db[0].name).toBe('Teacher');
    });

    it('stress test: 20 parallel learn requests resolve to same person and single profile stored', async () => {
      PersonProfile.findById.mockResolvedValue(null);

      const faceDescriptor = [0.21, 0.22, 0.23];

      const calls = Array.from({ length: 20 }).map((_, i) => realIdentityService.learnPerson('user1', null, `Stress${i}`, 'guest', faceDescriptor, null, null));

      const results = await Promise.all(calls);

      expect(PersonProfile._db.length).toBe(1);
      const unique = new Set(results.map((r) => r.person_id));
      expect(unique.size).toBe(1);
      // Ensure no duplicate embeddings
      expect(PersonProfile._db[0].faceEmbeddings.length).toBe(1);
    });

    it('retries and network duplicates do not create additional PersonProfiles', async () => {
      PersonProfile.findById.mockResolvedValue(null);

      const faceDescriptor = [0.31, 0.32, 0.33];

      // Simulate idempotent retries: repeat same calls multiple times
      const batch1 = Array.from({ length: 5 }).map(() => realIdentityService.learnPerson('user1', null, 'Retry', 'guest', faceDescriptor, null, null));
      const batch2 = Array.from({ length: 5 }).map(() => realIdentityService.learnPerson('user1', null, 'Retry', 'guest', faceDescriptor, null, null));

      const results = await Promise.all(batch1.concat(batch2));

      expect(PersonProfile._db.length).toBe(1);
      const unique = new Set(results.map((r) => r.person_id));
      expect(unique.size).toBe(1);
    });
  });
});
