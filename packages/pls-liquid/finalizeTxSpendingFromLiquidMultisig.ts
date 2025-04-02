import {
	Pset,
	script,
	payments,
} from "liquidjs-lib";
import {
	Finalizer as PsetFinalizer,
	Extractor as PsetExtractor,
	witnessStackToScriptWitness,
} from "liquidjs-lib/src/psetv2";
import { toReversed } from "./utils/index.js";

type FinalizeTxSpendingFromLiquidMultisigArgs = {
	pset: Pset;
	clientSigs: (Buffer | null)[];
	arbitratorSigs: (Buffer | null)[];
}

export function finalizeTxSpendingFromLiquidMultisig({
	pset,
	clientSigs,
	arbitratorSigs,
}: FinalizeTxSpendingFromLiquidMultisigArgs) {
	const finalizer = new PsetFinalizer(pset);

	pset.inputs.forEach((_, index) => {
		finalizer.finalizeInput(index, (_) => {
			const input = pset.inputs[index];

			const unlockingScript =
				clientSigs[0] && clientSigs[1]
					? script.compile([clientSigs[1], clientSigs[0]])
					: script.compile([
							...toReversed(arbitratorSigs).reduce((acc: Buffer[], sig) => {
								if (sig) acc.push(sig);
								return acc;
							}, []),
							...toReversed(clientSigs).reduce((acc: Buffer[], sig) => {
								if (sig) acc.push(sig);
								return acc;
							}, []),
						]);

			const redeemPayment = payments.p2wsh({
				redeem: {
					input: unlockingScript,
					output: input!.witnessScript,
				},
			});

			const finalScriptWitness = witnessStackToScriptWitness(
				redeemPayment.witness ?? []
			);

			return {
				finalScriptSig: Buffer.from(""),
				finalScriptWitness,
			};
		});
	});

	finalizer.finalize();
	return PsetExtractor.extract(pset);
}