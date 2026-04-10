# Contributing to pop-pay

Thank you for your interest in contributing to Point One Percent (`pop-pay`)! We are building the runtime security layer for AI agent commerce, and we welcome contributions from the community.

## Development Setup

### Prerequisites
- **Node.js**: >= 18.0.0
- **npm**: >= 9.0.0
- **Rust**: Latest stable (required for building the native layer)

### Installation
1. Fork and clone the repository:
   ```bash
   git clone https://github.com/YOUR_USERNAME/pop-pay.git
   cd pop-pay
   ```
2. Install dependencies:
   ```bash
   npm install
   ```
3. Build the native Rust layer:
   ```bash
   npm run build:native
   ```
4. Build the TypeScript source:
   ```bash
   npm run build
   ```

## Workflow

### Testing
We use **Vitest** for our test suite. Ensure all tests pass before submitting a PR:
```bash
npm test
```
To run tests in watch mode:
```bash
npm run test:watch
```

### Linting
We follow strict TypeScript and ESLint rules:
```bash
npm run lint
```

### Pull Request Process
1. Create a new branch: `git checkout -b feat/your-feature-name`.
2. Implement your changes and add tests.
3. Verify tests and linting pass.
4. Submit a Pull Request with a clear description of the changes and the problem they solve.

## Architecture Overview

`pop-pay` is structured into several key layers:
- **MCP Server**: The interface for AI agents (Claude Code, OpenHands, etc.).
- **Playwright Injection Engine**: Uses Playwright's `connectOverCDP` to traverse cross-origin iframes (including Stripe sandboxed iframes) and Shadow DOM trees, injecting credentials directly.
- **Guardrails**: Hybrid Keyword + LLM logic to evaluate purchase intent and block hallucinations.
- **Vault**: AES-256-GCM encrypted storage for BYOC credentials.
- **Native Layer**: Rust-based (napi-rs) for secure key derivation and salt handling.

## Call for Contributions

We are specifically looking for help in the following areas:
- **New Payment Providers**: Implementations for more virtual card issuers (e.g., Marqeta, Airwallex).
- **Guardrail Improvements**: Better semantic analysis to catch subtle prompt injections.
- **Injection Resilience**: Enhancing the Playwright-based engine to handle more complex or obfuscated checkout forms.
- **Checkout Coverage**: Adding more "known processors" to `src/engine/known-processors.ts`.
- **Documentation**: Improving guides, adding examples, and translating docs.

## Open Discussion: masked_card Encryption

Currently, `masked_card` values (e.g., `****-4242`) are encrypted at rest in SQLite using AES-256-GCM. The dashboard API decrypts them before display.

We're seeking community input on whether this encryption is necessary:
- **Current state**: Masked card values like `****-4242` are encrypted in `pop_state.db` and decrypted on read
- **Argument for keeping**: Defense-in-depth — even masked data gets encryption
- **Argument for removing**: `****-4242` is not PCI-sensitive data (PCI DSS explicitly allows truncated PAN display). Encryption adds complexity and caused a dashboard display bug where raw ciphertext was shown instead of the masked value
- **Note**: Full card numbers are never stored in the database — only the masked form

If you have opinions on this, please open an issue or discussion. We'd love to hear from security researchers and PCI practitioners.

## Code of Conduct
Please be respectful and professional in all interactions. We aim to foster an inclusive and welcoming environment for all contributors.

## License
By contributing, you agree that your contributions will be licensed under the project's MIT License.
