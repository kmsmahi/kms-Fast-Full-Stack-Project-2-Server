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
    // Connect the client to the server
    await client.connect();
    const parcelDb = client.db('parcelDb');
    const parcelCollection = parcelDb.collection('parcels');

    // --- GET Parcels (Supports filtering by email: /parcels?email=user@gmail.com) ---
    app.get('/parcels', async (req, res) => {
      try {
        const email = req.query.email;
        let query = {};
        if (email) {
          query = { senderEmail: email };
        }
        const cursor = parcelCollection.find(query);
        const result = await cursor.toArray(); // 👈 Fixed missing await
        res.send(result);   
      } catch (error) {
        console.error('Error fetching parcels:', error);
        res.status(500).send({ error: 'Failed to fetch parcels' });
      }
    });

    // --- POST Parcel ---
    app.post('/parcels', async (req, res) => {
      try {
        const parcelItem = req.body;
        console.log('Received parcel payload:', parcelItem);
        const result = await parcelCollection.insertOne(parcelItem);
        res.send(result);
      } catch (error) {
        console.error('MongoDB Insert Error:', error);
        res.status(500).send({ error: 'Failed to insert parcel' });
      }
    });

    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log("Successfully connected to MongoDB!");

  } catch (error) {
    console.error('Failed to connect to MongoDB:', error);
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