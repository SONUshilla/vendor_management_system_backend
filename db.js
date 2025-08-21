// db.js
import pkg from 'pg';
const { Pool } = pkg;

const pool = new Pool({
  user: 'postgres',
  host: 'localhost',
  database: 'vendorManagementSystem',
  password: 'Sonu@123',
  port: 5432,
});

// Test the connection
pool.connect()
  .then(client => {
    console.log("✅ Connected to PostgreSQL successfully!");
    client.release(); // release the client back to pool
  })
  .catch(err => {
    console.error("❌ Error connecting to PostgreSQL:", err.message);
  });

export default pool;

