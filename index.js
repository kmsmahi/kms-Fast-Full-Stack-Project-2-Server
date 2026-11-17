require('dotenv').config();
const express = require('express');
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const cors = require('cors');
const Stripe = require('stripe');

// --- Modular Firebase Admin Imports ---
const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const serviceAccount = require('./serviceAccountKey.json');

// --- Initialization ---
const app = express();
const port = process.env.PORT || 5000;
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const SUPER_ADMIN_EMAIL = "salauddinmahi2002@gmail.com";

// --- Firebase Admin Setup ---
try {
  if (!getApps().length) {
    initializeApp({
      credential: cert(serviceAccount)
    });
  }
} catch (error) {
  console.error('Firebase Admin Initialization Error:', error.stack);
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

// --- Strict Firebase Token Verification Middleware ---
const verifyToken = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(404).send({ error: true, message: "Not Found" });
    }

    const token = authHeader.split(" ")[1];
    if (!token || token === "null" || token === "undefined") {
      return res.status(404).send({ error: true, message: "Not Found" });
    }

    const decodedToken = await getAuth().verifyIdToken(token);
    req.decoded = decodedToken;
    next();
  } catch (error) {
    console.error("Firebase Token Verification Error:", error.message);
    return res.status(404).send({ error: true, message: "Not Found" });
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
    const riderCollection = parcelDb.collection('riders');

    // Ensure unique indexes
    await paymentCollection.createIndex({ transactionId: 1 }, { unique: true, sparse: true });
    await userCollection.createIndex({ email: 1 }, { unique: true });
    await riderCollection.createIndex({ email: 1 }, { unique: true });

    await client.db("admin").command({ ping: 1 });
    console.log("Successfully connected to MongoDB!");

    // --- Admin Verification Middleware (Inside run() so userCollection is in scope) ---
    const verifyAdmin = async (req, res, next) => {
      try {
        const email = req.decoded?.email?.toLowerCase().trim();
        if (!email) {
          return res.status(404).send({ error: true, message: "Not Found" });
        }

        if (email === SUPER_ADMIN_EMAIL) {
          return next();
        }

        const user = await userCollection.findOne({ email });
        if (user?.role !== 'admin') {
          return res.status(404).send({ error: true, message: "Not Found" });
        }

        next();
      } catch (error) {
        console.error("Verify Admin Error:", error.message);
        return res.status(404).send({ error: true, message: "Not Found" });
      }
    };

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
        const email = userInfo.email?.toLowerCase().trim();

        if (!email) {
          return res.status(400).send({ error: "User email is required." });
        }

        const isSuperAdmin = email === SUPER_ADMIN_EMAIL;

        const updateDoc = {
          $set: {
            name: userInfo.name || "Valued User",
            image: userInfo.image || "",
            ...(isSuperAdmin && { role: "admin" })
          },
          $setOnInsert: {
            email: email,
            ...(!isSuperAdmin && { role: "user" }),
            createdAt: new Date()
          }
        };

        const result = await userCollection.findOneAndUpdate(
          { email },
          updateDoc,
          { upsert: true, returnDocument: 'after' }
        );

        res.status(200).send({ success: true, message: "User synchronized successfully.", user: result });
      } catch (error) {
        console.error("Error creating/updating user:", error);
        res.status(500).send({ error: "Failed to save user profile." });
      }
    });

    // --- 2. Get User Role by Email ---
    app.get('/users/role/:email', verifyToken, async (req, res) => {
      try {
        const requestedEmail = req.params.email?.toLowerCase().trim();
        const tokenEmail = req.decoded?.email?.toLowerCase().trim();

        if (!requestedEmail || requestedEmail !== tokenEmail) {
          return res.status(404).send({ error: true, message: "Not Found" });
        }

        if (requestedEmail === SUPER_ADMIN_EMAIL) {
          return res.send({ role: "admin" });
        }

        const user = await userCollection.findOne({ email: requestedEmail });
        res.send({ role: user?.role || 'user' });
      } catch (error) {
        console.error("Error fetching user role:", error);
        res.send({ role: 'user' });
      }
    });

    // --- 3. GET All Users (Admin Only) ---
    app.get('/users', verifyToken, verifyAdmin, async (req, res) => {
      try {
        const result = await userCollection.find().sort({ createdAt: -1 }).toArray();
        res.send(result);
      } catch (error) {
        console.error("Error fetching users list:", error);
        res.status(500).send({ error: "Failed to fetch users." });
      }
    });

    // --- 4. UPDATE User Role (Promote / Demote Admin) ---
    app.patch('/users/admin/:id', verifyToken, verifyAdmin, async (req, res) => {
      try {
        const { id } = req.params;
        const { role } = req.body;

        if (!isValidObjectId(id)) {
          return res.status(400).send({ error: "Invalid user ID." });
        }

        if (!['admin', 'user', 'rider'].includes(role)) {
          return res.status(400).send({ error: "Invalid role specified." });
        }

        const targetUser = await userCollection.findOne({ _id: new ObjectId(id) });
        if (!targetUser) {
          return res.status(404).send({ error: "User not found." });
        }

        if (targetUser.email?.toLowerCase().trim() === SUPER_ADMIN_EMAIL && role !== 'admin') {
          return res.status(403).send({ error: "Cannot remove admin role from Super Admin." });
        }

        const result = await userCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: { role: role } }
        );

        res.send({
          success: true,
          message: `User role successfully updated to ${role}.`,
          modifiedCount: result.modifiedCount
        });
      } catch (error) {
        console.error("Error updating user role:", error);
        res.status(500).send({ error: "Failed to update user role." });
      }
    });

    // ==========================================
    // PARCELS & PAYMENTS APIS
    // ==========================================

    // --- GET User Parcels (Strictly scoped to logged-in user) ---
    app.get('/parcels', verifyToken, async (req, res) => {
      try {
        const tokenEmail = req.decoded?.email?.toLowerCase().trim();
        const queryEmail = req.query.email?.toLowerCase().trim();

        if (queryEmail && queryEmail !== tokenEmail) {
          return res.status(404).send({ error: true, message: "Not Found" });
        }

        const result = await parcelCollection
          .find({ senderEmail: tokenEmail })
          .sort({ createdAt: -1, creation_date: -1 })
          .toArray();

        res.send(result);
      } catch (error) {
        console.error('Error fetching parcels:', error);
        res.status(500).send({ error: 'Failed to fetch parcels' });
      }
    });

    // --- GET ALL Parcels for Admin Dashboard ---
    app.get('/parcels/admin/all', verifyToken, verifyAdmin, async (req, res) => {
      try {
        const result = await parcelCollection
          .find({})
          .sort({ createdAt: -1, creation_date: -1 })
          .toArray();

        res.send(result);
      } catch (error) {
        console.error('Error fetching all parcels for admin:', error);
        res.status(500).send({ error: 'Failed to fetch all parcels' });
      }
    });

    // --- UPDATE Parcel Delivery Status (Admin Action) ---
    app.patch('/parcels/status/:id', verifyToken, verifyAdmin, async (req, res) => {
      try {
        const { id } = req.params;
        const { status } = req.body;

        if (!isValidObjectId(id)) {
          return res.status(400).send({ error: "Invalid parcel ID." });
        }

        const allowedStatuses = ['pending', 'picked-up', 'in-transit', 'delivered', 'cancelled'];
        if (!allowedStatuses.includes(status)) {
          return res.status(400).send({ error: "Invalid parcel status." });
        }

        const result = await parcelCollection.updateOne(
          { _id: new ObjectId(id) },
          {
            $set: {
              status: status,
              updatedAt: new Date()
            }
          }
        );

        res.send({
          success: true,
          message: `Parcel status updated to ${status}.`,
          modifiedCount: result.modifiedCount
        });
      } catch (error) {
        console.error('Error updating parcel status:', error);
        res.status(500).send({ error: 'Failed to update parcel status' });
      }
    });

    // --- POST Parcel ---
    app.post('/parcels', verifyToken, async (req, res) => {
      try {
        const parcelItem = req.body;
        const newParcel = {
          ...parcelItem,
          senderEmail: req.decoded.email.toLowerCase().trim(),
          paymentStatus: "unpaid",
          status: "pending",
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

    // --- DELETE Parcel by ID (Owner check enforced) ---
    app.delete('/parcels/:id', verifyToken, async (req, res) => {
      try {
        const { id } = req.params;
        const tokenEmail = req.decoded?.email?.toLowerCase().trim();

        if (!isValidObjectId(id)) {
          return res.status(400).send({ error: true, message: "Invalid parcel ID." });
        }

        const query = { _id: new ObjectId(id) };
        const parcel = await parcelCollection.findOne(query);

        if (!parcel) {
          return res.status(404).send({ error: true, message: "Parcel not found." });
        }

        if (parcel.senderEmail?.toLowerCase().trim() !== tokenEmail) {
          return res.status(404).send({ error: true, message: "Not Found" });
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

        await parcelCollection.updateOne(
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
          customerEmail: req.decoded.email.toLowerCase().trim(),
          amount: parseFloat(paymentData.amount) || 0,
          paidAt: new Date()
        };

        try {
          await paymentCollection.insertOne(newPayment);
        } catch (insertError) {
          if (insertError.code === 11000) {
            return res.send({ success: true, message: "Payment already recorded." });
          }
          throw insertError;
        }

        if (isValidObjectId(paymentData.parcelId)) {
          await parcelCollection.updateOne(
            { _id: new ObjectId(paymentData.parcelId) },
            {
              $set: {
                paymentStatus: 'paid',
                transactionId: paymentData.transactionId,
                paidAt: new Date()
              }
            }
          );
        }

        res.status(201).send({ success: true, message: "Payment recorded successfully." });
      } catch (error) {
        console.error('Payment Recording Error:', error);
        res.status(500).send({ error: 'Failed to record payment transaction' });
      }
    });

    // --- GET PAYMENT HISTORY (Strictly scoped to logged-in user) ---
    app.get('/payments', verifyToken, async (req, res) => {
      try {
        const tokenEmail = req.decoded?.email?.toLowerCase().trim();
        const queryEmail = req.query.email?.toLowerCase().trim();

        if (queryEmail && queryEmail !== tokenEmail) {
          return res.status(404).send({ error: true, message: "Not Found" });
        }

        const result = await paymentCollection
          .find({ customerEmail: tokenEmail })
          .sort({ paidAt: -1 })
          .toArray();

        res.send(result);
      } catch (error) {
        console.error('Error fetching payment history:', error);
        res.status(500).send({ error: 'Failed to fetch payment history' });
      }
    });

    // ==========================================
    // RIDERS APIS
    // ==========================================

    // --- 1. POST Rider Application ---
    app.post('/riders', verifyToken, async (req, res) => {
      try {
        const riderData = req.body;
        const email = req.decoded.email.toLowerCase().trim();

        const existingRider = await riderCollection.findOne({ email });
        if (existingRider) {
          return res.status(400).send({ error: "An application with this email already exists." });
        }

        const newRider = {
          ...riderData,
          email,
          status: 'pending',
          appliedAt: new Date()
        };

        const result = await riderCollection.insertOne(newRider);
        res.status(201).send({ success: true, message: "Rider application submitted successfully.", insertedId: result.insertedId });
      } catch (error) {
        console.error("Error submitting rider application:", error);
        res.status(500).send({ error: "Failed to submit rider application." });
      }
    });

    // --- 2. GET All Riders (Admin Only) ---
    app.get('/riders', verifyToken, verifyAdmin, async (req, res) => {
      try {
        const status = req.query.status;
        const query = status ? { status } : {};
        const result = await riderCollection.find(query).sort({ appliedAt: -1 }).toArray();
        res.send(result);
      } catch (error) {
        console.error("Error fetching riders:", error);
        res.status(500).send({ error: "Failed to fetch riders list." });
      }
    });

    // --- 3. UPDATE Rider Status (Approve / Reject - Admin Only) ---
    app.patch('/riders/status/:id', verifyToken, verifyAdmin, async (req, res) => {
      try {
        const { id } = req.params;
        const { status } = req.body;

        if (!isValidObjectId(id)) {
          return res.status(400).send({ error: "Invalid rider ID." });
        }

        const result = await riderCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: { status: status } }
        );

        if (status === 'approved') {
          const rider = await riderCollection.findOne({ _id: new ObjectId(id) });
          if (rider?.email) {
            await userCollection.updateOne({ email: rider.email.toLowerCase().trim() }, { $set: { role: 'rider' } });
          }
        }

        res.send({ success: true, message: `Rider status updated to ${status}.`, result });
      } catch (error) {
        console.error("Error updating rider status:", error);
        res.status(500).send({ error: "Failed to update rider status." });
      }
    });

    // --- Start Server After DB Connection ---
    app.listen(port, () => {
      console.log(`Server is running on port: ${port}`);
    });

  } catch (error) {
    console.error('Failed to connect to MongoDB:', error);
  }
}
run().catch(console.dir);