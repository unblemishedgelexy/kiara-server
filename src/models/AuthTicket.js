const mongoose = require('mongoose');

const AuthTicketSchema = new mongoose.Schema(
  {
    ticketHash: { type: String, required: true, unique: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    accessToken: { type: String, required: true },
    refreshToken: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    consumedAt: { type: Date },
  },
  { timestamps: true }
);

AuthTicketSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.models.AuthTicket || mongoose.model('AuthTicket', AuthTicketSchema);