import { describe, expect } from "vitest";
import * as ecc from "tiny-secp256k1";
import { ECPairFactory } from "ecpair";
import {
	crypto,
	networks,
	payments,
	address as Address,
	script as Script,
	Transaction,
	bip341,
} from "liquidjs-lib";
import {
	takeFromFaucet,
	retryWithDelay,
	getTransactionHexById,
	publishTransaction,
} from "./utils/test.js";
import { createKeyTweaker } from "pls-bitcoin";
import {
	Finalizer as PsetFinalizer,
	Extractor as PsetExtractor,
	witnessStackToScriptWitness,
} from "liquidjs-lib/src/psetv2";
import {
	createLiquidMultisig,
	signLiquidTaprootTransaction,
	startSpendFromLiquidMultisig,
} from "./index.js";
import { toReversed } from "./utils/index.js";

const ECPair = ECPairFactory(ecc);

describe(
	"signLiquidTaprootTransaction test",
	(it) => {
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

		const tweakedSelectedCombination = partsEcpairs.map((ecpair) => {
			const tweaker = createKeyTweaker({
				pubkey: ecpair.publicKey,
				privkey: ecpair.privateKey,
			});

			return tweaker.tweakEcpair(tweak);
		});

		const firstEcpairAddress = payments.p2pkh({
			pubkey: partsEcpairs[0]!.publicKey,
			network,
		});

		const firstEcpairConfidentialAddress = Address.toConfidential(
			firstEcpairAddress.address!,
			blindingKeypair.publicKey,
		);

		it("spending correctly finalized", async () => {
			const inputTransactionId = await takeFromFaucet(multisig.confidentialAddress);

			const inputTransactionHex = await retryWithDelay(
				() => getTransactionHexById(inputTransactionId),
				500,
				30,
			);

			const inputTransaction = Transaction.fromHex(inputTransactionHex);

			const script = multisig.multisigScripts.find(({ combination }) =>
				tweakedSelectedCombination.every((ecpair) =>
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
				signer: partsEcpairs[0]!,
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
				keypair: partsEcpairs[1]!,
				leafHash: bip341.tapLeafHash({
					scriptHex: redeemOutput,
				}),
				network,
				tweak,
			});

			const selectedCombinationSigs = tweakedSelectedCombination.map(
				(pubkey) =>
					pset!.inputs[0]!.tapScriptSig!.find(
						(sig) => sig.pubkey.toString("hex") === pubkey.publicKey.toString("hex"),
					)?.signature ?? null,
			);

			const finalizer = new PsetFinalizer(pset!);

			pset!.inputs.forEach((_, index) => {
				finalizer.finalizeInput(index, () => {
					const input = pset!.inputs[index]!;

					const unlockingScript = Script.compile([
						...toReversed(selectedCombinationSigs).reduce((acc: Buffer[], sig) => {
							if (sig) acc.push(sig);
							return acc;
						}, []),
					]);

					const redeemPayment = payments.p2wsh({
						redeem: {
							input: unlockingScript,
							output: input.witnessScript,
						},
					});

					const finalScriptWitness = witnessStackToScriptWitness(redeemPayment.witness ?? []);

					return {
						finalScriptSig: Buffer.from(""),
						finalScriptWitness,
					};
				});
			});

			finalizer.finalize();

			const transaction = PsetExtractor.extract(pset!);

			await publishTransaction(transaction.toHex());
		})
	},
	{ timeout: 30 * 1000 },
)