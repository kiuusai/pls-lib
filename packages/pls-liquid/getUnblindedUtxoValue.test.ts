import { describe, expect } from "vitest";
import {
	payments,
	networks,
	Transaction,
	address as Address,
} from "liquidjs-lib";
import * as ecc from "tiny-secp256k1";
import { ECPairFactory } from "ecpair";
import {
	takeFromFaucet,
	retryWithDelay,
	getTransactionHexById,
} from "./utils/test.js";
import { getUnblindedUtxoValue } from "./getUnblindedUtxoValue.js";

const ECPair = ECPairFactory(ecc);

describe(
	"getUnblindedUtxoValue test",
	(it) => {
		const keypair = ECPair.makeRandom();

		const blindingKey = ECPair.makeRandom();

		const network = networks.regtest;

		const keypairAddress = payments.p2pkh({
			pubkey: keypair.publicKey,
			network,
			blindkey: blindingKey.publicKey,
		});

		it("unblind utxo correctly", async () => {
			const transactionId = await takeFromFaucet(keypairAddress.confidentialAddress!);

			const inputTransactionHex = await retryWithDelay(
				async () => await getTransactionHexById(transactionId),
				500,
				30,
			);

			const inputTransaction = Transaction.fromHex(inputTransactionHex);

			const inputTxOutputs = inputTransaction.outs
				.map((output, vout) => ({ ...output, vout }))
				.filter(
					(output) =>
						output.script.toString("hex") ===
						Address.toOutputScript(keypairAddress.address!, network).toString("hex")
				);

			expect(inputTxOutputs).toHaveLength(1);

			const utxo = inputTxOutputs[0]!;

			const unblindedUtxoValue = getUnblindedUtxoValue({
				utxo: {
					hex: inputTransactionHex,
					vout: utxo.vout,
					value: undefined,
				},
				blindingKeypair: blindingKey,
			});

			expect(unblindedUtxoValue).not.toBeNull();

			expect(unblindedUtxoValue).toEqual(100_000_000);
		})
	},
	{
		concurrent: true,
		timeout: 30 * 1000,
	}
)