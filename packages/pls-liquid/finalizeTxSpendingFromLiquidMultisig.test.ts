import { describe, expect, test } from "vitest";
import * as ecc from "tiny-secp256k1";
import { ECPairFactory } from "ecpair";
import {
	crypto,
	networks,
	payments,
	bip341,
	address as Address,
	Transaction,
} from "liquidjs-lib";
import {
	takeFromFaucet,
	retryWithDelay,
	getTransactionHexById,
	publishTransaction,
} from "./utils/test.js";
import { combine } from "./utils/index.js"
import { createKeyTweaker } from "pls-bitcoin";
import {
	createLiquidMultisig,
	startSpendFromLiquidMultisig,
	signLiquidTaprootTransaction,
	finalizeTxSpendingFromLiquidMultisig,
	getTapscriptSigsOrdered,
} from "./index.js";

const ECPair = ECPairFactory(ecc);

describe(
	"finalizeTxSpendingFromLiquidMultisig test",
	() => {
		const partsEcpairs = new Array(2).fill(null).map(() => ECPair.makeRandom());

		const arbitratorEcpair = ECPair.makeRandom();

		const contentToTweak = "Some content to tweak";
		const tweak = crypto.sha256(Buffer.from(contentToTweak));

		const network = networks.regtest;

		const parts = partsEcpairs.map((ecpair) => ecpair.publicKey.toString("hex"));

		const arbitrators = [arbitratorEcpair.publicKey.toString("hex")];

		const blindingKeypair = ECPair.makeRandom();

		const arbitratorsQuorum = 1;

		const multisig = createLiquidMultisig({
			parts,
			arbitrators,
			network,
			blindingKeypair,
			tweak,
			arbitratorsQuorum,
		});

		const eachChildNodeWithArbitratorsQuorum = partsEcpairs.map(
			(p) => combine([arbitratorEcpair], 1).map((a) => [p, ...a])
		).flat(1);

		const childNodesCombinations = [
			partsEcpairs,
			...eachChildNodeWithArbitratorsQuorum,
		];

		const firstEcpairAddress = payments.p2pkh({
			pubkey: partsEcpairs[0]!.publicKey,
			network,
		});

		const firstEcpairConfidentialAddress = Address.toConfidential(
			firstEcpairAddress.address!,
			blindingKeypair.publicKey,
		);

		test.each(childNodesCombinations)("spending correctly finalized test %#", async (...selectedCombination) => {
			const inputTransactionId = await takeFromFaucet(multisig.confidentialAddress);

			const inputTransactionHex = await retryWithDelay(
				() => getTransactionHexById(inputTransactionId),
				500,
				30,
			);

			const inputTransaction = Transaction.fromHex(inputTransactionHex);

			const script = multisig.multisigScripts.find(({ combination }) =>
				selectedCombination.every((ecpair) =>
					combination.includes(ecpair.publicKey.toString("hex")),
				),
			);

			expect(script).not.toBeUndefined();

			const redeemOutput = script!.leaf.output.toString("hex");

			const inputTxOutputs = inputTransaction.outs
				.map((output, vout) => ({ ...output, vout }))
				.filter(
					(output) =>
						output.script.toString("hex") ===
						Address.toOutputScript(multisig.address, network).toString("hex"),
				);

			expect(inputTxOutputs.length).toBe(1);

			const pset = await startSpendFromLiquidMultisig({
				hashTree: multisig.hashTree,
				redeemOutput,
				utxos: inputTxOutputs.map((output) => ({
					txid: inputTransactionId,
					hex: inputTransactionHex,
					vout: output.vout,
					value: undefined,
				})),
				network,
				signer: selectedCombination[0]!,
				receivingAddresses: [
					{
						address: firstEcpairConfidentialAddress,
						value: 100_000_000 - 300,
					},
				],
				blindingKeypair,
				tweak,
			});

			expect(pset).not.toBeUndefined();

			await signLiquidTaprootTransaction({
				pset: pset!,
				keypair: selectedCombination[1]!,
				leafHash: bip341.tapLeafHash({
					scriptHex: redeemOutput,
				}),
				network,
				tweak,
			});

			const { clientSigs, arbitratorSigs } = getTapscriptSigsOrdered({
				pset: pset!,
				clientPubkeys: parts,
				arbitratorPubkeys: arbitrators,
				tweak,
			})

			const transaction = finalizeTxSpendingFromLiquidMultisig({
				pset: pset!,
				clientSigs,
				arbitratorSigs,
			});

			await publishTransaction(transaction.toHex());
		}, { concurrent: true, timeout: 30 * 1000 });
	},
)