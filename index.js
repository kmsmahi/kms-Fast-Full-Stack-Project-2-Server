const express = require('express');
const { MongoClient, ServerApiVersion } = require('mongodb');
const cors = require('cors');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 5000;

// --- Middlewares ---
app.use(cors());
app.use(express.json());

// --- MongoDB Connection Setup ---
const uri = process.env.MONGODB_URI;

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  }
});

async function run() {
  try {
    // Connect the client to the server (optional starting in v4.7)
    await client.connect();
    
    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log("Successfully connected to MongoDB!");

    // --- Define API Routes Here ---
    // Example:
    // const database = client.db("kms_fast_db");
    // const parcelsCollection = database.collection("parcels");

  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}
run().catch(console.dir);

// --- Base Route ---
app.get('/', (req, res) => {
  res.send('KMS-FAST Server is running smoothly...');
});

// --- Start Server ---
app.listen(port, () => {
  console.log(`Server is running on port: ${port}`);
});