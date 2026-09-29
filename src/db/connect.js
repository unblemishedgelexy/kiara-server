const mongoose = require('mongoose');
function connectDB() {
  const mongoURI = process.env.MONGODB_URI;
  mongoose.connect(mongoURI)
    .then(() => console.log('MongoDB connected'))
    .catch((err) => console.error('MongoDB connection error:', err));
}

module.exports = connectDB;