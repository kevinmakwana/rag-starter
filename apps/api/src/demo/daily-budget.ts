const DAY_MS = 86_400_000;

export interface BudgetResult {
  allowed: boolean;
  /** Whole seconds until the next UTC midnight (at least 1); 0 when allowed. */
  retryAfterSeconds: number;
}

/** One counter shared by everyone, reset at UTC midnight. In memory: gone on restart. */
export class DailyBudget {
  private day = -1;
  private used = 0;

  constructor(private readonly now: () => number = Date.now) {}

  /** Spends one unit of `cap` for today. A cap of 0 or less means no cap. A refused request is not counted. */
  take(cap: number): BudgetResult {
    if (cap <= 0) return { allowed: true, retryAfterSeconds: 0 };
    const now = this.now();
    const day = Math.floor(now / DAY_MS);
    if (day !== this.day) {
      this.day = day;
      this.used = 0;
    }
    if (this.used >= cap) {
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(((day + 1) * DAY_MS - now) / 1000)) };
    }
    this.used++;
    return { allowed: true, retryAfterSeconds: 0 };
  }
}
