require('dotenv').config();
const express = require('express');
const { MongoClient, ServerApiVersion } = require('mongodb');
const cors = require('cors');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const app = express();
const port = process.env.PORT || 5000;
const { ObjectId } = require("mongodb");
// --- Middlewares ---
app.use(cors({
  origin: ['http://localhost:5174', 'http://localhost:3000', 'http://localhost:5000'],
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
    const paymentCollection=parcelDb.collection('payments');
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

    // // --- CREATE STRIPE PAYMENT INTENT ---
    // app.post('/create-payment-intent', async (req, res) => {
    //   try {
    //     const { cost } = req.body;
    //     console.log('Received cost from frontend:', cost);

    //     let parsedCost = parseFloat(cost) || 0;
        
    //     // Safeguard against any fractional decimal scaling shifts (e.g. if 13.90 was passed instead of 1390)
    //     if (parsedCost > 0 && parsedCost < 50) {
    //       parsedCost = parsedCost * 100;
    //     }

    //     // Ensure the final calculated amount satisfies Stripe's minimum threshold (~৳50 equivalent)
    //     const finalAmount = parsedCost < 50 ? 50 : parsedCost;
    //     const amount = Math.round(finalAmount);

    //     const paymentIntent = await stripe.paymentIntents.create({
    //       amount: amount,
    //       currency: 'bdt',
    //     });

    //     res.send({
    //       clientSecret: paymentIntent.client_secret,
    //     });
    //   } catch (error) {
    //    console.error('Stripe Intent Error Details:', error.message);
    //     res.status(500).send({ error: error.message });
    //   }
    // });

    // // --- UPDATE PARCEL PAYMENT STATUS AFTER SUCCESS ---
    // app.patch('/parcels/payment/:id', async (req, res) => {
    //   try {
    //     const id = req.params.id;
    //     const paymentInfo = req.body;
    //     const { ObjectId } = require('mongodb');

    //     let query;
    //     try {
    //       query = { _id: new ObjectId(id) };
    //     } catch (e) {
    //       query = { _id: id }; // Fallback if stored as string
    //     }

    //     const updateDoc = {
    //       $set: {
    //         paymentStatus: 'paid',
    //         transactionId: paymentInfo.transactionId,
    //         paidAt: new Date()
    //       }
    //     };

    //     const result = await parcelCollection.updateOne(query, updateDoc);
    //     res.send(result);
    //   } catch (error) {
    //     console.error('Payment Update Error:', error);
    //     res.status(500).send({ error: 'Failed to update payment status' });
    //   }
    // });

    // CREATE PAYMENT INTENT
app.post("/create-payment-intent", async (req, res) => {
    try {
        const { parcelId } = req.body;

        if (!ObjectId.isValid(parcelId)) {
            return res.status(400).send({ error: "Invalid parcel ID" });
        }

        const parcel = await parcelCollection.findOne({
            _id: new ObjectId(parcelId)
        });

        if (!parcel) {
            return res.status(404).send({ error: "Parcel not found" });
        }

        if (parcel.paymentStatus === "paid") {
            return res.status(400).send({ error: "Parcel already paid" });
        }

        const cost = Number(parcel.cost);

        if (!Number.isFinite(cost) || cost <= 0) {
            return res.status(400).send({ error: "Invalid parcel amount" });
        }

        // BDT uses two decimal places
        const amount = Math.round(cost * 100);

        const paymentIntent = await stripe.paymentIntents.create({
            amount,
            currency: "bdt",
            metadata: {
                parcelId: parcel._id.toString()
            }
        });

        res.send({
            clientSecret: paymentIntent.client_secret
        });

    } catch (error) {
        console.error("Stripe Intent Error:", error.message);

        res.status(500).send({
            error: error.message
        });
    }
});


// VERIFY PAYMENT AND UPDATE PARCEL
app.patch("/parcels/payment/:id", async (req, res) => {
    try {
        const { id } = req.params;
        const { transactionId } = req.body;

        if (!ObjectId.isValid(id) || !transactionId) {
            return res.status(400).send({
                error: "Invalid payment information"
            });
        }

        // Verify directly with Stripe
        const paymentIntent = await stripe.paymentIntents.retrieve(
            transactionId
        );

        if (paymentIntent.status !== "succeeded") {
            return res.status(400).send({
                error: "Payment has not been completed"
            });
        }

        // Verify that this payment belongs to this parcel
        if (paymentIntent.metadata.parcelId !== id) {
            return res.status(400).send({
                error: "Payment does not match this parcel"
            });
        }

        const parcel = await parcelCollection.findOne({
            _id: new ObjectId(id)
        });

        if (!parcel) {
            return res.status(404).send({
                error: "Parcel not found"
            });
        }

        if (parcel.paymentStatus === "paid") {
            return res.status(409).send({
                error: "Parcel already paid"
            });
        }

        // Verify the actual charged amount
        const expectedAmount = Math.round(Number(parcel.cost) * 100);

        if (paymentIntent.amount !== expectedAmount ||
            paymentIntent.currency !== "bdt") {
            return res.status(400).send({
                error: "Payment amount mismatch"
            });
        }

        const result = await parcelCollection.updateOne(
            {
                _id: new ObjectId(id),
                paymentStatus: { $ne: "paid" }
            },
            {
                $set: {
                    paymentStatus: "paid",
                    transactionId: paymentIntent.id,
                    paidAt: new Date()
                }
            }
        );

        if (result.modifiedCount === 0) {
            return res.status(409).send({
                error: "Payment status could not be updated"
            });
        }

        res.send({
            success: true,
            message: "Payment verified successfully"
        });

    } catch (error) {
        console.error("Payment Verification Error:", error.message);

        res.status(500).send({
            error: "Payment verification failed"
        });
    }
});

    //  Record Payment & Update Parcel on Successful Checkout / Mobile Payment ---
    app.post('/payments', async (req, res) => {
      try {
        const paymentData = req.body;
        // paymentData should include: parcelId, parcelName, customerEmail, amount, transactionId, method, paidAt

        const newPayment = {
          ...paymentData,
          amount: parseFloat(paymentData.amount) || 0,
          paidAt: new Date()
        };

        const insertResult = await paymentCollection.insertOne(newPayment);

        // Also mark parcel as paid
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

        res.send({ success: true, insertResult });
      } catch (error) {
        console.error('Payment Recording Error:', error);
        res.status(500).send({ error: 'Failed to record payment transaction' });
      }
    });


    app.get('/payments', async (req, res) => {
      try {
        const email = req.query.email;
        let query = {};
        if (email) {
          query = { customerEmail: email };
        }
        const options = { sort: { paidAt: -1 } }; // Newest transactions first
        const cursor = paymentCollection.find(query, options);
        const result = await cursor.toArray();
        res.send(result);
      } catch (error) {
        console.error('Error fetching payment history:', error);
        res.status(500).send({ error: 'Failed to fetch payment history' });
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