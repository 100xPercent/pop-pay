import { randomUUID } from "node:crypto";
import type { VirtualCardProvider } from "./base.js";
import type { PaymentIntent, GuardrailPolicy, VirtualSeal } from "../core/models.js";

export class LocalVaultProvider implements VirtualCardProvider {
  readonly cardNumber: string;
  readonly expMonth: string;
  readonly expYear: string;
  readonly cvv: string;
  readonly billingInfo: Record<string, string>;

  constructor() {
    this.cardNumber = process.env.POP_BYOC_NUMBER ?? "";
    this.expMonth = process.env.POP_BYOC_EXP_MONTH ?? "";
    this.expYear = process.env.POP_BYOC_EXP_YEAR ?? "";
    this.cvv = process.env.POP_BYOC_CVV ?? "";

    if (!this.cardNumber || !this.expMonth || !this.expYear || !this.cvv) {
      throw new Error(
        "Missing BYOC environment variables. Check POP_BYOC_NUMBER, POP_BYOC_EXP_MONTH, POP_BYOC_EXP_YEAR, POP_BYOC_CVV."
      );
    }

    this.billingInfo = {
      firstName: process.env.POP_BILLING_FIRST_NAME?.trim() ?? "",
      lastName: process.env.POP_BILLING_LAST_NAME?.trim() ?? "",
      street: process.env.POP_BILLING_STREET?.trim() ?? "",
      city: process.env.POP_BILLING_CITY?.trim() ?? "",
      state: process.env.POP_BILLING_STATE?.trim() ?? "",
      country: process.env.POP_BILLING_COUNTRY?.trim() ?? "",
      zip: process.env.POP_BILLING_ZIP?.trim() ?? "",
      email: process.env.POP_BILLING_EMAIL?.trim() ?? "",
      phone: process.env.POP_BILLING_PHONE?.trim() ?? "",
      phoneCountryCode: process.env.POP_BILLING_PHONE_COUNTRY_CODE?.trim() ?? "",
    };
  }

  async issueCard(intent: PaymentIntent, policy: GuardrailPolicy): Promise<VirtualSeal> {
    if (intent.requestedAmount > policy.maxAmountPerTx) {
      return {
        sealId: randomUUID(),
        cardNumber: null,
        cvv: null,
        expirationDate: null,
        authorizedAmount: 0.0,
        status: "Rejected",
        rejectionReason: "Amount exceeds policy limit",
      };
    }

    return {
      sealId: randomUUID(),
      cardNumber: this.cardNumber,
      cvv: this.cvv,
      expirationDate: `${this.expMonth}/${this.expYear}`,
      authorizedAmount: intent.requestedAmount,
      status: "Issued",
      rejectionReason: null,
    };
  }
}
