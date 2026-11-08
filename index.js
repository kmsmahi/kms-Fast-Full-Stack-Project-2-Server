require('dotenv').config();
const express = require('express');
const { MongoClient, ServerApiVersion } = require('mongodb');
const cors = require('cors');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const app = express();
const port = process.env.PORT || 5000;

// --- Middlewares ---
app.use(cors({
  origin: ['http://localhost:5180', 'http://localhost:3000', 'http://localhost:5000'],
  credentials: true
}));
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
        const result = await cursor.toArray();
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

    // --- DELETE Parcel by ID ---
    app.delete('/parcels/:id', async (req, res) => {
      try {
        const id = req.params.id;
        const { ObjectId } = require('mongodb');
        
        let query;
        try {
          query = { _id: new ObjectId(id) };
        } catch (e) {
          query = { _id: id }; 
        }

        const result = await parcelCollection.deleteOne(query);
        res.send(result);
      } catch (error) {
        console.error('Delete Error:', error);
        res.status(500).send({ error: 'Failed to delete parcel' });
      }
    });

    // --- CREATE STRIPE PAYMENT INTENT ---
    app.post('/create-payment-intent', async (req, res) => {
      try {
        const { cost } = req.body;
        console.log('Received cost from frontend:', cost);

        let parsedCost = parseFloat(cost) || 0;
        
        // Safeguard against any fractional decimal scaling shifts (e.g. if 13.90 was passed instead of 1390)
        if (parsedCost > 0 && parsedCost < 50) {
          parsedCost = parsedCost * 100;
        }

        // Ensure the final calculated amount satisfies Stripe's minimum threshold (~৳50 equivalent)
        const finalAmount = parsedCost < 50 ? 50 : parsedCost;
        const amount = Math.round(finalAmount);

        const paymentIntent = await stripe.paymentIntents.create({
          amount: amount,
          currency: 'bdt',
        });

        res.send({
          clientSecret: paymentIntent.client_secret,
        });
      } catch (error) {
       console.error('Stripe Intent Error Details:', error.message);
        res.status(500).send({ error: error.message });
      }
    });

    // --- UPDATE PARCEL PAYMENT STATUS AFTER SUCCESS ---
    app.patch('/parcels/payment/:id', async (req, res) => {
      try {
        const id = req.params.id;
        const paymentInfo = req.body;
        const { ObjectId } = require('mongodb');

        let query;
        try {
          query = { _id: new ObjectId(id) };
        } catch (e) {
          query = { _id: id }; // Fallback if stored as string
        }

        const updateDoc = {
          $set: {
            paymentStatus: 'paid',
            transactionId: paymentInfo.transactionId,
            paidAt: new Date()
          }
        };

        const result = await parcelCollection.updateOne(query, updateDoc);
        res.send(result);
      } catch (error) {
        console.error('Payment Update Error:', error);
        res.status(500).send({ error: 'Failed to update payment status' });
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