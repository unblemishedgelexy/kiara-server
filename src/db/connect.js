const mongoose = require('mongoose');

async function connectDB() {
  const mongoURI = process.env.MONGODB_URI;

  if (!mongoURI) {
    console.error('MongoDB connection URI missing');
    return false;
  }

  try {
    await mongoose.connect(mongoURI);
    console.log('MongoDB connected');
    return true;
  } catch (err) {
    console.error('MongoDB connection error:', err);
    return false;
  }
}

module.exports = connectDB;