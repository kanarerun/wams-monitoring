import { createClient } from "@libsql/client";
import dotenv from "dotenv";
dotenv.config();

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

const r = await db.execute("SELECT student_id, length(student_id) AS len, status FROM students LIMIT 15");
console.log(JSON.stringify(r.rows, null, 1));
