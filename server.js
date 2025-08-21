import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import dotenv from "dotenv";

// Load env first
dotenv.config();

import vendorRoutes from "./src/routes/vendorRoutes.js"; // now env is ready

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(bodyParser.json()); 
app.use(cors()); 

// Base route for vendors
app.use("/api/vendors", vendorRoutes);

// Root route (optional)
app.get("/", (req, res) => {
  res.send("Vendor Management API is running 🚀");
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
