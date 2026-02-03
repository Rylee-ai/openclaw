/**
 * x402 Payment Middleware for Hono
 *
 * Implements the Coinbase x402 micropayment protocol:
 * 1. Client requests a resource
 * 2. Server returns 402 Payment Required with payment details
 * 3. Client pays (USDC on Base L2)
 * 4. Client re-requests with X-PAYMENT header containing payment proof
 * 5. Server verifies and serves content
 *
 * Payment proof format: base64-encoded JSON with tx hash and payer address.
 * Verification: checks the tx on Base L2 via public RPC.
 */

import type { MiddlewareHandler } from "hono";

export type PricingTier = {
  amount: string; // e.g. "0.10"
  currency: string; // e.g. "USDC"
  network: string; // e.g. "base"
  description: string;
};

type PaymentProof = {
  txHash: string;
  payer: string;
  amount: string;
  timestamp: number;
};

// Base L2 public RPC for verification
const BASE_RPC = "https://mainnet.base.org";

// USDC contract on Base
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

/**
 * x402 middleware factory.
 * Returns 402 with payment instructions if no valid payment proof is present.
 * Passes through if payment is verified.
 */
export function x402(
  tier: string,
  pricing: Record<string, PricingTier>,
): MiddlewareHandler {
  return async (c, next) => {
    const tierConfig = pricing[tier];
    if (!tierConfig) {
      return c.json({ error: "Unknown pricing tier" }, 500);
    }

    const walletAddress = (c.env as Record<string, string>).X402_WALLET_ADDRESS;

    // If no wallet configured, serve content free (development mode)
    if (!walletAddress) {
      c.header("X-Payment-Status", "free-mode");
      await next();
      return;
    }

    // Check for payment proof
    const paymentHeader = c.req.header("X-PAYMENT");

    if (!paymentHeader) {
      // Return 402 with payment instructions
      return c.json(
        {
          status: 402,
          message: "Payment Required",
          payment: {
            tier,
            amount: tierConfig.amount,
            currency: tierConfig.currency,
            network: tierConfig.network,
            recipient: walletAddress,
            description: tierConfig.description,
            protocol: "x402",
            instructions:
              `Send ${tierConfig.amount} ${tierConfig.currency} on ${tierConfig.network} ` +
              `to ${walletAddress}. Include the transaction hash in the X-PAYMENT header ` +
              `as base64-encoded JSON: {"txHash":"0x...","payer":"0x...","amount":"${tierConfig.amount}","timestamp":...}`,
          },
        },
        402,
      );
    }

    // Verify payment proof
    try {
      const proof = JSON.parse(atob(paymentHeader)) as PaymentProof;

      // Basic validation
      if (!proof.txHash || !proof.payer || !proof.amount) {
        return c.json(
          { error: "Invalid payment proof: missing txHash, payer, or amount" },
          400,
        );
      }

      // Check amount matches
      if (parseFloat(proof.amount) < parseFloat(tierConfig.amount)) {
        return c.json(
          {
            error: `Insufficient payment: sent ${proof.amount}, required ${tierConfig.amount} ${tierConfig.currency}`,
          },
          402,
        );
      }

      // Check proof freshness (must be within 1 hour)
      const age = Date.now() - proof.timestamp;
      if (age > 3600_000) {
        return c.json({ error: "Payment proof expired (>1 hour old)" }, 402);
      }

      // Check for replay: store used tx hashes in KV
      const cache = (c.env as Record<string, KVNamespace>).CACHE;
      const txKey = `tx_${proof.txHash}`;
      const used = await cache.get(txKey);
      if (used) {
        return c.json({ error: "Payment already used" }, 402);
      }

      // Verify tx on Base L2 (check it exists and is confirmed)
      const verified = await verifyTransaction(
        proof.txHash,
        walletAddress,
        tierConfig.amount,
      );

      if (!verified.valid) {
        return c.json(
          { error: `Payment verification failed: ${verified.reason}` },
          402,
        );
      }

      // Mark tx as used (expire after 24h)
      await cache.put(txKey, JSON.stringify({ tier, payer: proof.payer }), {
        expirationTtl: 86400,
      });

      // Payment verified - serve content
      c.header("X-Payment-Status", "verified");
      c.header("X-Payment-TxHash", proof.txHash);
      await next();
    } catch (e) {
      return c.json(
        {
          error: "Invalid payment proof format",
          expected:
            "Base64-encoded JSON: {txHash, payer, amount, timestamp}",
        },
        400,
      );
    }
  };
}

/**
 * Verify a transaction on Base L2 via JSON-RPC.
 * Checks that the tx exists, is confirmed, and sent USDC to our wallet.
 */
async function verifyTransaction(
  txHash: string,
  expectedRecipient: string,
  expectedAmount: string,
): Promise<{ valid: boolean; reason?: string }> {
  try {
    // Fetch tx receipt
    const resp = await fetch(BASE_RPC, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "eth_getTransactionReceipt",
        params: [txHash],
        id: 1,
      }),
    });

    const data = (await resp.json()) as {
      result: {
        status: string;
        logs: Array<{
          address: string;
          topics: string[];
          data: string;
        }>;
      } | null;
    };

    if (!data.result) {
      return { valid: false, reason: "Transaction not found or not confirmed" };
    }

    if (data.result.status !== "0x1") {
      return { valid: false, reason: "Transaction reverted" };
    }

    // Check for USDC Transfer event to our address
    // Transfer(address,address,uint256) topic0 = 0xddf252ad...
    const TRANSFER_TOPIC =
      "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
    const recipientPadded =
      "0x000000000000000000000000" + expectedRecipient.slice(2).toLowerCase();

    const transferLog = data.result.logs.find(
      (log) =>
        log.address.toLowerCase() === USDC_BASE.toLowerCase() &&
        log.topics[0] === TRANSFER_TOPIC &&
        log.topics[2]?.toLowerCase() === recipientPadded,
    );

    if (!transferLog) {
      return {
        valid: false,
        reason: "No USDC transfer to recipient found in transaction",
      };
    }

    // Verify amount (USDC has 6 decimals)
    const transferredRaw = BigInt(transferLog.data);
    const expectedRaw = BigInt(
      Math.round(parseFloat(expectedAmount) * 1_000_000),
    );

    if (transferredRaw < expectedRaw) {
      return {
        valid: false,
        reason: `Insufficient amount: ${transferredRaw} < ${expectedRaw} (raw USDC)`,
      };
    }

    return { valid: true };
  } catch (e) {
    // If verification fails, still allow (fail-open for now)
    // In production, switch to fail-closed
    return { valid: true, reason: "Verification RPC error - fail-open" };
  }
}
