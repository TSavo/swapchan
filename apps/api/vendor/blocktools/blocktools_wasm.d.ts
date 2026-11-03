/* tslint:disable */
/* eslint-disable */
/**
 * Base58 (Bitcoin alphabet, no checksum) of hex bytes.
 */
export function base58Encode(hex: string): string;
/**
 * The verifier's allowlists: standard sigs/owner slots, pinned contracts, MultiSend, deadline cap.
 */
export function recoveryTables(): string;
/**
 * Solidity abi.encodePacked. Request JSON {types:"(t1,t2,..)", args:[..]}; returns {data, keccak256}.
 */
export function evmAbiEncodePacked(request_json: string): string;
/**
 * Tron txID (hex) = sha256(raw_data). Input is raw_data hex (tronweb raw_data_hex).
 */
export function tronTxId(raw_data_hex: string): string;
/**
 * Message signature check, as `msg-verify`: EIP-191 personal_sign (0x address, 65-byte hex sig) or Bitcoin Core
 * signmessage (P2PKH address, base64 sig). `message_is_hex`: message is hex bytes. Returns
 * {status:"ok"|"signer_mismatch", chain, address, recovered, v?}; malformed input throws.
 */
export function msgVerify(address: string, message: string, sig: string, message_is_hex: boolean): string;
/**
 * Chains this build knows: JSON array of names.
 */
export function listChains(): string;
/**
 * tx-verify: JSON {ok, failures, warnings}. `max_fee` is a decimal string (sats or wei) or "" (the
 * tx-sign default: 0.01 ETH-equivalent for EVM; UTXO per chain, see policy::default_fee_cap) (untested). `allow_value_with_token` (default false) accepts ETH value
 * alongside ERC-20 transfer calldata. `expected_memo` (UTF-8, optional): the only OP_RETURN payload accepted
 * (one zero-value OP_RETURN, exact match); without it any OP_RETURN is refused (`unexpected_output`).
 */
export function verifyTx(input: string, chain: string, expect_to: string[], change: string[], chain_id: number | null | undefined, max_fee: string, allow_warnings: boolean, allow_value_with_token?: boolean | null, call_json?: string | null, expected_memo?: string | null): string;
/**
 * Plain-text summary of a transaction (what tx-decode --text prints).
 */
export function describeTx(input: string, chain: string): string;
/**
 * `derive::from_xpub(chain, xpub, path, index)`: JSON [{chain,kind,path,address}] for every script kind.
 */
export function deriveFromXpub(chain: string, xpub_str: string, path: string, index: number): string;
/**
 * As convertAddress with the source chain stated.
 */
export function convertAddressFrom(from: string, addr: string, to: string): string;
/**
 * Additive to detectAddress (whose shape is unchanged): JSON {candidates:[{chain,kind}], ambiguous, kinds_agree}.
 * `ambiguous` = more than one chain; `kinds_agree` = every candidate has the same script kind.
 */
export function detectAddressInfo(addr: string): string;
/**
 * Novacoin: raw tx hex from api.novaco.in `/gettransaction/<txid>` decoded JSON (nTime layout).
 * Throws unless reverse(sha256d(raw)) equals `expected_txid` and the JSON `txid`.
 */
export function serializeNvcTxFromJson(json: string, expected_txid: string): string;
/**
 * Associated token account. `token_program` "" = classic SPL Token. Returns {address, bump}.
 */
export function solAssociatedTokenAddress(owner: string, mint: string, token_program: string): string;
/**
 * SS58 address from a 32-byte account id (hex) and prefix (0 Polkadot, 2 Kusama, 42 generic; up to 16383).
 */
export function ss58Encode(account_hex: string, prefix: number): string;
/**
 * m-of-n P2WSH from compressed pubkeys, as `multisig M --pubkey ..`. `network`: bitcoin|testnet|signet|regtest
 * ("" = bitcoin). Returns {chain:"btc", witness_script, address, descriptor}. Pubkey ORDER is consensus-significant.
 */
export function multisigAddress(threshold: number, pubkeys: string[], network: string): string;
/**
 * Resolve a declarative Plan (RFC #15) against a Context to UNSIGNED bytes, as `tx-plan resolve` (same library
 * path). Families evm and utxo; account throws family_not_built (its crate is not in the wasm). Returns
 * {chain, family, type:"evm-1559", unsigned_tx} or {chain, family, type:"psbt", ...utxo fields}.
 */
export function txPlanResolve(plan_json: string, context_json: string): string;
/**
 * As `msg-verify` with options, for the chains whose verify needs them. Input JSON:
 * {"address", "message" | "message_hex", "signature", "format"? ("raw" | "offchain-v0", Solana, required there),
 * "pubkey"? (base64 33-byte compressed key, Cosmos ADR-036, required there), "chain"? ("eth"|"btc"|"tron"|"sol"|"cosmos",
 * required when the address is both valid Cosmos bech32 and a valid Solana key, else `ambiguous_address`)}. Unknown keys and options that do
 * not apply to the detected chain are refused. Returns the same JSON as `msgVerify`
 * ({"status":"ok"|"signer_mismatch","chain","address","recovered"?,"v"?,"format"?,"hrp"?}). No keys.
 */
export function msgVerifyOpts(input: string): string;
/**
 * Strict check of EVM calldata or init code before signing, as tx-verify --call/--abi/--create-hash.
 * Request JSON {to: "0x.." | null, data, sigs?: [signature], abi?: JSON ABI (text or array), createHash?}.
 */
export function evmApproveCall(request_json: string): string;
/**
 * Re-encode a BOLT11 invoice byte-identically, as `bolt11 --reencode`: parse the 5-bit words, drop the
 * checksum, re-emit with a fresh one. Returns {reencoded, roundtrip} (roundtrip true when it equals the
 * lowercased input). Public input, no keys.
 */
export function bolt11Reencode(invoice: string): string;
/**
 * `address::validate(chain, addr)`: address kind string; throws on invalid / unverified chain.
 */
export function addressValidate(chain: string, addr: string): string;
/**
 * Hex bytes of a base58 string; throws bad_base58.
 */
export function base58Decode(s: string): string;
/**
 * Every verified chain (and `zec`) on which `addr` is valid: JSON [{chain,kind}]. Collisions
 * (DGB/DOGE, VIA/VTC, version 50/0 ...) return all candidates; an empty list = unrecognised.
 */
export function detectAddress(addr: string): string;
/**
 * Decode a CashAddr (prefix optional, default "bitcoincash"). Returns {prefix, type:"p2pkh"|"p2sh"|<n>, hash}.
 */
export function cashAddrDecode(addr: string): string;
/**
 * Check a tx against an offline policy file (docs/POLICY.md). Deny by default; the rule for `chain`
 * is used. JSON {ok, failures, warnings, policy_sha256}. Throws on a bad tx or policy file.
 */
export function checkTxPolicy(input: string, chain: string, policy_json: string): string;
/**
 * BLAKE2b of hex `data_hex` with `out_len` bytes (1..64) and a UTF-8 personalization (<= 16 bytes, "" for none). Returns hex.
 */
export function blake2b(data_hex: string, out_len: number, personal: string): string;
/**
 * Substrate twox_128 of UTF-8 `text`. Returns hex.
 */
export function twox128(text: string): string;
/**
 * verifyRecovery on a raw (signed or unsigned) EVM tx hex. Adds "tx":{kind,chainId,signed,from,to,value,data,txid}.
 */
export function verifyRecoveryRaw(raw_hex: string, owner: string, chain_id: number, now_s: number): string;
/**
 * SwapChan verifySweepTx twin. `tx_json` = {from,to,value,data?,chainId}; `token` = "" for a native sweep.
 */
export function verifySweepTx(tx_json_s: string, owner: string, chain_id: number, token: string): string;
/**
 * As `buildUnsignedSweep` with tx timestamp `time` (unix seconds). For pos-ntime chains
 * (ppc/nvc/clam/rdd) returns {chain,tx_format:"pos-ntime",unsigned_tx,time,pos_prevouts,inputs,amount,fee}
 * (no PSBT exists for that format); other chains ignore `time`.
 */
export function buildUnsignedSweepAt(chain: string, utxos: string, to: string, fee_rate: number, time: number): string;
/**
 * Decode Tron raw_data hex or a full signed Transaction hex. JSON: see EXPORTS.md.
 */
export function tronDecodeTx(hex: string): string;
/**
 * Standard output script -> {kind, address}, or null for non-standard scripts.
 */
export function scriptToAddress(chain: string, script_hex: string): string;
/**
 * verifySweepTx on a raw EVM tx hex; the sender is recovered from the signature (unsigned fails closed).
 */
export function verifySweepRaw(raw_hex: string, owner: string, chain_id: number, token: string): string;
/**
 * Library version (semver string, same as the `blocktools` crate).
 */
export function version(): string;
/**
 * Address kind ("P2pkh", "SegwitV0", "Eth", ...) if `address` is valid for `chain`; throws otherwise.
 */
export function validateAddress(chain: string, address: string): string;
/**
 * Legacy base58 BCH address -> CashAddr with `prefix` ("" = bitcoincash).
 */
export function legacyToCashAddr(addr: string, prefix: string): string;
/**
 * Inspect an ABI (JSON or signature lines): items with selectors/topics, selector collisions, ERC-165/ERC-20 interfaces.
 */
export function evmAbiInspect(abi_text: string): string;
/**
 * Decode calldata / returndata / revert data / one log. Request JSON {input, sig?, abi?, types?, output?}.
 */
export function evmAbiDecode(request_json: string): string;
/**
 * Decode a bech32 (segwit v0, `bc1q...`) / bech32m (v1 taproot, `bc1p...`) address into its witness
 * program. Keyless and pure. Returns {version, program_hex, words_hex}: `version` the witness version
 * int, `program_hex` the hex of the decoded witness program bytes (bech32 `fromWords` of the data
 * words after the version), `words_hex` the hex of the raw 5-bit data words themselves (one byte per
 * 5-bit word, each 0..=31).
 */
export function bech32WitnessProgram(address: string): string;
/**
 * Output script (hex) paying `addr` on UTXO `chain` (bch also takes CashAddr). Throws unknown_chain / bad_address.
 */
export function addressToScript(chain: string, addr: string): string;
/**
 * true if a base58 Solana pubkey is an ed25519 curve point (wallet), false if off-curve (PDA); throws on bad input.
 */
export function solIsOnCurve(addr: string): boolean;
/**
 * Full parameter table: JSON [{name,ticker,title,slip44,verified,p2pkh[],p2sh[],hrp,wif,checksum,decimals,forkid,tx_format,sweep_build,sources}].
 */
export function chainParams(): string;
/**
 * Taproot script-path m-of-n (CHECKSIGADD leaf under the BIP341 NUMS key), as `taproot-multisig`. x-only or
 * compressed pubkeys. Returns {chain:"btc", leaf_script, address, control_block, merkle_root, internal_key, descriptor}.
 */
export function taprootMultisigAddress(threshold: number, pubkeys: string[], network: string): string;
/**
 * Decode a wire transaction (hex or base64; legacy or v0). JSON: see EXPORTS.md.
 */
export function solDecodeTx(raw: string): string;
/**
 * Build unsigned Tron `raw_data` (hex; txid = sha256 of it). `plan` JSON: {from, to, ref_block_bytes(hex2),
 * ref_block_hash(hex8), expiration_ms, timestamp_ms, memo?} plus one of amount_sun:"N" |
 * sweep:{balance_sun:"N", reserve_sun:"N"} | trc20:{contract, amount:"N", fee_limit_sun:"N"}. No keys.
 */
export function tronBuildTransfer(plan: string): string;
/**
 * JSON {prefix, account} (account id hex) for an SS58 address; throws bad_base58/bad_prefix/bad_length/bad_checksum.
 */
export function ss58Decode(addr: string): string;
/**
 * Verify a wire transaction against `expect_json` {owner?, to?, lamports?, mint?, amount?, allow_programs?}. Returns {ok, failures, warnings, txid, lamports, token_amount}; fails closed.
 */
export function solVerifyTx(raw: string, expect_json: string): string;
/**
 * Fail-closed tx check, JSON in / JSON out; never throws. See EXPORTS.md for the schema.
 */
export function checkTx(input_json: string): string;
/**
 * Selector / topic of one Solidity signature. JSON: see EXPORTS.md.
 */
export function evmSigHash(signature: string): string;
/**
 * Unsigned sweep of all `utxos` (JSON lines {txid,vout,amount,address[,prev_tx]}) to `to`:
 * JSON {chain,tx_format,psbt,unsigned_tx,inputs,amount,fee}. Legacy, legacy-sha256 and forkid
 * formats; pos-ntime chains need `buildUnsignedSweepAt` (a tx timestamp).
 */
export function buildUnsignedSweep(chain: string, utxos: string, to: string, fee_rate: number): string;
/**
 * EIP-712 typed data: encodeType, domain separator, message hash, digest; with a signature (65-byte or EIP-2098 64-byte) the recovered signer; with an expected signer a verdict.
 * `options_json` (optional) `{expect_chain_id?: "decimal", expect_verifying_contract?: "0x.."}`: the
 * typed-data-verify --expect-chain-id / --expect-verifying-contract checks (status chain_id_mismatch /
 * verifying_contract_mismatch). Wrong types throw `<key>_must_be_string`.
 */
export function evmTypedDataVerify(typed_data_json: string, sig_hex?: string | null, signer?: string | null, options_json?: string | null): string;
/**
 * SwapChan coin selection: own script only, drop value < rate×148×20 (fee > 5%), largest first, max 200 inputs.
 */
export function selectUtxos(utxos_json: string, script_hex: string, fee_rate: number): string;
/**
 * Reverse lookup of a selector/topic among caller-supplied signatures (ABI JSON or one per line).
 */
export function evmSigLookup(hash_hex: string, sigs_text: string): string;
/**
 * SwapChan verifyRecovery twin. `tx_json` = {"to","data","value"}; `now_s` = unix seconds (required; 0 = bad_now).
 * Returns {"verified":true,"call"} or {"verified":false,"reason"}.
 */
export function verifyRecovery(tx_json_s: string, owner: string, now_s: number): string;
/**
 * keccak256 of hex bytes -> "0x" + 64 hex.
 */
export function evmKeccak256(data_hex: string): string;
/**
 * The chain registry as data: JSON array of {name,ticker,coin_type,curve,encoding,...,sign,verified,source}.
 */
export function chainTable(): string;
/**
 * Encode a CashAddr. `kind` "p2pkh" | "p2sh"; `hash_hex` 20 (or 24..64 spec sizes) bytes.
 */
export function cashAddrEncode(prefix: string, kind: string, hash_hex: string): string;
/**
 * findProgramAddress. `seeds_json` = JSON array of hex strings (each <= 32 bytes, <= 15 seeds). Returns {address, bump}.
 */
export function solFindProgramAddress(seeds_json: string, program: string): string;
/**
 * Unsigned PSBT paying `to` with an OP_RETURN `memo_hex` (1..80 bytes) and change.
 * `amount` "" = sweep all UTXOs to `to` (no change). `utxos` = JSON lines {txid,vout,amount,address}.
 * Optional trailing `rbf` (default false): false = nSequence 0xffffffff on every input (non-RBF, required for
 * THORChain inbound txs); true = 0xfffffffd (BIP-125).
 * Returns {psbt (base64), fee, vsize, rbf, outputs:[{address|null, script, value}]}; amounts are decimal strings.
 */
export function buildPsbtWithMemo(chain: string, utxos: string, to: string, amount: string, change: string, fee_rate: number, memo_hex: string, rbf?: boolean | null): string;
/**
 * Anchor discriminator sha256("global:"+name)[..8] as hex.
 */
export function solAnchorDiscriminator(name: string): string;
/**
 * System.Account storage key (hex, no 0x) for an SS58 address or a 32-byte account id hex.
 */
export function polkadotAccountStorageKey(account: string): string;
/**
 * Same hash, re-encoded for `to`; throws `ambiguous_address` when candidates disagree on the script type.
 */
export function convertAddress(addr: string, to: string): string;
/**
 * CashAddr -> legacy base58 address.
 */
export function cashAddrToLegacy(addr: string): string;
/**
 * ABI-encode calldata or a bare type list. Request JSON {sig, args:[..]}.
 */
export function evmAbiEncode(request_json: string): string;
/**
 * Verified (supported) chains: JSON [{name,ticker,title,slip44,verified:true,sources:[{name,url,api,checked}]}].
 */
export function supportedChains(): string;
/**
 * SCALE AccountInfo (80 bytes hex, as returned by state_getStorage) -> JSON {nonce,consumers,providers,sufficients,data:{free,reserved,frozen,flags}}; u128 as decimal strings.
 */
export function decodeAccountInfo(hex: string): string;
/**
 * CREATE / CREATE2 contract address. Request JSON {deployer, nonce} or {deployer, salt, init_code_hash | init_code}; a tx (from, nonce) also works.
 */
export function evmCreateAddress(request_json: string): string;
/**
 * Decode a BOLT11 Lightning invoice, as `bolt11`: bech32 (BIP173) + tagged fields + the payee pubkey
 * RECOVERED from the signature. Returns the fields {network, currency, timestamp, recovered_payee,
 * signature, recovery_id, routing_hints, amount_msat?, amount_raw?, payment_hash?, payment_secret?,
 * description?, description_hash?, payee_pubkey?, features?, fallback?, expiry?, min_final_cltv_expiry?}.
 * Public input, no keys, no channel protocol; malformed input throws a stable snake_case code.
 */
export function bolt11Decode(invoice: string): string;
/**
 * Watch-only addresses from an account-level xpub: JSON [{chain,kind,path,address}].
 */
export function addressesFromXpub(xpub_str: string, chain: string, kinds: string[], branches: Uint32Array, indices: Uint32Array): string;
/**
 * THORChain inbound send check (btc/ltc/doge/bch); never throws. Shape must be exactly
 * [vault == amount, optional change -> change_addr, OP_RETURN == memo bytes], non-RBF, inputs known
 * (and owned by `taker_addrs`: one address, a JSON array, or ""), fee <= `max_fee` ("" = chain default).
 * `amount`/`max_fee` are decimal strings. Returns {ok, failures[], outputs, memo, fee, rbf}.
 */
export function verifyThorSend(chain: string, tx_or_psbt: string, expected_vault: string, expected_memo: string, expected_amount: string, change_addr: string, taker_addrs: string, max_fee: string): string;
/**
 * Unsigned EIP-155 transfer (ETH forks / extra EVM chains, native or ERC-20). Request JSON:
 * {chainId, nonce, gas, gasPrice, to, value | balance, token?, maxPriorityFeePerGas?, from?}.
 * Returns {unsigned, sighash, kind, chainId, nonce, gas, gasPrice, to, value, data, fee, ...}.
 */
export function buildEvmTransfer(req_json: string): string;
/**
 * Classify runtime bytecode (EIP-1167 / EIP-7702 / EOF), EIP-170 size, Solidity metadata, opcode counts, selector candidates.
 */
export function evmBytecodeInspect(code_hex: string): string;
/**
 * `derive --explain` for the given derive flags: JSON [{chain,kind,template,path,count}]. No keys.
 */
export function explainPlan(args: string[]): string;
/**
 * Merge cosigners' partial-signature PSBTs (base64 or hex, as tx-combine reads them) and finalize at threshold.
 * Returns {signed_tx: hex, psbt: base64}. Throws not_enough_signatures / psbts_do_not_combine / not_a_psbt / no_psbts.
 */
export function combinePsbts(psbts: string[]): string;
export function decodeTx(input: string, chain: string): string;
/**
 * Known but unverified chains (NOT supported by the other calls): same shape, verified:false.
 */
export function unverifiedChains(): string;
/**
 * Build an unsigned Solana legacy transfer (one zeroed signature + message; byte-identical to
 * @solana/kit). `plan` JSON: {from, to, blockhash, priority?:[micro_lamports_str, cu_limit]} plus one of
 * lamports:"N" | sweep_balance:"N" | token:{mint, amount:"N", decimals, token_program, create_ata}.
 * Returns hex. Takes no keys; sign elsewhere.
 */
export function solBuildTransfer(plan: string): string;
