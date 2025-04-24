import { describe, expect, test } from "vitest";
import * as ecc from "tiny-secp256k1";
import { ECPairFactory } from "ecpair";
import { crypto, networks, payments, address as Address, Transaction, bip341 } from "liquidjs-lib";
import {
	takeFromFaucet,
	retryWithDelay,
	getTransactionHexById,
} from "./utils/test.js";
import { createLiquidMultisig } from "./createLiquidMultisig.js";
import { createKeyTweaker } from "pls-bitcoin";
import { startSpendFromLiquidMultisig } from "./startSpendFromLiquidMultisig.js";
import { signLiquidTaprootTransaction } from "./signLiquidTaprootTransaction.js";
import { getTapscriptSigsOrdered } from "./getTapscriptSigsOrdered.js";
import { toXOnly } from "bitcoinjs-lib/src/psbt/bip371.js";

const ECPair = ECPairFactory(ecc);

describe("getTapscriptSigsOrdered test", () => {
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

	const tweakedPartsEcpairs = partsEcpairs.map((ecpair) => {
		const tweaker = createKeyTweaker({
			pubkey: ecpair.publicKey,
			privkey: ecpair.privateKey,
		});

		return tweaker.tweakEcpair(tweak);
	});

	const tweakedArbitratorEcpair = (() => {
		const tweaker = createKeyTweaker({
			pubkey: arbitratorEcpair.publicKey,
			privkey: arbitratorEcpair.privateKey,
		});

		return tweaker.tweakEcpair(tweak);
	})();

	const firstEcpairAddress = payments.p2pkh({
		pubkey: partsEcpairs[0]!.publicKey,
		network,
		blindkey: blindingKeypair.publicKey,
	});

	test.each([
		{
			title: "with 2 parts",
			sigsNull: {
				clientSigs: [false, false],
				arbitratorSig: true,
			},
		},
		{
			title: "with client 1 and arbitrator",
			sigsNull: {
				clientSigs: [false, true],
				arbitratorSig: false,
			},
		},
		{
			title: "with client 2 and arbitrator",
			sigsNull: {
				clientSigs: [true, false],
				arbitratorSig: false,
			},
		},
	])("get tapscript sigs ordered $title", async ({ sigsNull }) => {
		const inputTransactionId = await takeFromFaucet(multisig.confidentialAddress);

		const inputTransactionHex = await retryWithDelay(
			() => getTransactionHexById(inputTransactionId),
			500,
			30,
		);

		const inputTransaction = Transaction.fromHex(inputTransactionHex);

		const script = multisig.multisigScripts.find(({ combination }) =>
			partsEcpairs.every((ecpair) =>
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

		const clientsToSign = sigsNull.clientSigs
			.map((ignore, index) => (ignore ? undefined : partsEcpairs[index]))
			.filter((keypair) => keypair !== undefined);

		const arbitratorsToSign = sigsNull.arbitratorSig ? [] : [arbitratorEcpair];

		const keysToSign = [...clientsToSign, ...arbitratorsToSign];

		expect(keysToSign.length).toBeGreaterThanOrEqual(2);

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
			signer: keysToSign[0]!,
			receivingAddresses: [
				{
					address: firstEcpairAddress.confidentialAddress!,
					value: 100_000_000 - 300,
				},
			],
			blindingKeypair,
			tweak,
		});

		expect(pset).not.toBeUndefined();

		await Promise.all(
			keysToSign.slice(1).map(async (keypair) => {
				await signLiquidTaprootTransaction({
					pset: pset!,
					keypair,
					leafHash: bip341.tapLeafHash({
						scriptHex: redeemOutput,
					}),
					network,
					tweak,
				});
			}),
		);

		const { clientSigs, arbitratorSigs } = getTapscriptSigsOrdered({
			pset: pset!,
			clientPubkeys: parts,
			arbitratorPubkeys: arbitrators,
			tweak,
		});

		const psetSigs = pset!.inputs[0]!.tapScriptSig!;
		const psetSigsHex = psetSigs.map((sig) => sig.signature.toString("hex"));

		function allClientSigsCorrect(clientSigs: (Buffer | null)[]): boolean {
			const allNullValuesInCorrectPlace = clientSigs.every((sig, index) => {
				const shouldBeNull = sigsNull.clientSigs[index];

				if (shouldBeNull && sig === null) return true;

				if (!shouldBeNull && sig !== null) return true;

				return false;
			});

			if (!allNullValuesInCorrectPlace) return false;

			const allSigsExists = clientSigs.every((sig) => {
				if (sig === null) return true; // Skips verification

				if (psetSigsHex.includes(sig.toString("hex"))) return true;

				return false;
			});

			if (!allSigsExists) return false;

			const allSigsMatches = clientSigs.every((sig, index) => {
				if (sig === null) return true; // Skips verification

				const tweakedEcpair = tweakedPartsEcpairs[index]!;

				const xOnlyTweakedPubkey = toXOnly(tweakedEcpair.publicKey);

				const tweakedPubkey = xOnlyTweakedPubkey.toString("hex");

				const pubkeyExistsInSignatures = psetSigs.some(
					(sig) => sig.pubkey.toString("hex") === tweakedPubkey,
				);

				return pubkeyExistsInSignatures;
			});

			return allSigsMatches;
		}

		function arbitratorSigsCorrect(arbitratorSigs: (Buffer | null)[]): boolean {
			const arbitratorSig = arbitratorSigs[0]!;

			const correctNullValue = sigsNull.arbitratorSig && arbitratorSig === null;

			if (correctNullValue) return true;

			const sigExists = psetSigsHex.includes(arbitratorSig.toString("hex"));

			if (sigExists) return true;

			const tweakedEcpair = tweakedArbitratorEcpair;

			const xOnlyTweakedPubkey = toXOnly(tweakedEcpair.publicKey);

			const tweakedPubkey = xOnlyTweakedPubkey.toString("hex");

			const pubkeyExistsInSignatures = psetSigs.some(
				(sig) => sig.pubkey.toString("hex") === tweakedPubkey,
			);

			return pubkeyExistsInSignatures;
		}

		expect(clientSigs).toSatisfy(allClientSigsCorrect);
		expect(arbitratorSigs).toSatisfy(arbitratorSigsCorrect);
	}, { concurrent: true, timeout: 30 * 1000 });
});