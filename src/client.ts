import { randomUUID } from "node:crypto";
import type { PaymentIntent, GuardrailPolicy, VirtualSeal } from "./core/models.js";
import type { VirtualCardProvider } from "./providers/base.js";
import { GuardrailEngine } from "./engine/guardrails.js";
import { PopStateTracker } from "./core/state.js";

export class PopClient {
  provider: VirtualCardProvider;
  policy: GuardrailPolicy;
  stateTracker: PopStateTracker;
  engine: GuardrailEngine;

  constructor(
    provider: VirtualCardProvider,
    policy: GuardrailPolicy,
    engine?: GuardrailEngine,
    dbPath: string = "pop_state.db"
  ) {
    this.provider = provider;
    this.policy = policy;
    this.stateTracker = new PopStateTracker(dbPath);
    this.engine = engine ?? new GuardrailEngine();
  }

  async processPayment(intent: PaymentIntent): Promise<VirtualSeal> {
    // Check daily budget
    if (!this.stateTracker.canSpend(intent.requestedAmount, this.policy.maxDailyBudget)) {
      const seal: VirtualSeal = {
        sealId: randomUUID(),
        cardNumber: null,
        cvv: null,
        expirationDate: null,
        authorizedAmount: 0.0,
        status: "Rejected",
        rejectionReason: "Daily budget exceeded",
      };
      this.stateTracker.recordSeal(seal.sealId, seal.authorizedAmount, intent.targetVendor, seal.status);
      return seal;
    }

    // Evaluate intent
    const [approved, reason] = await this.engine.evaluateIntent(intent, this.policy);
    if (!approved) {
      const seal: VirtualSeal = {
        sealId: randomUUID(),
        cardNumber: null,
        cvv: null,
        expirationDate: null,
        authorizedAmount: 0.0,
        status: "Rejected",
        rejectionReason: reason,
      };
      this.stateTracker.recordSeal(seal.sealId, seal.authorizedAmount, intent.targetVendor, seal.status);
      return seal;
    }

    // Issue card — record as Pending until injection confirms
    const seal = await this.provider.issueCard(intent, this.policy);
    const maskedCard = seal.cardNumber
      ? `****-****-****-${seal.cardNumber.slice(-4)}`
      : "****-****-****-????";

    if (seal.status !== "Rejected") {
      seal.status = "Pending";
    }

    this.stateTracker.recordSeal(
      seal.sealId,
      seal.authorizedAmount,
      intent.targetVendor,
      seal.status,
      maskedCard,
      seal.expirationDate
    );

    if (seal.status !== "Rejected") {
      this.stateTracker.addSpend(intent.requestedAmount);
    }
    return seal;
  }

  async executePayment(sealId: string, amount: number): Promise<{ status: string; reason?: string; amount?: number }> {
    if (this.stateTracker.isUsed(sealId)) {
      return { status: "rejected", reason: "Burn-after-use enforced" };
    }
    this.stateTracker.markUsed(sealId);
    return { status: "success", amount };
  }
}
