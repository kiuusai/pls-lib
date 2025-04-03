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
} from "./utils/test.js"
import { faker } from "@faker-js/faker";
import { getUnblindedUtxoValues } from "./getUnblindedUtxoValues.js";

const ECPair = ECPairFactory(ecc);

describe(
	"getUmblindedUtxoValues test",
	(it) => {
		const keypair = ECPair.makeRandom();

		const blindingKey = ECPair.makeRandom();

		const network = networks.regtest;

		const keypairAddress = payments.p2pkh({
			pubkey: keypair.publicKey,
			network,
			blindkey: blindingKey.publicKey,
		});

		it("unblind utxos correctly", async () => {
			const transactionsCount = faker.number.int({ min: 2, max: 5 });

			const transactionIds = await Promise.all(new Array(transactionsCount).fill(null).map(async () => {
				return await takeFromFaucet(keypairAddress.confidentialAddress!);
			}));

			const inputTransactionsHex = await Promise.all(transactionIds.map(async (id) => {
				return await retryWithDelay(
					async () => await getTransactionHexById(id),
					500,
					30,
				);
			}));

			const inputTransactions = inputTransactionsHex.map((hex) => Transaction.fromHex(hex));

			const inputTxOutputs = inputTransactions
				.map((input) => input.outs
					.map((output, vout) => ({
						...output,
						hex: input.toHex(),
						vout,
					}))
					.filter(
						(output) =>
							output.script.toString("hex") ===
							Address.toOutputScript(keypairAddress.address!, network).toString("hex")
					)
			).flat(1);

			const unblindedUtxosValues = getUnblindedUtxoValues({
				utxos: inputTxOutputs.map((output) => ({
					hex: output.hex,
					vout: output.vout,
					value: undefined
				})),
				blindingKeypair: blindingKey,
			});

			expect(unblindedUtxosValues).not.toContainEqual(null);

			const expectedValues = new Array(transactionsCount).fill(100_000_000);

			expect(unblindedUtxosValues).toEqual(expectedValues);
		})
	},
	{
		timeout: 30 * 1000,
	},
)