// routes/vendorRoutes.js
import express from "express";
import multer from "multer";
import pool from "../../db.js";
import path from "path";
import fs from "fs";
import cloudinary  from "../../cloudinary.js";

const router = express.Router();

const upload = multer({ dest: 'temp/' }); // temp folder for upload


router.post("/", upload.single("vendor_bill"), async (req, res) => {
  try {
    const {
      vendor_name,
      vendor_contact_number,
      vendor_address,
      total_amount,
    } = req.body;

    // Basic validation
    if (!vendor_name || !vendor_contact_number || !total_amount) {
      return res
        .status(400)
        .json({ error: "Name, contact, and total amount are required" });
    }

    // Parse and validate total amount
    const total = parseFloat(total_amount);
    if (Number.isNaN(total) || total < 0) {
      return res.status(400).json({ error: "Invalid total_amount" });
    }

    // Upload file to Cloudinary if exists
    let vendor_bill = null;
    if (req.file) {
      const result = await cloudinary.uploader.upload(req.file.path, {
        folder: "vendor_bills", // optional folder name in Cloudinary
      });

      vendor_bill = result.secure_url; // ✅ store Cloudinary URL
      fs.unlinkSync(req.file.path); // remove temp file
    }

    // Since we're removing paid-amount logic, vendor is created as Pending
    const status = "Pending";
    const pending_amount = total;

    // Insert vendor
    const result = await pool.query(
      `INSERT INTO vendors 
         (vendor_name, vendor_contact_number, vendor_address, vendor_bill, total_amount, pending_amount) 
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [
        vendor_name,
        vendor_contact_number,
        vendor_address,
        vendor_bill,
        total,
        pending_amount,
      ]
    );

    const vendor = result.rows[0];

    res.status(201).json({
      message: "Vendor added successfully",
      vendor: { ...vendor, status },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// PUT /transactions/:transactionId
router.put("/transactions/:transactionId", async (req, res) => {
  const transactionId = parseInt(req.params.transactionId, 10);
  const { amount, note, transaction_date } = req.body;

  if (!Number.isInteger(transactionId)) {
    return res.status(400).json({ error: "Invalid transactionId in URL" });
  }

  const amt = parseFloat(amount);
  if (Number.isNaN(amt) || amt <= 0) {
    return res.status(400).json({ error: "amount is required and must be a positive number" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Lock transaction row to get vendorId and old amount
    const txQ = await client.query(
      `SELECT transaction_id, vendor_id, amount
       FROM transactions
       WHERE transaction_id = $1
       FOR UPDATE`,
      [transactionId]
    );

    if (txQ.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Transaction not found" });
    }

    const transaction = txQ.rows[0];
    const vendorId = transaction.vendor_id;
    const oldAmount = parseFloat(transaction.amount);

    // Lock vendor row
    const vendorQ = await client.query(
      `SELECT vendor_id, total_amount, pending_amount
       FROM vendors
       WHERE vendor_id = $1
       FOR UPDATE`,
      [vendorId]
    );

    if (vendorQ.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Vendor not found" });
    }

    const vendor = vendorQ.rows[0];
    const total = parseFloat(vendor.total_amount);
    const currentPending = vendor.pending_amount !== null ? parseFloat(vendor.pending_amount) : total;

    // Adjust pending: remove old transaction, add new amount
    let newPending = currentPending + oldAmount - amt;
    if (newPending < 0) newPending = 0;
    if (newPending > total) newPending = total;

    let status;
    // Update transaction
    const txUpdate = await client.query(
      `UPDATE transactions
         SET amount = $1,
             transaction_date = COALESCE($2, transaction_date),
             note = $3
       WHERE transaction_id = $5
       RETURNING *`,
      [amt, transaction_date || null, note || null, transactionId]
    );

    // Update vendor pending_amount
    const vendorUpdate = await client.query(
      `UPDATE vendors
         SET pending_amount = $1
       WHERE vendor_id = $2
       RETURNING vendor_id, vendor_name, vendor_contact_number, vendor_address, vendor_bill, total_amount, pending_amount`,
      [newPending, vendorId]
    );

    await client.query("COMMIT");

    return res.status(200).json({
      message: "Transaction updated",
      transaction: txUpdate.rows[0],
      vendor: vendorUpdate.rows[0],
      status
    });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("Update transaction error:", err);
    return res.status(500).json({ error: "Server error" });
  } finally {
    client.release();
  }
});

// POST /vendors/:vendorId/transactions
router.post("/:vendorId/transactions", async (req, res) => {
  const vendorId = parseInt(req.params.vendorId, 10);
  const { amount, note, transaction_date } = req.body;

  if (!Number.isInteger(vendorId)) {
    return res.status(400).json({ error: "Invalid vendorId in URL" });
  }

  const amt = parseFloat(amount);
  if (Number.isNaN(amt) || amt <= 0) {
    return res.status(400).json({ error: "amount is required and must be a positive number" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // lock the vendor row to avoid race conditions
    const vendorQ = await client.query(
      `SELECT vendor_id, total_amount, pending_amount
       FROM vendors
       WHERE vendor_id = $1
       FOR UPDATE`,
      [vendorId]
    );

    if (vendorQ.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Vendor not found" });
    }

    const vendor = vendorQ.rows[0];

    // Parse numeric values (DB numeric may come as string)
    const total = parseFloat(vendor.total_amount);
    const currentPending = vendor.pending_amount !== null ? parseFloat(vendor.pending_amount) : total;

    // compute new pending (allow overpayment — pending becomes 0)
    let newPending = currentPending - amt;
    let status;
    if (newPending <= 0) {
      newPending = 0;
      status = "Paid";
    } else if (Math.abs(newPending - total) < Number.EPSILON) {
      status = "Pending";
    } else {
      status = "Partial";
    }

    // Insert transaction (use provided date if valid, else NOW())
    const txInsert = await client.query(
      `INSERT INTO transactions
         (vendor_id, transaction_date, amount, note, status)
       VALUES ($1, COALESCE($2, NOW()), $3, $4, $5)
       RETURNING *`,
      [vendorId, transaction_date || null, amt, note || null, status]
    );

    // Update vendor pending_amount (and optionally status if you store it)
    const vendorUpdate = await client.query(
      `UPDATE vendors
         SET pending_amount = $1
       WHERE vendor_id = $2
       RETURNING vendor_id, vendor_name, vendor_contact_number, vendor_address, vendor_bill, total_amount, pending_amount`,
      [newPending, vendorId]
    );

    await client.query("COMMIT");

    return res.status(201).json({
      message: "Transaction added",
      transaction: txInsert.rows[0],
      vendor: vendorUpdate.rows[0],
      status, // current status after this transaction
      overpayment: amt > currentPending ? (amt - currentPending) : 0
    });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("Add transaction error:", err);
    return res.status(500).json({ error: "Server error" });
  } finally {
    client.release();
  }
});
// DELETE /vendors/:vendorId/transactions/:transactionId
router.delete("/:vendorId/transactions/:transactionId", async (req, res) => {
  const vendorId = parseInt(req.params.vendorId, 10);
  const transactionId = parseInt(req.params.transactionId, 10);

  if (!Number.isInteger(vendorId) || !Number.isInteger(transactionId)) {
    return res.status(400).json({ error: "Invalid vendorId or transactionId" });
  }

  const client = await pool.connect();
  try {
    // Get transaction amount
    const txQ = await client.query(
      `SELECT amount FROM transactions WHERE transaction_id = $1 AND vendor_id = $2`,
      [transactionId, vendorId]
    );

    if (txQ.rowCount === 0) {
      return res.status(404).json({ error: "Transaction not found" });
    }

    const txAmount = parseFloat(txQ.rows[0].amount);

    // Delete the transaction
    await client.query(
      `DELETE FROM transactions WHERE transaction_id = $1`,
      [transactionId]
    );

    await client.query(
      `UPDATE vendors
         SET pending_amount = LEAST(GREATEST(COALESCE(pending_amount, total_amount) + $1, 0), total_amount)
       WHERE vendor_id = $2`,
      [txAmount, vendorId]
    );
    
    

    res.json({ message: "Transaction deleted" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  } finally {
    client.release();
  }
});


router.get("/", async (req, res) => {
  try {
    const vendorsResult = await pool.query(`SELECT * FROM vendors`);
    const vendors = vendorsResult.rows.map((vendor) => {
      const totalAmount = parseFloat(vendor.total_amount);
      const pendingAmount = parseFloat(vendor.pending_amount);

      let status = "Pending"; // default

      if (pendingAmount === 0) {
        status = "Paid";
      } else if (pendingAmount < totalAmount) {
        status = "Partial";
      }

      return { ...vendor, status };
    });

    res.json(vendors);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});




  // @desc    Get single vendor with status from latest transaction
router.get("/:id", async (req, res) => {
  try {
    const { id } = req.params;

    // Fetch vendor
    const vendorResult = await pool.query(
      `SELECT * FROM vendors WHERE vendor_id = $1`,
      [id]
    );

    if (vendorResult.rows.length === 0) {
      return res.status(404).json({ error: "Vendor not found" });
    }

    const vendor = vendorResult.rows[0];

    // Fetch latest transaction for this vendor
    const txResult = await pool.query(
      `SELECT *
       FROM transactions 
       WHERE vendor_id = $1 `,
      [id]
    );

    const status = txResult.rows;

    res.json({
      ...vendor,
      transactions:status,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});


  

  router.put("/:id", upload.single("vendor_bill"), async (req, res) => {
    try {
      const vendorId = req.params.id;
      const {
        vendor_name,
        vendor_contact_number,
        vendor_address,
        total_amount,
        new_paid_amount = 0,
      } = req.body;
  
      const vendorResult = await pool.query(
        "SELECT * FROM vendors WHERE vendor_id = $1",
        [vendorId]
      );
      if (vendorResult.rows.length === 0) {
        return res.status(404).json({ error: "Vendor not found" });
      }
  
      const vendor = vendorResult.rows[0];
      const updatedVendorBill = req.file ? req.file.path : vendor.vendor_bill;
  
      const total = total_amount ? parseFloat(total_amount) : parseFloat(vendor.total_amount);
      const alreadyPaid = total - parseFloat(vendor.pending_amount);
      const paid = parseFloat(new_paid_amount) || 0;
      const totalPaid = alreadyPaid + paid;
  
      let status = "Pending";
      if (totalPaid === 0) status = "Pending";
      else if (totalPaid >= total) status = "Paid";
      else status = "Partial";
  
      const pending_amount = Math.max(total - totalPaid, 0);
  
      const updateResult = await pool.query(
        `UPDATE vendors 
         SET vendor_name=$1, vendor_contact_number=$2, vendor_address=$3,
             vendor_bill=$4, total_amount=$5, pending_amount=$6
         WHERE vendor_id=$7 RETURNING *`,
        [
          vendor_name || vendor.vendor_name,
          vendor_contact_number || vendor.vendor_contact_number,
          vendor_address || vendor.vendor_address,
          updatedVendorBill,
          total,
          pending_amount,
          vendorId,
        ]
      );
  
      if (paid > 0) {
        await pool.query(
          `INSERT INTO transactions (vendor_id, transaction_date, amount, note, status) 
           VALUES ($1, NOW(), $2, $3, $4)`,
          [vendorId, paid, "Payment update", status]
        );
      }
  
      res.json({
        message: "Vendor updated successfully",
        vendor: { ...updateResult.rows[0], paid_amount: totalPaid, status },
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Server error" });
    }
  });
  

  // Delete vendor by ID
router.delete("/:id", async (req, res) => {
    const { id } = req.params;
  
    try {
      const result = await pool.query(
        `DELETE FROM vendors WHERE vendor_id = $1 RETURNING *`,
        [id]
      );
  
      if (result.rows.length === 0) {
        return res.status(404).json({ message: "Vendor not found" });
      }
  
      res.status(200).json({ message: "Vendor deleted successfully", vendor: result.rows[0] });
    } catch (error) {
      console.error("Error deleting vendor:", error);
      res.status(500).json({ message: "Server error" });
    }
  });


export default router;
