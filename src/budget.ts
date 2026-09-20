import pc from "picocolors";

/**
 * A spend limit for commands that run real agents.
 *
 * `compare` with three repetitions over a ten-task suite is sixty agent runs.
 * A turn budget bounds one trial; nothing bounded the total, and the first
 * time anyone finds out is the invoice.
 *
 * The limit is checked between trials, not during one. A trial that is already
 * running is allowed to finish, because a half-run trial is not evidence and
 * throwing it away wastes what it already cost.
 */
export class Budget {
  private spent = 0;
  private stoppedAt?: number;

  constructor(
    /** Dollars. Zero or undefined means no limit. */
    readonly limitUsd?: number,
  ) {}

  /** Record what a finished trial cost. */
  add(costUsd: number | undefined): void {
    if (typeof costUsd === "number" && Number.isFinite(costUsd) && costUsd > 0) this.spent += costUsd;
  }

  get total(): number {
    return this.spent;
  }

  /** True once the limit is reached. Checked before starting the next trial. */
  get exhausted(): boolean {
    if (!this.limitUsd || this.limitUsd <= 0) return false;
    if (this.spent >= this.limitUsd) {
      this.stoppedAt ??= this.spent;
      return true;
    }
    return false;
  }

  /** What to tell the reader, so a short run is never mistaken for a clean one. */
  get note(): string | undefined {
    if (this.stoppedAt === undefined) return undefined;
    return `stopped after $${this.stoppedAt.toFixed(2)} of a $${this.limitUsd!.toFixed(2)} budget. The trials that did not run are not passes; raise --budget to finish them.`;
  }

  line(): string {
    const cap = this.limitUsd && this.limitUsd > 0 ? ` of $${this.limitUsd.toFixed(2)}` : "";
    return pc.dim(`spent $${this.spent.toFixed(2)}${cap}`);
  }
}
