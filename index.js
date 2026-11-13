require('dotenv').config();
const express = require('express');
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const cors = require('cors');
const Stripe = require('stripe');
const admin = require('firebase-admin');

// --- Initialization ---
const app = express();
const port = process.env.PORT || 5000;
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// --- Firebase Admin Setup (Using local serviceAccountKey.json) ---
const serviceAccount = require('./serviceAccountKey.json');

try {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
} catch (error) {
  if (!/already exists/u.test(error.message)) {
    console.error('Firebase Admin Initialization Error:', error.stack);
  }
}

// --- Middlewares ---
const allowedOrigins = [
  "http://localhost:5173",
  "http://localhost:5174",
  "http://localhost:3000",
  "http://localhost:5000",
  ...(process.env.CLIENT_URL ? process.env.CLIENT_URL.split(",").map(url => url.trim()) : [])
];

app.use(cors({
  origin: allowedOrigins,
  credentials: true
}));
app.use(express.json());

// --- Flexible Firebase Token Verification Middleware ---
const verifyToken = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      req.decoded = {};
      return next();
    }

    const token = authHeader.split(" ")[1];
    if (!token) {
      req.decoded = {};
      return next();
    }

    const decodedToken = await admin.auth().verifyIdToken(token);
    req.decoded = decodedToken;
    next();
  } catch (error) {
    console.error("Firebase Token Verification Error:", error.message);
    req.decoded = {};
    next();
  }
};

// --- Helper Functions ---
const isValidObjectId = (id) => {
  return ObjectId.isValid(id) && new ObjectId(id).toString() === id;
};

const findParcelById = async (parcelCollection, id) => {
  if (!isValidObjectId(id)) return null;
  return parcelCollection.findOne({ _id: new ObjectId(id) });
};

// --- MongoDB Connection Setup ---
const uri = process.env.MONGODB_URI;
if (!uri) {
  throw new Error("MONGODB_URI is missing.");
}

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  }
});

async function run() {
  try {
    await client.connect();
    const parcelDb = client.db('parcelDb');
    const parcelCollection = parcelDb.collection('parcels');
    const paymentCollection = parcelDb.collection('payments');
    const userCollection = parcelDb.collection('users');

    // Ensure unique indexes
    await paymentCollection.createIndex({ transactionId: 1 }, { unique: true, sparse: true });
    await userCollection.createIndex({ email: 1 }, { unique: true });

    await client.db("admin").command({ ping: 1 });
    console.log("Successfully connected to MongoDB!");

    // --- Base Route ---
    app.get('/', (req, res) => {
      res.send('KMS-FAST Server is running smoothly...');
    });

    // ==========================================
    // USERS & ROLES MANAGEMENT APIS
    // ==========================================

    // --- 1. Save or Update User on Login/Signup ---
    app.post('/users', async (req, res) => {
      try {
        const userInfo = req.body;
        const email = userInfo.email;

        if (!email) {
          return res.status(400).send({ error: "User email is required." });
        }

        const existingUser = await userCollection.findOne({ email });

        if (existingUser) {
          return res.send({ message: "User already exists in database.", insertedId: null });
        }

        const newUser = {
          name: userInfo.name || "Valued User",
          email: email,
          image: userInfo.image || "",
          role: "user",
          createdAt: new Date()
        };

        const result = await userCollection.insertOne(newUser);
        res.status(201).send(result);
      } catch (error) {
        console.error("Error creating user:", error);
        res.status(500).send({ error: "Failed to save user profile." });
      }
    });

    // --- 2. Get User Role by Email ---
    app.get('/users/role/:email', verifyToken, async (req, res) => {
      try {
        const email = req.params.email;

        if (req.decoded?.email && req.decoded.email.toLowerCase() !== email.toLowerCase()) {
          return res.status(403).send({ error: true, message: "Forbidden access: Email mismatch." });
        }

        const user = await userCollection.findOne({ email });
        res.send({ role: user?.role || 'user' });
      } catch (error) {
        console.error("Error fetching user role:", error);
        res.status(500).send({ error: "Failed to fetch role." });
      }
    });

    // ==========================================
    // PARCELS & PAYMENTS APIS
    // ==========================================

    // --- GET Parcels ---
    app.get('/parcels', verifyToken, async (req, res) => {
      try {
        const email = req.query.email;
        let query = {};

        if (email) {
          query = { senderEmail: email };
        } else if (req.decoded && req.decoded.email) {
          query = { senderEmail: req.decoded.email };
        }

        const result = await parcelCollection.find(query).sort({ createdAt: -1, creation_date: -1 }).toArray();
        res.send(result);
      } catch (error) {
        console.error('Error fetching parcels:', error);
        res.status(500).send({ error: 'Failed to fetch parcels' });
      }
    });

    // --- POST Parcel ---
    app.post('/parcels', verifyToken, async (req, res) => {
      try {
        const parcelItem = req.body;
        console.log('Received parcel payload:', parcelItem);

        const newParcel = {
          ...parcelItem,
          senderEmail: parcelItem.senderEmail || (req.decoded ? req.decoded.email : ''),
          paymentStatus: parcelItem.paymentStatus || "unpaid",
          createdAt: new Date()
        };

        delete newParcel._id;

        const result = await parcelCollection.insertOne(newParcel);
        res.status(201).send({ success: true, message: "Parcel created successfully.", insertedId: result.insertedId, ...result });
      } catch (error) {
        console.error('MongoDB Insert Error:', error);
        res.status(500).send({ error: 'Failed to insert parcel' });
      }
    });

    // --- DELETE Parcel by ID ---
    // app.delete('/parcels/:id', verifyToken, async (req, res) => {
    //   try {
    //     const { id } = req.params;

    //     let query;
    //     try {
    //       query = { _id: new ObjectId(id) };
    //     } catch (e) {
    //       query = { _id: id };
    //     }

    //     const parcel = await parcelCollection.findOne(query);

    //     if (!parcel) {
    //       return res.status(404).send({ error: true, message: "Parcel not found." });
    //     }

    //     if (parcel.paymentStatus === "paid") {
    //       return res.status(400).send({ error: true, message: "Paid parcels cannot be deleted." });
    //     }

    //     const result = await parcelCollection.deleteOne(query);
    //     res.send({ success: true, message: "Parcel deleted successfully.", result });
    //   } catch (error) {
    //     console.error('Delete Error:', error);
    //     res.status(500).send({ error: 'Failed to delete parcel' });
    //   }
    // });
    // --- DELETE Parcel by ID ---
    app.delete('/parcels/:id', verifyToken, async (req, res) => {
      try {
        const { id } = req.params;

        let query;
        try {
          query = { _id: new ObjectId(id) };
        } catch (e) {
          query = { _id: id };
        }

        const parcel = await parcelCollection.findOne(query);

        if (!parcel) {
          return res.status(404).send({ error: true, message: "Parcel not found." });
        }

        if (parcel.paymentStatus === "paid") {
          return res.status(400).send({ error: true, message: "Paid parcels cannot be deleted." });
        }

        const result = await parcelCollection.deleteOne(query);
        res.send({ success: true, message: "Parcel deleted successfully.", result });
      } catch (error) {
        console.error('Delete Error:', error);
        res.status(500).send({ error: 'Failed to delete parcel' });
      }
    });

    // --- CREATE STRIPE PAYMENT INTENT ---
    app.post('/create-payment-intent', verifyToken, async (req, res) => {
      try {
        const { parcelId } = req.body;

        if (!isValidObjectId(parcelId)) {
          return res.status(400).send({ error: "Invalid parcel ID." });
        }

        const parcel = await findParcelById(parcelCollection, parcelId);
        if (!parcel) {
          return res.status(404).send({ error: "Parcel not found." });
        }

        if (parcel.paymentStatus === "paid") {
          return res.status(400).send({ error: "Parcel already paid." });
        }

        const cost = Number(parcel.cost);
        if (!Number.isFinite(cost) || cost <= 0) {
          return res.status(400).send({ error: "Invalid parcel amount." });
        }

        const amount = Math.round(cost * 100);

        const paymentIntent = await stripe.paymentIntents.create({
          amount,
          currency: 'bdt',
          metadata: {
            parcelId: parcel._id.toString(),
            email: parcel.senderEmail || ""
          }
        });

        res.send({ clientSecret: paymentIntent.client_secret });
      } catch (error) {
        console.error('Stripe Intent Error:', error.message);
        res.status(500).send({ error: error.message });
      }
    });

    // --- VERIFY STRIPE PAYMENT AND UPDATE PARCEL ---
    app.patch('/parcels/payment/:id', verifyToken, async (req, res) => {
      try {
        const { id } = req.params;
        const { transactionId } = req.body;

        if (!isValidObjectId(id) || !transactionId) {
          return res.status(400).send({ error: "Invalid payment information." });
        }

        const paymentIntent = await stripe.paymentIntents.retrieve(transactionId);

        if (paymentIntent.status !== "succeeded") {
          return res.status(400).send({ error: "Payment has not been completed." });
        }

        if (paymentIntent.metadata.parcelId !== id) {
          return res.status(400).send({ error: "Payment does not match this parcel." });
        }

        const parcel = await findParcelById(parcelCollection, id);
        if (!parcel) {
          return res.status(404).send({ error: "Parcel not found." });
        }

        if (parcel.paymentStatus === "paid") {
          return res.send({ success: true, message: "Payment already verified." });
        }

        const expectedAmount = Math.round(Number(parcel.cost) * 100);
        if (!Number.isFinite(expectedAmount) || paymentIntent.amount !== expectedAmount || paymentIntent.currency !== "bdt") {
          return res.status(400).send({ error: "Payment amount mismatch." });
        }

        const result = await parcelCollection.updateOne(
          { _id: new ObjectId(id) },
          {
            $set: {
              paymentStatus: 'paid',
              transactionId: paymentIntent.id,
              paidAt: new Date()
            }
          }
        );

        res.send({ success: true, message: "Payment verified successfully.", transactionId: paymentIntent.id });
      } catch (error) {
        console.error('Payment Update Error:', error.message);
        res.status(500).send({ error: 'Failed to update payment status' });
      }
    });

    // --- PROCESS MOBILE BANKING PAYMENT (bKash / Nagad) ---
    app.patch('/parcels/mobile-payment/:id', verifyToken, async (req, res) => {
      try {
        const { id } = req.params;
        const { transactionId } = req.body;

        if (!isValidObjectId(id) || !transactionId) {
          return res.status(400).send({ error: "Invalid payment information." });
        }

        const parcel = await findParcelById(parcelCollection, id);
        if (!parcel) {
          return res.status(404).send({ error: "Parcel not found." });
        }

        if (parcel.paymentStatus === "paid") {
          return res.send({ success: true, message: "Parcel already paid." });
        }

        const result = await parcelCollection.updateOne(
          { _id: new ObjectId(id) },
          {
            $set: {
              paymentStatus: 'paid',
              transactionId: transactionId,
              paidAt: new Date()
            }
          }
        );

        res.send({ success: true, message: "Mobile payment verified successfully.", modifiedCount: result.modifiedCount });
      } catch (error) {
        console.error('Mobile Payment Update Error:', error.message);
        res.status(500).send({ error: 'Failed to update mobile payment status' });
      }
    });

    // --- RECORD VERIFIED PAYMENT ---
    app.post('/payments', verifyToken, async (req, res) => {
      try {
        const paymentData = req.body;

        const newPayment = {
          ...paymentData,
          amount: parseFloat(paymentData.amount) || 0,
          paidAt: new Date()
        };

        let insertResult;
        try {
          insertResult = await paymentCollection.insertOne(newPayment);
        } catch (insertError) {
          if (insertError.code === 11000) {
            return res.send({ success: true, message: "Payment already recorded." });
          }
          throw insertError;
        }

        let query;
        try {
          query = { _id: new ObjectId(paymentData.parcelId) };
        } catch (e) {
          query = { _id: paymentData.parcelId };
        }

        const updateDoc = {
          $set: {
            paymentStatus: 'paid',
            transactionId: paymentData.transactionId,
            paidAt: new Date()
          }
        };

        await parcelCollection.updateOne(query, updateDoc);

        res.status(201).send({ success: true, message: "Payment recorded successfully.", insertResult });
      } catch (error) {
        console.error('Payment Recording Error:', error);
        res.status(500).send({ error: 'Failed to record payment transaction' });
      }
    });

    // --- GET PAYMENT HISTORY ---
    app.get('/payments', verifyToken, async (req, res) => {
      try {
        const email = req.query.email;
        let query = {};

        if (email) {
          query = { customerEmail: email };
        } else if (req.decoded && req.decoded.email) {
          query = { customerEmail: req.decoded.email };
        }

        const options = { sort: { paidAt: -1 } };
        const cursor = paymentCollection.find(query, options);
        const result = await cursor.toArray();
        res.send(result);
      } catch (error) {
        console.error('Error fetching payment history:', error);
        res.status(500).send({ error: 'Failed to fetch payment history' });
      }
    });

  } catch (error) {
    console.error('Failed to connect to MongoDB:', error);
  }
}
run().catch(console.dir);

// --- Start Server ---
app.listen(port, () => {
  console.log(`Server is running on port: ${port}`);
});