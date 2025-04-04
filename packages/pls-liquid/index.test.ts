import { describe, expect } from "vitest";
import {
	createLiquidMultisig,
	finalizeTxSpendingFromLiquidMultisig,
	getTapscriptSigsOrdered,
	signLiquidTaprootTransaction,
	startSpendFromLiquidMultisig,
} from "./index.js";
import { ECPairFactory, ECPairInterface } from "ecpair";
import { Pset, Transaction, address, bip341, networks, crypto } from "liquidjs-lib";

import * as ecc from "tiny-secp256k1";
import { createKeyTweaker } from "pls-bitcoin";

const ECPair = ECPairFactory(ecc);

const API_URL = "http://localhost:3001";

async function takeFromFaucet(address: string) {
	const res = await fetch(`${API_URL}/faucet`, {
		method: "POST",
		body: JSON.stringify({
			address,
		}),
	});

	if (!res.ok) throw new Error(await res.text());

	return (await res.json()).txId;
}

async function getTransactionHexById(txid: string) {
	const res = await fetch(`${API_URL}/tx/${txid}/hex`);

	if (!res.ok) throw new Error(await res.text());

	return await res.text();
}

async function publishTransaction(hex: string) {
	const res = await fetch(`${API_URL}/tx`, {
		method: "POST",
		body: hex,
	});

	if (!res.ok) throw new Error(await res.text());

	return await res.text();
}

async function sleep(ms: number) {
	return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function retryWithDelay<T extends any>(
	func: () => Promise<T>,
	ms: number,
	tries: number
) {
	let i = 0;

	while (i < tries) {
		try {
			return await func();
		} catch (error) {
			await sleep(ms);
		}
		i++;
	}

	throw new Error(`Failed after ${tries} retries`);
}

type TestMultisigWithParametersArgs = {
	clientKeypairs: ECPairInterface[];
	arbitratorKeypairs: ECPairInterface[];
	quorum: number;
	usedKeysCombination: ECPairInterface[];
	blindingKeypair: ECPairInterface;
	tweak: Buffer;
}

async function testMultisigWithParameters({
	clientKeypairs,
	arbitratorKeypairs,
	quorum,
	usedKeysCombination,
	blindingKeypair,
	tweak,
}: TestMultisigWithParametersArgs) {
	const multisig = createLiquidMultisig({
		parts: clientKeypairs.map((ecpair) => ecpair.publicKey.toString("hex")),
		arbitrators: arbitratorKeypairs.map((ecpair) => ecpair.publicKey.toString("hex")),
		arbitratorsQuorum: quorum,
		network: networks.regtest,
		blindingKeypair,
		tweak,
	});

	const inputTransactionId = await takeFromFaucet(multisig.confidentialAddress);

	// since the transaction might not be available instantly
	const inputTransactionHex = await retryWithDelay(
		() => {
			return getTransactionHexById(inputTransactionId);
		},
		3000,
		5
	);

	const inputTransaction = Transaction.fromHex(inputTransactionHex);

	const tweakedUsedKeysCombination = usedKeysCombination.map((ecpair) => {
		const tweaker = createKeyTweaker({
			pubkey: ecpair.publicKey,
			privkey: ecpair.privateKey,
		});

		return tweaker.tweakEcpair(tweak);
	})

	const script = multisig.multisigScripts.find(({ combination }) =>
		tweakedUsedKeysCombination.every((ecpair) =>
			combination.includes(ecpair.publicKey.toString("hex"))
		)
	);

	expect(script).not.toBeUndefined();

	const redeemOutput = script!.leaf.output.toString("hex");

	const inputTxOutputs = inputTransaction.outs
		.map((output, vout) => ({ ...output, vout }))
		.filter(
			(output) =>
				output.script.toString("hex") ===
				address
					.toOutputScript(multisig.address, networks.regtest)
					.toString("hex")
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
		network: networks.regtest,
		signer: usedKeysCombination[0]!,
		receivingAddresses: [
			{
				address: multisig.confidentialAddress,
				value: 100_000_000 - 200,
			},
		],
		blindingKeypair,
		tweak,
	});

	if (!pset) throw new Error("Couldn't create pset");

	await Promise.all(
		usedKeysCombination.slice(1).map(async (keypair) => {
			await signLiquidTaprootTransaction({
				pset,
				keypair,
				leafHash: bip341.tapLeafHash({
					scriptHex: redeemOutput,
				}),
				network: networks.regtest,
				tweak,
			});
		})
	);

	await finalizeAndPublishTx({
		pset,
		clients: clientKeypairs.map((ecpair) => ecpair.publicKey.toString("hex")),
		arbitrators: arbitratorKeypairs.map((ecpair) => ecpair.publicKey.toString("hex")),
		tweak,
	});
}

type FinalizeAndPublishTxArgs = {
	pset: Pset;
	clients: string[];
	arbitrators: string[];
	tweak: Buffer;
}

async function finalizeAndPublishTx({
	pset,
	clients,
	arbitrators,
	tweak,
}: FinalizeAndPublishTxArgs) {
	const { clientSigs, arbitratorSigs } = getTapscriptSigsOrdered({
		pset,
		clientPubkeys: clients,
		arbitratorPubkeys: arbitrators,
		tweak,
	});

	expect(clientSigs).not.toSatisfy((e) => {
		if (!(e instanceof Array))
			return false;

		return e.every((v) => v === null);
	}, "client sigs has all values as null");

	const transaction = finalizeTxSpendingFromLiquidMultisig({
		pset,
		clientSigs,
		arbitratorSigs,
	});

	await publishTransaction(transaction.toHex());
}

describe(
	"1 arbitrator multisig (connects to local liquid node)",
	(it) => {
		const multisigClientsKeypairs = new Array(2).fill(null).map(() => ECPair.makeRandom());

		const multisigArbitratorsKeypairs = [ECPair.makeRandom()];

		const blindingKeypair = ECPair.makeRandom();

		const dataToTweak = "Some value to tweak";

		const tweak = crypto.sha256(Buffer.from(dataToTweak));

		const [keypair1, keypair2] = (multisigClientsKeypairs as [ECPairInterface, ECPairInterface]);

		const [keypair3] = (multisigArbitratorsKeypairs as [ECPairInterface]);

		it("Can spend with 2 clients", async () => {
			const clientKeypairs = [keypair1, keypair2];
			const arbitratorKeypairs = [keypair3];
			const usedKeysCombination = [keypair1, keypair2];

			await testMultisigWithParameters({
				clientKeypairs,
				arbitratorKeypairs,
				quorum: 1,
				usedKeysCombination,
				blindingKeypair,
				tweak,
			});
		});

		it("Can spend with client 1 and arbitrator", async () => {
			const clientKeypairs = [keypair1, keypair2];
			const arbitratorKeypairs = [keypair3];
			const usedKeysCombination = [keypair1, keypair3];

			await testMultisigWithParameters({
				clientKeypairs,
				arbitratorKeypairs,
				quorum: 1,
				usedKeysCombination,
				blindingKeypair,
				tweak,
			});
		});

		it("Can spend with client 2 and arbitrator", async () => {
			const clientKeypairs = [keypair1, keypair2];
			const arbitratorKeypairs = [keypair3];
			const usedKeysCombination = [keypair3, keypair2];

			await testMultisigWithParameters({
				clientKeypairs,
				arbitratorKeypairs,
				quorum: 1,
				usedKeysCombination,
				blindingKeypair,
				tweak,
			});
		});
	},
	{
		timeout: 60 * 1000,
	}
);