import { createKeyTweaker } from "./createKeyTweaker.js";
import { createBitcoinMultisig } from "./createBitcoinMultisig.js";
import { startTxSpendingFromMultisig } from "./startTxSpendingFromMultisig.js";
import { combine, H, bitcoinSchemas } from "./utils/index.js"

export interface UTXO {
	txid: string;
	vout: number;
	value: number;
}

export {
	createKeyTweaker,

	createBitcoinMultisig,

	startTxSpendingFromMultisig,

	combine,
	H,
	bitcoinSchemas,
}
