import Database from "better-sqlite3";
import crypto from "crypto";
import os from "os";

export class PopStateTracker {
  private db: Database.Database;
  private encryptionKey: Buffer;
  dailySpendTotal: number;

  constructor(dbPath: string = "pop_state.db") {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.encryptionKey = this.deriveEncryptionKey();
    this.initDb();
    this.dailySpendTotal = this.getTodaySpent();
  }

  private deriveEncryptionKey(): Buffer {
    const envKey = process.env.POP_STATE_ENCRYPTION_KEY;
    if (envKey) {
      return Buffer.from(envKey, "hex");
    }
    // Fallback: Deterministic key derived from hostname
    const hostname = os.hostname();
    return crypto
      .createHmac("sha256", "pop-pay-state-salt")
      .update(hostname)
      .digest();
  }

  private encryptField(value: string | null): string | null {
    if (!value) return null;
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.encryptionKey, iv);
    const encrypted = Buffer.concat([
      cipher.update(value, "utf8"),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();
    // Structure: IV (12b) + AuthTag (16b) + Ciphertext
    return Buffer.concat([iv, authTag, encrypted]).toString("base64");
  }

  private decryptField(encryptedBase64: string | null): string | null {
    if (!encryptedBase64) return null;
    try {
      const data = Buffer.from(encryptedBase64, "base64");
      if (data.length < 28) return encryptedBase64; // Too short for IV+Tag+Data, probably raw

      const iv = data.subarray(0, 12);
      const authTag = data.subarray(12, 28);
      const ciphertext = data.subarray(28);

      const decipher = crypto.createDecipheriv(
        "aes-256-gcm",
        this.encryptionKey,
        iv
      );
      decipher.setAuthTag(authTag);
      return (
        decipher.update(ciphertext as any, undefined, "utf8") +
        decipher.final("utf8")
      );
    } catch (e) {
      return encryptedBase64; // Fallback to raw value if decryption fails
    }
  }

  private initDb(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS daily_budget (
        date TEXT PRIMARY KEY,
        spent_amount REAL
      )
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS issued_seals (
        seal_id TEXT PRIMARY KEY,
        amount REAL,
        vendor TEXT,
        status TEXT,
        masked_card TEXT,
        expiration_date TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    this.migrateSchema();
  }

  private migrateSchema(): void {
    const columns = this.db.prepare("PRAGMA table_info(issued_seals)").all() as any[];
    const columnNames = new Set(columns.map((c) => c.name));

    if (columnNames.has("card_number") || columnNames.has("cvv")) {
      // Add masked_card column if not already present
      if (!columnNames.has("masked_card")) {
        this.db.exec("ALTER TABLE issued_seals ADD COLUMN masked_card TEXT");
      }
      // Derive masked_card from last 4 digits of card_number
      if (columnNames.has("card_number")) {
        this.db.exec(
          "UPDATE issued_seals SET masked_card = '****-****-****-' || substr(card_number, -4) " +
          "WHERE masked_card IS NULL AND card_number IS NOT NULL"
        );
      }
      // Recreate table without card_number and cvv columns (SQLite cannot DROP COLUMN pre-3.35)
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS issued_seals_new (
          seal_id TEXT PRIMARY KEY,
          amount REAL,
          vendor TEXT,
          status TEXT,
          masked_card TEXT,
          expiration_date TEXT,
          timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);
      this.db.exec(`
        INSERT INTO issued_seals_new (seal_id, amount, vendor, status, masked_card, expiration_date, timestamp)
        SELECT seal_id, amount, vendor, status, masked_card, expiration_date, timestamp
        FROM issued_seals
      `);
      this.db.exec("DROP TABLE issued_seals");
      this.db.exec("ALTER TABLE issued_seals_new RENAME TO issued_seals");
    }
  }

  private getTodaySpent(): number {
    const today = new Date().toISOString().slice(0, 10);
    const row = this.db
      .prepare("SELECT spent_amount FROM daily_budget WHERE date = ?")
      .get(today) as { spent_amount: number } | undefined;
    return row?.spent_amount ?? 0.0;
  }

  canSpend(amount: number, maxDailyBudget: number): boolean {
    const spentToday = this.getTodaySpent();
    return spentToday + amount <= maxDailyBudget;
  }

  addSpend(amount: number): void {
    const today = new Date().toISOString().slice(0, 10);
    this.db
      .prepare(
        `INSERT INTO daily_budget (date, spent_amount)
         VALUES (?, ?)
         ON CONFLICT(date) DO UPDATE SET spent_amount = spent_amount + ?`
      )
      .run(today, amount, amount);
    this.dailySpendTotal = this.getTodaySpent();
  }

  recordSeal(
    sealId: string,
    amount: number,
    vendor: string,
    status: string = "Issued",
    maskedCard: string | null = null,
    expirationDate: string | null = null
  ): void {
    const encryptedMasked = this.encryptField(maskedCard);
    this.db
      .prepare(
        `INSERT INTO issued_seals (seal_id, amount, vendor, status, masked_card, expiration_date)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(sealId, amount, vendor, status, encryptedMasked, expirationDate);
  }

  getSealMaskedCard(sealId: string): string {
    const row = this.db
      .prepare("SELECT masked_card FROM issued_seals WHERE seal_id = ?")
      .get(sealId) as { masked_card: string | null } | undefined;
    
    if (!row || !row.masked_card) return "";
    return this.decryptField(row.masked_card) ?? "";
  }

  updateSealStatus(sealId: string, status: string): void {
    this.db
      .prepare("UPDATE issued_seals SET status = ? WHERE seal_id = ?")
      .run(status, sealId);
  }

  markUsed(sealId: string): void {
    this.db
      .prepare("UPDATE issued_seals SET status = 'Used' WHERE seal_id = ?")
      .run(sealId);
  }

  isUsed(sealId: string): boolean {
    const row = this.db
      .prepare("SELECT status FROM issued_seals WHERE seal_id = ?")
      .get(sealId) as { status: string } | undefined;
    return row?.status === "Used";
  }

  close(): void {
    this.db.close();
  }
}
