import { PubkeysSchema } from "pls-core";
import { z } from "zod";

import { createLiquidMultisig } from "./createLiquidMultisig.js";
import { getUnblindedUtxoValue } from "./getUnblindedUtxoValue.js";
import { getUnblindedUtxoValues } from "./getUnblindedUtxoValues.js";
import { startSpendFromLiquidMultisig } from "./startSpendFromLiquidMultisig.js";
import { signLiquidTaprootTransaction } from "./signLiquidTaprootTransaction.js";
import { finalizeTxSpendingFromLiquidMultisig } from "./finalizeTxSpendingFromLiquidMultisig.js";
import { getTapscriptSigsOrdered } from "./getTapscriptSigsOrdered.js";

import {
	H,
} from "./utils/index.js"

export {
	createLiquidMultisig,

	startSpendFromLiquidMultisig,

	signLiquidTaprootTransaction,

	finalizeTxSpendingFromLiquidMultisig,

	getUnblindedUtxoValue,

	getUnblindedUtxoValues,

	getTapscriptSigsOrdered,

	H,
}

const TaprootV0CollateralSchema = {
	arbitratorsQuorum: z.number(),
	multisigAddress: z.string(),
	privateBlindingKey: z.string(),
	pubkeys: PubkeysSchema,
	type: z.literal("taproot-v0"),
};

export const liquidSchemas = {
	mainnet: z.object({
		network: z.literal("liquid"),
		...TaprootV0CollateralSchema,
	}),
	testnet: z.object({
		network: z.literal("liquid_testnet"),
		...TaprootV0CollateralSchema,
	}),
};