require("dotenv").config();
const mongoose = require("mongoose");

const uri = process.env.MONGODB_URI;

if (!uri) {
  console.error("MONGODB_URI is missing");
  process.exit(1);
}

console.log("Testing connection to configured MongoDB...");

mongoose.connect(uri, {
  serverSelectionTimeoutMS: 10000,
})
.then(async () => {
  console.log("MONGO_CONNECT_SUCCESS");
  await mongoose.disconnect();
  console.log("MONGO_DISCONNECT_SUCCESS");
  process.exit(0);
})
.catch(async (error) => {
  console.error("MONGO_CONNECT_FAILED");
  console.error("Name:", error.name);
  console.error("Code:", error.code || "UNKNOWN");
  try {
    await mongoose.disconnect();
  } catch {}
  process.exit(1);
});
