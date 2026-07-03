import bcrypt from "bcryptjs";
import { getGlobalDb } from "../src/db/global-db.js";
import { createUser } from "../src/db/user-store.js";

const [displayName, password] = process.argv.slice(2);

if (!displayName || !password) {
  console.error("Usage: npm run user:create -- <displayName> <password>");
  process.exit(1);
}

const db = getGlobalDb();
const passwordHash = bcrypt.hashSync(password, 10);
const user = createUser(db, displayName, passwordHash);

console.log(`Created user "${user.displayName}" (id: ${user.id})`);
