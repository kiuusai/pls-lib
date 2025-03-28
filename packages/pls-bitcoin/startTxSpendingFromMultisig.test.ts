import { describe, expect, test } from "vitest"
import * as ecc from "tiny-secp256k1";
import { ECPairFactory } from "ecpair";
import * as bitcoin from "bitcoinjs-lib";
import { createBitcoinMultisig, createKeyTweaker, startTxSpendingFromMultisig } from "./index.js";
import {
  takeFromFaucet,
  retryWithDelay,
  getTransactionHexById,
  publishTransaction,
} from "./utils/test.js"

const ECPair = ECPairFactory(ecc);

bitcoin.initEccLib(ecc);

describe.each([
  {
    withTweak: false,
  },
  {
    withTweak: true,
  },
])(
  "startTxSpendingFromMultisig test with tweak $withTweak",
  ({ withTweak }) => {
    const partsEcpairs = new Array(2).fill(null).map(() => ECPair.makeRandom());

    const arbitratorEcpair = ECPair.makeRandom();

    const contentToTweak = "Some content to tweak";
    const tweak = bitcoin.crypto.sha256(Buffer.from(contentToTweak));

    const network = bitcoin.networks.regtest;

    const multisig = createBitcoinMultisig({
      publicPartsECPairs: partsEcpairs,
      publicArbitratorsECPairs: [arbitratorEcpair],
      arbitratorsQuorum: 1,
      network,
      tweak: withTweak ? tweak : undefined,
    });

    const tweakedSelectedCombination = withTweak ? partsEcpairs.map(ecpair => {
      const tweaker = createKeyTweaker({
        pubkey: ecpair.publicKey,
        privkey: ecpair.privateKey,
      });

      return tweaker.tweakEcpair(tweak);
    }) : partsEcpairs;


    const firstEcpairAddress = bitcoin.payments.p2pkh({
      pubkey: partsEcpairs[0]!.publicKey,
      network,
    });

    test(
      "spending correctly started", async () => {
        const inputTransactionId = await takeFromFaucet(multisig.multisig.address!);

	      const inputTransactionHex = await retryWithDelay(
		      () => getTransactionHexById(inputTransactionId),
		      500,
		      30,
	      );

        const inputTransaction = bitcoin.Transaction.fromHex(inputTransactionHex);

        const script = multisig.multisigScripts.find(
          ({ combination }) => tweakedSelectedCombination.every(
            (ecpair) => combination.map(combination => combination.publicKey.toString("hex"))
              .includes(ecpair.publicKey.toString("hex")),
          ),
        );

        expect(script).not.toBeUndefined();

        const inputTxOutputs = inputTransaction.outs
          .map((output, vout) => ({ ...output, vout }))
          .filter(
            (output) => output.script.toString("hex") === bitcoin.address
              .toOutputScript(multisig.multisig.address!, network)
              .toString("hex")
          );

        expect(inputTxOutputs.length).toEqual(1);

        const balanceToSpend = inputTxOutputs.map(output => output.value).reduce((a, b) => a + b, 0) - 300;

        const utxos = inputTxOutputs.map((output) => ({
          txid: inputTransactionId,
          vout: output.vout,
          value: output.value,
        }));

        const psbt = await startTxSpendingFromMultisig(
          multisig.multisig,
          script!.leaf.output.toString("hex"),
          partsEcpairs[0]!,
          network,
          [
            {
              address: firstEcpairAddress.address!,
              value: balanceToSpend,
            },
          ],
          utxos,
          undefined,
          withTweak ? tweak : undefined,
        );

        const tweakedSecondEcpair = withTweak ? (() => {
          const tweaker = createKeyTweaker({
            pubkey: partsEcpairs[1]!.publicKey,
            privkey: partsEcpairs[1]!.privateKey,
          });

          return tweaker.tweakEcpair(tweak);
        })() : partsEcpairs[1]!;

        await psbt.signAllInputsAsync(tweakedSecondEcpair);

        psbt.finalizeAllInputs();

        const tx = psbt.extractTransaction();

        await publishTransaction(tx.toHex());
      },
      {
        timeout: 30 * 1000,
      },
    )
  },
  {
    concurrent: true,
  }
)
