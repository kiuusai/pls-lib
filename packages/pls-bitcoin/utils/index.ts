import { PubkeysSchema } from "pls-core";
import { z } from "zod";

const TaprootV0CollateralSchema = {
	arbitratorsQuorum: z.number(),
	multisigAddress: z.string(),
	pubkeys: PubkeysSchema,
	type: z.literal("taproot-v0"),
};

export const bitcoinSchemas = {
	mainnet: z.object({
		network: z.literal("bitcoin"),
		...TaprootV0CollateralSchema,
	}),
	testnet: z.object({
		network: z.literal("bitcoin_testnet"),
		...TaprootV0CollateralSchema,
	}),
};

// Invalid point, there is not priv key to sign this, should be random
export const H = Buffer.from(
	"50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0",
	"hex"
);

export const combine = <T>(items: Array<T>, size: number): Array<Array<T>> => {
	const intCombine = (
		acc: Array<T>,
		rem: Array<T>,
		curr: number
	): Array<any> => {
		if (curr === 0) return acc;
		return rem.map((i, idx) => {
			return intCombine([...acc, i], rem.slice(idx + 1), curr - 1);
		});
	};

	return intCombine([], items, size).flat(size - 1);
};
