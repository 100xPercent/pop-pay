import Database from "better-sqlite3";

export class PopStateTracker {
  private db: Database.Database;
  dailySpendTotal: number;

  constructor(dbPath: string = "pop_state.db") {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.initDb();
    this.dailySpendTotal = this.getTodaySpent();
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
    this.db
      .prepare(
        `INSERT INTO issued_seals (seal_id, amount, vendor, status, masked_card, expiration_date)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(sealId, amount, vendor, status, maskedCard, expirationDate);
  }

  getSealMaskedCard(sealId: string): string {
    const row = this.db
      .prepare("SELECT masked_card FROM issued_seals WHERE seal_id = ?")
      .get(sealId) as { masked_card: string } | undefined;
    return row?.masked_card ?? "";
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
