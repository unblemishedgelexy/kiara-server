const realIdentityService = require('../src/services/realIdentityService');
const { learnPersonController } = require('../src/controllers/identityController');

jest.mock('../src/services/realIdentityService', () => ({
  learnPerson: jest.fn(),
}));

describe('identityController', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('passes person_id through to realIdentityService.learnPerson', async () => {
    const req = {
      userId: 'user1',
      body: {
        person_id: 'person-123',
        name: 'Tarun',
        relationship: 'friend',
        face_descriptor: [0.1, 0.2, 0.3],
        voice_descriptor: [0.3, 0.2, 0.1],
        voice_characteristics: { pitch: 120, energy: 0.6, zcr: 0.1 },
      },
    };
    const res = {
      json: jest.fn(),
      status: jest.fn().mockReturnThis(),
    };
    const next = jest.fn();

    realIdentityService.learnPerson.mockResolvedValue({ success: true, person_id: 'person-123' });

    await learnPersonController(req, res, next);

    expect(realIdentityService.learnPerson).toHaveBeenCalledWith(
      'user1',
      'person-123',
      'Tarun',
      'friend',
      [0.1, 0.2, 0.3],
      [0.3, 0.2, 0.1],
      { pitch: 120, energy: 0.6, zcr: 0.1 },
    );
    expect(res.json).toHaveBeenCalledWith({ success: true, person_id: 'person-123' });
    expect(next).not.toHaveBeenCalled();
  });
});
