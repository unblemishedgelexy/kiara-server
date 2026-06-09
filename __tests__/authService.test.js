const authService = require('../src/services/authService');

jest.mock('../src/models/OTP', () => ({
  findOne: jest.fn(),
}));

jest.mock('../src/models/User', () => ({
  findOneAndUpdate: jest.fn(),
}));

const OTPModel = require('../src/models/OTP');
const UserModel = require('../src/models/User');

describe('authService.verifyOTP', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('marks emailVerified true for REGISTER_EMAIL OTPs', async () => {
    const otpDoc = { used: false, save: jest.fn() };
    OTPModel.findOne.mockResolvedValue(otpDoc);
    UserModel.findOneAndUpdate.mockResolvedValue({ email: 'test@gmail.com', emailVerified: true });

    const result = await authService.verifyOTP('TEST@GMAIL.COM', '123456', 'REGISTER_EMAIL');

    expect(result).toBe(true);
    expect(OTPModel.findOne).toHaveBeenCalledWith({
      identifier: 'test@gmail.com',
      code: '123456',
      type: 'REGISTER_EMAIL',
      expiresAt: expect.any(Object),
      used: false,
    });
    expect(otpDoc.used).toBe(true);
    expect(otpDoc.save).toHaveBeenCalled();
    expect(UserModel.findOneAndUpdate).toHaveBeenCalledWith(
      { email: 'test@gmail.com' },
      { emailVerified: true },
      { returnDocument: 'after' }
    );
  });

  it('does not update emailVerified for non-registration OTPs', async () => {
    const otpDoc = { used: false, save: jest.fn() };
    OTPModel.findOne.mockResolvedValue(otpDoc);

    const result = await authService.verifyOTP('test@gmail.com', '123456', 'FORGOT_PASSWORD_EMAIL');

    expect(result).toBe(true);
    expect(UserModel.findOneAndUpdate).not.toHaveBeenCalled();
    expect(otpDoc.used).toBe(true);
    expect(otpDoc.save).toHaveBeenCalled();
  });
});
