
let imports = {};
imports['__wbindgen_placeholder__'] = module.exports;
let wasm;
const { TextDecoder, TextEncoder } = require(`util`);

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });

cachedTextDecoder.decode();

let cachedUint8ArrayMemory0 = null;

function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function getStringFromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

let WASM_VECTOR_LEN = 0;

let cachedTextEncoder = new TextEncoder('utf-8');

const encodeString = (typeof cachedTextEncoder.encodeInto === 'function'
    ? function (arg, view) {
    return cachedTextEncoder.encodeInto(arg, view);
}
    : function (arg, view) {
    const buf = cachedTextEncoder.encode(arg);
    view.set(buf);
    return {
        read: arg.length,
        written: buf.length
    };
});

function passStringToWasm0(arg, malloc, realloc) {
    if (typeof arg !== "string") throw new TypeError("expected_string");

    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;

    const mem = getUint8ArrayMemory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }

    if (offset !== len) {
        if (offset !== 0) {
            arg = arg.slice(offset);
        }
        ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
        const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
        const ret = encodeString(arg, view);

        offset += ret.written;
        ptr = realloc(ptr, len, offset, 1) >>> 0;
    }

    WASM_VECTOR_LEN = offset;
    return ptr;
}

function isLikeNone(x) {
    return x === undefined || x === null;
}

let cachedDataViewMemory0 = null;

function getDataViewMemory0() {
    if (cachedDataViewMemory0 === null || cachedDataViewMemory0.buffer.detached === true || (cachedDataViewMemory0.buffer.detached === undefined && cachedDataViewMemory0.buffer !== wasm.memory.buffer)) {
        cachedDataViewMemory0 = new DataView(wasm.memory.buffer);
    }
    return cachedDataViewMemory0;
}

function takeFromExternrefTable0(idx) {
    const value = wasm.__wbindgen_export_0.get(idx);
    wasm.__externref_table_dealloc(idx);
    return value;
}
/**
 * Decode calldata / returndata / revert data / one log. Request JSON {input, sig?, abi?, types?, output?}.
 * @param {string} request_json
 * @returns {string}
 */
module.exports.evmAbiDecode = function(request_json) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(request_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.evmAbiDecode(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
};

/**
 * @param {string} input
 * @param {string} chain
 * @returns {string}
 */
module.exports.decodeTx = function(input, chain) {
    let deferred4_0;
    let deferred4_1;
    try {
        const ptr0 = passStringToWasm0(input, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(chain, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.decodeTx(ptr0, len0, ptr1, len1);
        var ptr3 = ret[0];
        var len3 = ret[1];
        if (ret[3]) {
            ptr3 = 0; len3 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred4_0 = ptr3;
        deferred4_1 = len3;
        return getStringFromWasm0(ptr3, len3);
    } finally {
        wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
    }
};

/**
 * Base58 (Bitcoin alphabet, no checksum) of hex bytes.
 * @param {string} hex
 * @returns {string}
 */
module.exports.base58Encode = function(hex) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(hex, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.base58Encode(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
};

/**
 * SwapChan coin selection: own script only, drop value < rate×148×20 (fee > 5%), largest first, max 200 inputs.
 * @param {string} utxos_json
 * @param {string} script_hex
 * @param {number} fee_rate
 * @returns {string}
 */
module.exports.selectUtxos = function(utxos_json, script_hex, fee_rate) {
    let deferred4_0;
    let deferred4_1;
    try {
        const ptr0 = passStringToWasm0(utxos_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(script_hex, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.selectUtxos(ptr0, len0, ptr1, len1, fee_rate);
        var ptr3 = ret[0];
        var len3 = ret[1];
        if (ret[3]) {
            ptr3 = 0; len3 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred4_0 = ptr3;
        deferred4_1 = len3;
        return getStringFromWasm0(ptr3, len3);
    } finally {
        wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
    }
};

/**
 * Same hash, re-encoded for `to`; throws `ambiguous_address` when candidates disagree on the script type.
 * @param {string} addr
 * @param {string} to
 * @returns {string}
 */
module.exports.convertAddress = function(addr, to) {
    let deferred4_0;
    let deferred4_1;
    try {
        const ptr0 = passStringToWasm0(addr, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(to, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.convertAddress(ptr0, len0, ptr1, len1);
        var ptr3 = ret[0];
        var len3 = ret[1];
        if (ret[3]) {
            ptr3 = 0; len3 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred4_0 = ptr3;
        deferred4_1 = len3;
        return getStringFromWasm0(ptr3, len3);
    } finally {
        wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
    }
};

/**
 * The chain registry as data: JSON array of {name,ticker,coin_type,curve,encoding,...,sign,verified,source}.
 * @returns {string}
 */
module.exports.chainTable = function() {
    let deferred1_0;
    let deferred1_1;
    try {
        const ret = wasm.chainTable();
        deferred1_0 = ret[0];
        deferred1_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
    }
};

/**
 * Hex bytes of a base58 string; throws bad_base58.
 * @param {string} s
 * @returns {string}
 */
module.exports.base58Decode = function(s) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(s, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.base58Decode(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
};

/**
 * Decode Tron raw_data hex or a full signed Transaction hex. JSON: see EXPORTS.md.
 * @param {string} hex
 * @returns {string}
 */
module.exports.tronDecodeTx = function(hex) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(hex, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.tronDecodeTx(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
};

/**
 * Output script (hex) paying `addr` on UTXO `chain` (bch also takes CashAddr). Throws unknown_chain / bad_address.
 * @param {string} chain
 * @param {string} addr
 * @returns {string}
 */
module.exports.addressToScript = function(chain, addr) {
    let deferred4_0;
    let deferred4_1;
    try {
        const ptr0 = passStringToWasm0(chain, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(addr, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.addressToScript(ptr0, len0, ptr1, len1);
        var ptr3 = ret[0];
        var len3 = ret[1];
        if (ret[3]) {
            ptr3 = 0; len3 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred4_0 = ptr3;
        deferred4_1 = len3;
        return getStringFromWasm0(ptr3, len3);
    } finally {
        wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
    }
};

/**
 * CashAddr -> legacy base58 address.
 * @param {string} addr
 * @returns {string}
 */
module.exports.cashAddrToLegacy = function(addr) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(addr, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.cashAddrToLegacy(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
};

/**
 * As `buildUnsignedSweep` with tx timestamp `time` (unix seconds). For pos-ntime chains
 * (ppc/nvc/clam/rdd) returns {chain,tx_format:"pos-ntime",unsigned_tx,time,pos_prevouts,inputs,amount,fee}
 * (no PSBT exists for that format); other chains ignore `time`.
 * @param {string} chain
 * @param {string} utxos
 * @param {string} to
 * @param {number} fee_rate
 * @param {number} time
 * @returns {string}
 */
module.exports.buildUnsignedSweepAt = function(chain, utxos, to, fee_rate, time) {
    let deferred5_0;
    let deferred5_1;
    try {
        const ptr0 = passStringToWasm0(chain, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(utxos, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(to, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len2 = WASM_VECTOR_LEN;
        const ret = wasm.buildUnsignedSweepAt(ptr0, len0, ptr1, len1, ptr2, len2, fee_rate, time);
        var ptr4 = ret[0];
        var len4 = ret[1];
        if (ret[3]) {
            ptr4 = 0; len4 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred5_0 = ptr4;
        deferred5_1 = len4;
        return getStringFromWasm0(ptr4, len4);
    } finally {
        wasm.__wbindgen_free(deferred5_0, deferred5_1, 1);
    }
};

/**
 * Unsigned PSBT paying `to` with an OP_RETURN `memo_hex` (1..80 bytes) and change.
 * `amount` "" = sweep all UTXOs to `to` (no change). `utxos` = JSON lines {txid,vout,amount,address}.
 * Optional trailing `rbf` (default false): false = nSequence 0xffffffff on every input (non-RBF, required for
 * THORChain inbound txs); true = 0xfffffffd (BIP-125).
 * Returns {psbt (base64), fee, vsize, rbf, outputs:[{address|null, script, value}]}; amounts are decimal strings.
 * @param {string} chain
 * @param {string} utxos
 * @param {string} to
 * @param {string} amount
 * @param {string} change
 * @param {number} fee_rate
 * @param {string} memo_hex
 * @param {boolean | null} [rbf]
 * @returns {string}
 */
module.exports.buildPsbtWithMemo = function(chain, utxos, to, amount, change, fee_rate, memo_hex, rbf) {
    let deferred8_0;
    let deferred8_1;
    try {
        const ptr0 = passStringToWasm0(chain, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(utxos, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(to, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len2 = WASM_VECTOR_LEN;
        const ptr3 = passStringToWasm0(amount, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len3 = WASM_VECTOR_LEN;
        const ptr4 = passStringToWasm0(change, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len4 = WASM_VECTOR_LEN;
        const ptr5 = passStringToWasm0(memo_hex, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len5 = WASM_VECTOR_LEN;
        const ret = wasm.buildPsbtWithMemo(ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, ptr4, len4, fee_rate, ptr5, len5, isLikeNone(rbf) ? 0xFFFFFF : rbf ? 1 : 0);
        var ptr7 = ret[0];
        var len7 = ret[1];
        if (ret[3]) {
            ptr7 = 0; len7 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred8_0 = ptr7;
        deferred8_1 = len7;
        return getStringFromWasm0(ptr7, len7);
    } finally {
        wasm.__wbindgen_free(deferred8_0, deferred8_1, 1);
    }
};

/**
 * Strict check of EVM calldata or init code before signing, as tx-verify --call/--abi/--create-hash.
 * Request JSON {to: "0x.." | null, data, sigs?: [signature], abi?: JSON ABI (text or array), createHash?}.
 * @param {string} request_json
 * @returns {string}
 */
module.exports.evmApproveCall = function(request_json) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(request_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.evmApproveCall(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
};

/**
 * Selector / topic of one Solidity signature. JSON: see EXPORTS.md.
 * @param {string} signature
 * @returns {string}
 */
module.exports.evmSigHash = function(signature) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(signature, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.evmSigHash(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
};

/**
 * Anchor discriminator sha256("global:"+name)[..8] as hex.
 * @param {string} name
 * @returns {string}
 */
module.exports.solAnchorDiscriminator = function(name) {
    let deferred2_0;
    let deferred2_1;
    try {
        const ptr0 = passStringToWasm0(name, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.solAnchorDiscriminator(ptr0, len0);
        deferred2_0 = ret[0];
        deferred2_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
    }
};

/**
 * verifyRecovery on a raw (signed or unsigned) EVM tx hex. Adds "tx":{kind,chainId,signed,from,to,value,data,txid}.
 * @param {string} raw_hex
 * @param {string} owner
 * @param {number} chain_id
 * @param {number} now_s
 * @returns {string}
 */
module.exports.verifyRecoveryRaw = function(raw_hex, owner, chain_id, now_s) {
    let deferred4_0;
    let deferred4_1;
    try {
        const ptr0 = passStringToWasm0(raw_hex, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(owner, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.verifyRecoveryRaw(ptr0, len0, ptr1, len1, chain_id, now_s);
        var ptr3 = ret[0];
        var len3 = ret[1];
        if (ret[3]) {
            ptr3 = 0; len3 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred4_0 = ptr3;
        deferred4_1 = len3;
        return getStringFromWasm0(ptr3, len3);
    } finally {
        wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
    }
};

function addToExternrefTable0(obj) {
    const idx = wasm.__externref_table_alloc();
    wasm.__wbindgen_export_0.set(idx, obj);
    return idx;
}

function passArrayJsValueToWasm0(array, malloc) {
    const ptr = malloc(array.length * 4, 4) >>> 0;
    for (let i = 0; i < array.length; i++) {
        const add = addToExternrefTable0(array[i]);
        getDataViewMemory0().setUint32(ptr + 4 * i, add, true);
    }
    WASM_VECTOR_LEN = array.length;
    return ptr;
}
/**
 * Taproot script-path m-of-n (CHECKSIGADD leaf under the BIP341 NUMS key), as `taproot-multisig`. x-only or
 * compressed pubkeys. Returns {chain:"btc", leaf_script, address, control_block, merkle_root, internal_key, descriptor}.
 * @param {number} threshold
 * @param {string[]} pubkeys
 * @param {string} network
 * @returns {string}
 */
module.exports.taprootMultisigAddress = function(threshold, pubkeys, network) {
    let deferred4_0;
    let deferred4_1;
    try {
        const ptr0 = passArrayJsValueToWasm0(pubkeys, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(network, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.taprootMultisigAddress(threshold, ptr0, len0, ptr1, len1);
        var ptr3 = ret[0];
        var len3 = ret[1];
        if (ret[3]) {
            ptr3 = 0; len3 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred4_0 = ptr3;
        deferred4_1 = len3;
        return getStringFromWasm0(ptr3, len3);
    } finally {
        wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
    }
};

/**
 * Check a tx against an offline policy file (docs/POLICY.md). Deny by default; the rule for `chain`
 * is used. JSON {ok, failures, warnings, policy_sha256}. Throws on a bad tx or policy file.
 * @param {string} input
 * @param {string} chain
 * @param {string} policy_json
 * @returns {string}
 */
module.exports.checkTxPolicy = function(input, chain, policy_json) {
    let deferred5_0;
    let deferred5_1;
    try {
        const ptr0 = passStringToWasm0(input, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(chain, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(policy_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len2 = WASM_VECTOR_LEN;
        const ret = wasm.checkTxPolicy(ptr0, len0, ptr1, len1, ptr2, len2);
        var ptr4 = ret[0];
        var len4 = ret[1];
        if (ret[3]) {
            ptr4 = 0; len4 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred5_0 = ptr4;
        deferred5_1 = len4;
        return getStringFromWasm0(ptr4, len4);
    } finally {
        wasm.__wbindgen_free(deferred5_0, deferred5_1, 1);
    }
};

/**
 * SwapChan verifyRecovery twin. `tx_json` = {"to","data","value"}; `now_s` = unix seconds (required; 0 = bad_now).
 * Returns {"verified":true,"call"} or {"verified":false,"reason"}.
 * @param {string} tx_json_s
 * @param {string} owner
 * @param {number} now_s
 * @returns {string}
 */
module.exports.verifyRecovery = function(tx_json_s, owner, now_s) {
    let deferred4_0;
    let deferred4_1;
    try {
        const ptr0 = passStringToWasm0(tx_json_s, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(owner, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.verifyRecovery(ptr0, len0, ptr1, len1, now_s);
        var ptr3 = ret[0];
        var len3 = ret[1];
        if (ret[3]) {
            ptr3 = 0; len3 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred4_0 = ptr3;
        deferred4_1 = len3;
        return getStringFromWasm0(ptr3, len3);
    } finally {
        wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
    }
};

/**
 * Build unsigned Tron `raw_data` (hex; txid = sha256 of it). `plan` JSON: {from, to, ref_block_bytes(hex2),
 * ref_block_hash(hex8), expiration_ms, timestamp_ms, memo?} plus one of amount_sun:"N" |
 * sweep:{balance_sun:"N", reserve_sun:"N"} | trc20:{contract, amount:"N", fee_limit_sun:"N"}. No keys.
 * @param {string} plan
 * @returns {string}
 */
module.exports.tronBuildTransfer = function(plan) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(plan, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.tronBuildTransfer(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
};

/**
 * Plain-text summary of a transaction (what tx-decode --text prints).
 * @param {string} input
 * @param {string} chain
 * @returns {string}
 */
module.exports.describeTx = function(input, chain) {
    let deferred4_0;
    let deferred4_1;
    try {
        const ptr0 = passStringToWasm0(input, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(chain, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.describeTx(ptr0, len0, ptr1, len1);
        var ptr3 = ret[0];
        var len3 = ret[1];
        if (ret[3]) {
            ptr3 = 0; len3 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred4_0 = ptr3;
        deferred4_1 = len3;
        return getStringFromWasm0(ptr3, len3);
    } finally {
        wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
    }
};

/**
 * Verified (supported) chains: JSON [{name,ticker,title,slip44,verified:true,sources:[{name,url,api,checked}]}].
 * @returns {string}
 */
module.exports.supportedChains = function() {
    let deferred1_0;
    let deferred1_1;
    try {
        const ret = wasm.supportedChains();
        deferred1_0 = ret[0];
        deferred1_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
    }
};

/**
 * Message signature check, as `msg-verify`: EIP-191 personal_sign (0x address, 65-byte hex sig) or Bitcoin Core
 * signmessage (P2PKH address, base64 sig). `message_is_hex`: message is hex bytes. Returns
 * {status:"ok"|"signer_mismatch", chain, address, recovered, v?}; malformed input throws.
 * @param {string} address
 * @param {string} message
 * @param {string} sig
 * @param {boolean} message_is_hex
 * @returns {string}
 */
module.exports.msgVerify = function(address, message, sig, message_is_hex) {
    let deferred5_0;
    let deferred5_1;
    try {
        const ptr0 = passStringToWasm0(address, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(message, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(sig, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len2 = WASM_VECTOR_LEN;
        const ret = wasm.msgVerify(ptr0, len0, ptr1, len1, ptr2, len2, message_is_hex);
        var ptr4 = ret[0];
        var len4 = ret[1];
        if (ret[3]) {
            ptr4 = 0; len4 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred5_0 = ptr4;
        deferred5_1 = len4;
        return getStringFromWasm0(ptr4, len4);
    } finally {
        wasm.__wbindgen_free(deferred5_0, deferred5_1, 1);
    }
};

/**
 * Unsigned EIP-155 transfer (ETH forks / extra EVM chains, native or ERC-20). Request JSON:
 * {chainId, nonce, gas, gasPrice, to, value | balance, token?, maxPriorityFeePerGas?, from?}.
 * Returns {unsigned, sighash, kind, chainId, nonce, gas, gasPrice, to, value, data, fee, ...}.
 * @param {string} req_json
 * @returns {string}
 */
module.exports.buildEvmTransfer = function(req_json) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(req_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.buildEvmTransfer(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
};

/**
 * Full parameter table: JSON [{name,ticker,title,slip44,verified,p2pkh[],p2sh[],hrp,wif,checksum,decimals,forkid,tx_format,sweep_build,sources}].
 * @returns {string}
 */
module.exports.chainParams = function() {
    let deferred1_0;
    let deferred1_1;
    try {
        const ret = wasm.chainParams();
        deferred1_0 = ret[0];
        deferred1_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
    }
};

/**
 * findProgramAddress. `seeds_json` = JSON array of hex strings (each <= 32 bytes, <= 15 seeds). Returns {address, bump}.
 * @param {string} seeds_json
 * @param {string} program
 * @returns {string}
 */
module.exports.solFindProgramAddress = function(seeds_json, program) {
    let deferred4_0;
    let deferred4_1;
    try {
        const ptr0 = passStringToWasm0(seeds_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(program, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.solFindProgramAddress(ptr0, len0, ptr1, len1);
        var ptr3 = ret[0];
        var len3 = ret[1];
        if (ret[3]) {
            ptr3 = 0; len3 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred4_0 = ptr3;
        deferred4_1 = len3;
        return getStringFromWasm0(ptr3, len3);
    } finally {
        wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
    }
};

/**
 * System.Account storage key (hex, no 0x) for an SS58 address or a 32-byte account id hex.
 * @param {string} account
 * @returns {string}
 */
module.exports.polkadotAccountStorageKey = function(account) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(account, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.polkadotAccountStorageKey(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
};

/**
 * Verify a wire transaction against `expect_json` {owner?, to?, lamports?, mint?, amount?, allow_programs?}. Returns {ok, failures, warnings, txid, lamports, token_amount}; fails closed.
 * @param {string} raw
 * @param {string} expect_json
 * @returns {string}
 */
module.exports.solVerifyTx = function(raw, expect_json) {
    let deferred4_0;
    let deferred4_1;
    try {
        const ptr0 = passStringToWasm0(raw, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(expect_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.solVerifyTx(ptr0, len0, ptr1, len1);
        var ptr3 = ret[0];
        var len3 = ret[1];
        if (ret[3]) {
            ptr3 = 0; len3 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred4_0 = ptr3;
        deferred4_1 = len3;
        return getStringFromWasm0(ptr3, len3);
    } finally {
        wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
    }
};

/**
 * Classify runtime bytecode (EIP-1167 / EIP-7702 / EOF), EIP-170 size, Solidity metadata, opcode counts, selector candidates.
 * @param {string} code_hex
 * @returns {string}
 */
module.exports.evmBytecodeInspect = function(code_hex) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(code_hex, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.evmBytecodeInspect(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
};

/**
 * Resolve a declarative Plan (RFC #15) against a Context to UNSIGNED bytes, as `tx-plan resolve` (same library
 * path). Families evm and utxo; account throws family_not_built (its crate is not in the wasm). Returns
 * {chain, family, type:"evm-1559", unsigned_tx} or {chain, family, type:"psbt", ...utxo fields}.
 * @param {string} plan_json
 * @param {string} context_json
 * @returns {string}
 */
module.exports.txPlanResolve = function(plan_json, context_json) {
    let deferred4_0;
    let deferred4_1;
    try {
        const ptr0 = passStringToWasm0(plan_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(context_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.txPlanResolve(ptr0, len0, ptr1, len1);
        var ptr3 = ret[0];
        var len3 = ret[1];
        if (ret[3]) {
            ptr3 = 0; len3 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred4_0 = ptr3;
        deferred4_1 = len3;
        return getStringFromWasm0(ptr3, len3);
    } finally {
        wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
    }
};

/**
 * Associated token account. `token_program` "" = classic SPL Token. Returns {address, bump}.
 * @param {string} owner
 * @param {string} mint
 * @param {string} token_program
 * @returns {string}
 */
module.exports.solAssociatedTokenAddress = function(owner, mint, token_program) {
    let deferred5_0;
    let deferred5_1;
    try {
        const ptr0 = passStringToWasm0(owner, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(mint, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(token_program, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len2 = WASM_VECTOR_LEN;
        const ret = wasm.solAssociatedTokenAddress(ptr0, len0, ptr1, len1, ptr2, len2);
        var ptr4 = ret[0];
        var len4 = ret[1];
        if (ret[3]) {
            ptr4 = 0; len4 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred5_0 = ptr4;
        deferred5_1 = len4;
        return getStringFromWasm0(ptr4, len4);
    } finally {
        wasm.__wbindgen_free(deferred5_0, deferred5_1, 1);
    }
};

/**
 * Fail-closed tx check, JSON in / JSON out; never throws. See EXPORTS.md for the schema.
 * @param {string} input_json
 * @returns {string}
 */
module.exports.checkTx = function(input_json) {
    let deferred2_0;
    let deferred2_1;
    try {
        const ptr0 = passStringToWasm0(input_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.checkTx(ptr0, len0);
        deferred2_0 = ret[0];
        deferred2_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
    }
};

/**
 * Decode a CashAddr (prefix optional, default "bitcoincash"). Returns {prefix, type:"p2pkh"|"p2sh"|<n>, hash}.
 * @param {string} addr
 * @returns {string}
 */
module.exports.cashAddrDecode = function(addr) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(addr, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.cashAddrDecode(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
};

/**
 * Chains this build knows: JSON array of names.
 * @returns {string}
 */
module.exports.listChains = function() {
    let deferred1_0;
    let deferred1_1;
    try {
        const ret = wasm.listChains();
        deferred1_0 = ret[0];
        deferred1_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
    }
};

/**
 * Decode a BOLT11 Lightning invoice, as `bolt11`: bech32 (BIP173) + tagged fields + the payee pubkey
 * RECOVERED from the signature. Returns the fields {network, currency, timestamp, recovered_payee,
 * signature, recovery_id, routing_hints, amount_msat?, amount_raw?, payment_hash?, payment_secret?,
 * description?, description_hash?, payee_pubkey?, features?, fallback?, expiry?, min_final_cltv_expiry?}.
 * Public input, no keys, no channel protocol; malformed input throws a stable snake_case code.
 * @param {string} invoice
 * @returns {string}
 */
module.exports.bolt11Decode = function(invoice) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(invoice, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.bolt11Decode(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
};

/**
 * SwapChan verifySweepTx twin. `tx_json` = {from,to,value,data?,chainId}; `token` = "" for a native sweep.
 * @param {string} tx_json_s
 * @param {string} owner
 * @param {number} chain_id
 * @param {string} token
 * @returns {string}
 */
module.exports.verifySweepTx = function(tx_json_s, owner, chain_id, token) {
    let deferred5_0;
    let deferred5_1;
    try {
        const ptr0 = passStringToWasm0(tx_json_s, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(owner, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(token, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len2 = WASM_VECTOR_LEN;
        const ret = wasm.verifySweepTx(ptr0, len0, ptr1, len1, chain_id, ptr2, len2);
        var ptr4 = ret[0];
        var len4 = ret[1];
        if (ret[3]) {
            ptr4 = 0; len4 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred5_0 = ptr4;
        deferred5_1 = len4;
        return getStringFromWasm0(ptr4, len4);
    } finally {
        wasm.__wbindgen_free(deferred5_0, deferred5_1, 1);
    }
};

/**
 * Novacoin: raw tx hex from api.novaco.in `/gettransaction/<txid>` decoded JSON (nTime layout).
 * Throws unless reverse(sha256d(raw)) equals `expected_txid` and the JSON `txid`.
 * @param {string} json
 * @param {string} expected_txid
 * @returns {string}
 */
module.exports.serializeNvcTxFromJson = function(json, expected_txid) {
    let deferred4_0;
    let deferred4_1;
    try {
        const ptr0 = passStringToWasm0(json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(expected_txid, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.serializeNvcTxFromJson(ptr0, len0, ptr1, len1);
        var ptr3 = ret[0];
        var len3 = ret[1];
        if (ret[3]) {
            ptr3 = 0; len3 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred4_0 = ptr3;
        deferred4_1 = len3;
        return getStringFromWasm0(ptr3, len3);
    } finally {
        wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
    }
};

/**
 * THORChain inbound send check (btc/ltc/doge/bch); never throws. Shape must be exactly
 * [vault == amount, optional change -> change_addr, OP_RETURN == memo bytes], non-RBF, inputs known
 * (and owned by `taker_addrs`: one address, a JSON array, or ""), fee <= `max_fee` ("" = chain default).
 * `amount`/`max_fee` are decimal strings. Returns {ok, failures[], outputs, memo, fee, rbf}.
 * @param {string} chain
 * @param {string} tx_or_psbt
 * @param {string} expected_vault
 * @param {string} expected_memo
 * @param {string} expected_amount
 * @param {string} change_addr
 * @param {string} taker_addrs
 * @param {string} max_fee
 * @returns {string}
 */
module.exports.verifyThorSend = function(chain, tx_or_psbt, expected_vault, expected_memo, expected_amount, change_addr, taker_addrs, max_fee) {
    let deferred9_0;
    let deferred9_1;
    try {
        const ptr0 = passStringToWasm0(chain, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(tx_or_psbt, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(expected_vault, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len2 = WASM_VECTOR_LEN;
        const ptr3 = passStringToWasm0(expected_memo, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len3 = WASM_VECTOR_LEN;
        const ptr4 = passStringToWasm0(expected_amount, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len4 = WASM_VECTOR_LEN;
        const ptr5 = passStringToWasm0(change_addr, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len5 = WASM_VECTOR_LEN;
        const ptr6 = passStringToWasm0(taker_addrs, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len6 = WASM_VECTOR_LEN;
        const ptr7 = passStringToWasm0(max_fee, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len7 = WASM_VECTOR_LEN;
        const ret = wasm.verifyThorSend(ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, ptr4, len4, ptr5, len5, ptr6, len6, ptr7, len7);
        deferred9_0 = ret[0];
        deferred9_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred9_0, deferred9_1, 1);
    }
};

/**
 * JSON {prefix, account} (account id hex) for an SS58 address; throws bad_base58/bad_prefix/bad_length/bad_checksum.
 * @param {string} addr
 * @returns {string}
 */
module.exports.ss58Decode = function(addr) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(addr, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.ss58Decode(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
};

/**
 * Solidity abi.encodePacked. Request JSON {types:"(t1,t2,..)", args:[..]}; returns {data, keccak256}.
 * @param {string} request_json
 * @returns {string}
 */
module.exports.evmAbiEncodePacked = function(request_json) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(request_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.evmAbiEncodePacked(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
};

/**
 * As `msg-verify` with options, for the chains whose verify needs them. Input JSON:
 * {"address", "message" | "message_hex", "signature", "format"? ("raw" | "offchain-v0", Solana, required there),
 * "pubkey"? (base64 33-byte compressed key, Cosmos ADR-036, required there), "chain"? ("eth"|"btc"|"tron"|"sol"|"cosmos",
 * required when the address is both valid Cosmos bech32 and a valid Solana key, else `ambiguous_address`)}. Unknown keys and options that do
 * not apply to the detected chain are refused. Returns the same JSON as `msgVerify`
 * ({"status":"ok"|"signer_mismatch","chain","address","recovered"?,"v"?,"format"?,"hrp"?}). No keys.
 * @param {string} input
 * @returns {string}
 */
module.exports.msgVerifyOpts = function(input) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(input, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.msgVerifyOpts(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
};

/**
 * Encode a CashAddr. `kind` "p2pkh" | "p2sh"; `hash_hex` 20 (or 24..64 spec sizes) bytes.
 * @param {string} prefix
 * @param {string} kind
 * @param {string} hash_hex
 * @returns {string}
 */
module.exports.cashAddrEncode = function(prefix, kind, hash_hex) {
    let deferred5_0;
    let deferred5_1;
    try {
        const ptr0 = passStringToWasm0(prefix, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(kind, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(hash_hex, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len2 = WASM_VECTOR_LEN;
        const ret = wasm.cashAddrEncode(ptr0, len0, ptr1, len1, ptr2, len2);
        var ptr4 = ret[0];
        var len4 = ret[1];
        if (ret[3]) {
            ptr4 = 0; len4 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred5_0 = ptr4;
        deferred5_1 = len4;
        return getStringFromWasm0(ptr4, len4);
    } finally {
        wasm.__wbindgen_free(deferred5_0, deferred5_1, 1);
    }
};

/**
 * `derive --explain` for the given derive flags: JSON [{chain,kind,template,path,count}]. No keys.
 * @param {string[]} args
 * @returns {string}
 */
module.exports.explainPlan = function(args) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passArrayJsValueToWasm0(args, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.explainPlan(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
};

/**
 * Standard output script -> {kind, address}, or null for non-standard scripts.
 * @param {string} chain
 * @param {string} script_hex
 * @returns {string}
 */
module.exports.scriptToAddress = function(chain, script_hex) {
    let deferred4_0;
    let deferred4_1;
    try {
        const ptr0 = passStringToWasm0(chain, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(script_hex, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.scriptToAddress(ptr0, len0, ptr1, len1);
        var ptr3 = ret[0];
        var len3 = ret[1];
        if (ret[3]) {
            ptr3 = 0; len3 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred4_0 = ptr3;
        deferred4_1 = len3;
        return getStringFromWasm0(ptr3, len3);
    } finally {
        wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
    }
};

/**
 * m-of-n P2WSH from compressed pubkeys, as `multisig M --pubkey ..`. `network`: bitcoin|testnet|signet|regtest
 * ("" = bitcoin). Returns {chain:"btc", witness_script, address, descriptor}. Pubkey ORDER is consensus-significant.
 * @param {number} threshold
 * @param {string[]} pubkeys
 * @param {string} network
 * @returns {string}
 */
module.exports.multisigAddress = function(threshold, pubkeys, network) {
    let deferred4_0;
    let deferred4_1;
    try {
        const ptr0 = passArrayJsValueToWasm0(pubkeys, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(network, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.multisigAddress(threshold, ptr0, len0, ptr1, len1);
        var ptr3 = ret[0];
        var len3 = ret[1];
        if (ret[3]) {
            ptr3 = 0; len3 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred4_0 = ptr3;
        deferred4_1 = len3;
        return getStringFromWasm0(ptr3, len3);
    } finally {
        wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
    }
};

/**
 * Substrate twox_128 of UTF-8 `text`. Returns hex.
 * @param {string} text
 * @returns {string}
 */
module.exports.twox128 = function(text) {
    let deferred2_0;
    let deferred2_1;
    try {
        const ptr0 = passStringToWasm0(text, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.twox128(ptr0, len0);
        deferred2_0 = ret[0];
        deferred2_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
    }
};

/**
 * Merge cosigners' partial-signature PSBTs (base64 or hex, as tx-combine reads them) and finalize at threshold.
 * Returns {signed_tx: hex, psbt: base64}. Throws not_enough_signatures / psbts_do_not_combine / not_a_psbt / no_psbts.
 * @param {string[]} psbts
 * @returns {string}
 */
module.exports.combinePsbts = function(psbts) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passArrayJsValueToWasm0(psbts, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.combinePsbts(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
};

/**
 * Decode a wire transaction (hex or base64; legacy or v0). JSON: see EXPORTS.md.
 * @param {string} raw
 * @returns {string}
 */
module.exports.solDecodeTx = function(raw) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(raw, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.solDecodeTx(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
};

/**
 * BLAKE2b of hex `data_hex` with `out_len` bytes (1..64) and a UTF-8 personalization (<= 16 bytes, "" for none). Returns hex.
 * @param {string} data_hex
 * @param {number} out_len
 * @param {string} personal
 * @returns {string}
 */
module.exports.blake2b = function(data_hex, out_len, personal) {
    let deferred4_0;
    let deferred4_1;
    try {
        const ptr0 = passStringToWasm0(data_hex, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(personal, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.blake2b(ptr0, len0, out_len, ptr1, len1);
        var ptr3 = ret[0];
        var len3 = ret[1];
        if (ret[3]) {
            ptr3 = 0; len3 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred4_0 = ptr3;
        deferred4_1 = len3;
        return getStringFromWasm0(ptr3, len3);
    } finally {
        wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
    }
};

/**
 * SCALE AccountInfo (80 bytes hex, as returned by state_getStorage) -> JSON {nonce,consumers,providers,sufficients,data:{free,reserved,frozen,flags}}; u128 as decimal strings.
 * @param {string} hex
 * @returns {string}
 */
module.exports.decodeAccountInfo = function(hex) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(hex, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.decodeAccountInfo(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
};

/**
 * Reverse lookup of a selector/topic among caller-supplied signatures (ABI JSON or one per line).
 * @param {string} hash_hex
 * @param {string} sigs_text
 * @returns {string}
 */
module.exports.evmSigLookup = function(hash_hex, sigs_text) {
    let deferred4_0;
    let deferred4_1;
    try {
        const ptr0 = passStringToWasm0(hash_hex, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(sigs_text, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.evmSigLookup(ptr0, len0, ptr1, len1);
        var ptr3 = ret[0];
        var len3 = ret[1];
        if (ret[3]) {
            ptr3 = 0; len3 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred4_0 = ptr3;
        deferred4_1 = len3;
        return getStringFromWasm0(ptr3, len3);
    } finally {
        wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
    }
};

/**
 * CREATE / CREATE2 contract address. Request JSON {deployer, nonce} or {deployer, salt, init_code_hash | init_code}; a tx (from, nonce) also works.
 * @param {string} request_json
 * @returns {string}
 */
module.exports.evmCreateAddress = function(request_json) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(request_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.evmCreateAddress(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
};

/**
 * ABI-encode calldata or a bare type list. Request JSON {sig, args:[..]}.
 * @param {string} request_json
 * @returns {string}
 */
module.exports.evmAbiEncode = function(request_json) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(request_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.evmAbiEncode(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
};

/**
 * Build an unsigned Solana legacy transfer (one zeroed signature + message; byte-identical to
 * @solana/kit). `plan` JSON: {from, to, blockhash, priority?:[micro_lamports_str, cu_limit]} plus one of
 * lamports:"N" | sweep_balance:"N" | token:{mint, amount:"N", decimals, token_program, create_ata}.
 * Returns hex. Takes no keys; sign elsewhere.
 * @param {string} plan
 * @returns {string}
 */
module.exports.solBuildTransfer = function(plan) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(plan, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.solBuildTransfer(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
};

/**
 * SS58 address from a 32-byte account id (hex) and prefix (0 Polkadot, 2 Kusama, 42 generic; up to 16383).
 * @param {string} account_hex
 * @param {number} prefix
 * @returns {string}
 */
module.exports.ss58Encode = function(account_hex, prefix) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(account_hex, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.ss58Encode(ptr0, len0, prefix);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
};

let cachedUint32ArrayMemory0 = null;

function getUint32ArrayMemory0() {
    if (cachedUint32ArrayMemory0 === null || cachedUint32ArrayMemory0.byteLength === 0) {
        cachedUint32ArrayMemory0 = new Uint32Array(wasm.memory.buffer);
    }
    return cachedUint32ArrayMemory0;
}

function passArray32ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 4, 4) >>> 0;
    getUint32ArrayMemory0().set(arg, ptr / 4);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}
/**
 * Watch-only addresses from an account-level xpub: JSON [{chain,kind,path,address}].
 * @param {string} xpub_str
 * @param {string} chain
 * @param {string[]} kinds
 * @param {Uint32Array} branches
 * @param {Uint32Array} indices
 * @returns {string}
 */
module.exports.addressesFromXpub = function(xpub_str, chain, kinds, branches, indices) {
    let deferred7_0;
    let deferred7_1;
    try {
        const ptr0 = passStringToWasm0(xpub_str, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(chain, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passArrayJsValueToWasm0(kinds, wasm.__wbindgen_malloc);
        const len2 = WASM_VECTOR_LEN;
        const ptr3 = passArray32ToWasm0(branches, wasm.__wbindgen_malloc);
        const len3 = WASM_VECTOR_LEN;
        const ptr4 = passArray32ToWasm0(indices, wasm.__wbindgen_malloc);
        const len4 = WASM_VECTOR_LEN;
        const ret = wasm.addressesFromXpub(ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, ptr4, len4);
        var ptr6 = ret[0];
        var len6 = ret[1];
        if (ret[3]) {
            ptr6 = 0; len6 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred7_0 = ptr6;
        deferred7_1 = len6;
        return getStringFromWasm0(ptr6, len6);
    } finally {
        wasm.__wbindgen_free(deferred7_0, deferred7_1, 1);
    }
};

/**
 * Library version (semver string, same as the `blocktools` crate).
 * @returns {string}
 */
module.exports.version = function() {
    let deferred1_0;
    let deferred1_1;
    try {
        const ret = wasm.version();
        deferred1_0 = ret[0];
        deferred1_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
    }
};

/**
 * keccak256 of hex bytes -> "0x" + 64 hex.
 * @param {string} data_hex
 * @returns {string}
 */
module.exports.evmKeccak256 = function(data_hex) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(data_hex, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.evmKeccak256(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
};

/**
 * `address::validate(chain, addr)`: address kind string; throws on invalid / unverified chain.
 * @param {string} chain
 * @param {string} addr
 * @returns {string}
 */
module.exports.addressValidate = function(chain, addr) {
    let deferred4_0;
    let deferred4_1;
    try {
        const ptr0 = passStringToWasm0(chain, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(addr, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.addressValidate(ptr0, len0, ptr1, len1);
        var ptr3 = ret[0];
        var len3 = ret[1];
        if (ret[3]) {
            ptr3 = 0; len3 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred4_0 = ptr3;
        deferred4_1 = len3;
        return getStringFromWasm0(ptr3, len3);
    } finally {
        wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
    }
};

/**
 * Re-encode a BOLT11 invoice byte-identically, as `bolt11 --reencode`: parse the 5-bit words, drop the
 * checksum, re-emit with a fresh one. Returns {reencoded, roundtrip} (roundtrip true when it equals the
 * lowercased input). Public input, no keys.
 * @param {string} invoice
 * @returns {string}
 */
module.exports.bolt11Reencode = function(invoice) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(invoice, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.bolt11Reencode(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
};

/**
 * Every verified chain (and `zec`) on which `addr` is valid: JSON [{chain,kind}]. Collisions
 * (DGB/DOGE, VIA/VTC, version 50/0 ...) return all candidates; an empty list = unrecognised.
 * @param {string} addr
 * @returns {string}
 */
module.exports.detectAddress = function(addr) {
    let deferred2_0;
    let deferred2_1;
    try {
        const ptr0 = passStringToWasm0(addr, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.detectAddress(ptr0, len0);
        deferred2_0 = ret[0];
        deferred2_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
    }
};

/**
 * Decode a bech32 (segwit v0, `bc1q...`) / bech32m (v1 taproot, `bc1p...`) address into its witness
 * program. Keyless and pure. Returns {version, program_hex, words_hex}: `version` the witness version
 * int, `program_hex` the hex of the decoded witness program bytes (bech32 `fromWords` of the data
 * words after the version), `words_hex` the hex of the raw 5-bit data words themselves (one byte per
 * 5-bit word, each 0..=31).
 * @param {string} address
 * @returns {string}
 */
module.exports.bech32WitnessProgram = function(address) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(address, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.bech32WitnessProgram(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
};

/**
 * Known but unverified chains (NOT supported by the other calls): same shape, verified:false.
 * @returns {string}
 */
module.exports.unverifiedChains = function() {
    let deferred1_0;
    let deferred1_1;
    try {
        const ret = wasm.unverifiedChains();
        deferred1_0 = ret[0];
        deferred1_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
    }
};

/**
 * `derive::from_xpub(chain, xpub, path, index)`: JSON [{chain,kind,path,address}] for every script kind.
 * @param {string} chain
 * @param {string} xpub_str
 * @param {string} path
 * @param {number} index
 * @returns {string}
 */
module.exports.deriveFromXpub = function(chain, xpub_str, path, index) {
    let deferred5_0;
    let deferred5_1;
    try {
        const ptr0 = passStringToWasm0(chain, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(xpub_str, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(path, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len2 = WASM_VECTOR_LEN;
        const ret = wasm.deriveFromXpub(ptr0, len0, ptr1, len1, ptr2, len2, index);
        var ptr4 = ret[0];
        var len4 = ret[1];
        if (ret[3]) {
            ptr4 = 0; len4 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred5_0 = ptr4;
        deferred5_1 = len4;
        return getStringFromWasm0(ptr4, len4);
    } finally {
        wasm.__wbindgen_free(deferred5_0, deferred5_1, 1);
    }
};

/**
 * Address kind ("P2pkh", "SegwitV0", "Eth", ...) if `address` is valid for `chain`; throws otherwise.
 * @param {string} chain
 * @param {string} address
 * @returns {string}
 */
module.exports.validateAddress = function(chain, address) {
    let deferred4_0;
    let deferred4_1;
    try {
        const ptr0 = passStringToWasm0(chain, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(address, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.validateAddress(ptr0, len0, ptr1, len1);
        var ptr3 = ret[0];
        var len3 = ret[1];
        if (ret[3]) {
            ptr3 = 0; len3 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred4_0 = ptr3;
        deferred4_1 = len3;
        return getStringFromWasm0(ptr3, len3);
    } finally {
        wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
    }
};

/**
 * EIP-712 typed data: encodeType, domain separator, message hash, digest; with a signature (65-byte or EIP-2098 64-byte) the recovered signer; with an expected signer a verdict.
 * `options_json` (optional) `{expect_chain_id?: "decimal", expect_verifying_contract?: "0x.."}`: the
 * typed-data-verify --expect-chain-id / --expect-verifying-contract checks (status chain_id_mismatch /
 * verifying_contract_mismatch). Wrong types throw `<key>_must_be_string`.
 * @param {string} typed_data_json
 * @param {string | null} [sig_hex]
 * @param {string | null} [signer]
 * @param {string | null} [options_json]
 * @returns {string}
 */
module.exports.evmTypedDataVerify = function(typed_data_json, sig_hex, signer, options_json) {
    let deferred6_0;
    let deferred6_1;
    try {
        const ptr0 = passStringToWasm0(typed_data_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        var ptr1 = isLikeNone(sig_hex) ? 0 : passStringToWasm0(sig_hex, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        var len1 = WASM_VECTOR_LEN;
        var ptr2 = isLikeNone(signer) ? 0 : passStringToWasm0(signer, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        var len2 = WASM_VECTOR_LEN;
        var ptr3 = isLikeNone(options_json) ? 0 : passStringToWasm0(options_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        var len3 = WASM_VECTOR_LEN;
        const ret = wasm.evmTypedDataVerify(ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3);
        var ptr5 = ret[0];
        var len5 = ret[1];
        if (ret[3]) {
            ptr5 = 0; len5 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred6_0 = ptr5;
        deferred6_1 = len5;
        return getStringFromWasm0(ptr5, len5);
    } finally {
        wasm.__wbindgen_free(deferred6_0, deferred6_1, 1);
    }
};

/**
 * Inspect an ABI (JSON or signature lines): items with selectors/topics, selector collisions, ERC-165/ERC-20 interfaces.
 * @param {string} abi_text
 * @returns {string}
 */
module.exports.evmAbiInspect = function(abi_text) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(abi_text, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.evmAbiInspect(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
};

/**
 * verifySweepTx on a raw EVM tx hex; the sender is recovered from the signature (unsigned fails closed).
 * @param {string} raw_hex
 * @param {string} owner
 * @param {number} chain_id
 * @param {string} token
 * @returns {string}
 */
module.exports.verifySweepRaw = function(raw_hex, owner, chain_id, token) {
    let deferred5_0;
    let deferred5_1;
    try {
        const ptr0 = passStringToWasm0(raw_hex, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(owner, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(token, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len2 = WASM_VECTOR_LEN;
        const ret = wasm.verifySweepRaw(ptr0, len0, ptr1, len1, chain_id, ptr2, len2);
        var ptr4 = ret[0];
        var len4 = ret[1];
        if (ret[3]) {
            ptr4 = 0; len4 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred5_0 = ptr4;
        deferred5_1 = len4;
        return getStringFromWasm0(ptr4, len4);
    } finally {
        wasm.__wbindgen_free(deferred5_0, deferred5_1, 1);
    }
};

/**
 * tx-verify: JSON {ok, failures, warnings}. `max_fee` is a decimal string (sats or wei) or "" (the
 * tx-sign default: 0.01 ETH-equivalent for EVM; UTXO per chain, see policy::default_fee_cap) (untested). `allow_value_with_token` (default false) accepts ETH value
 * alongside ERC-20 transfer calldata. `expected_memo` (UTF-8, optional): the only OP_RETURN payload accepted
 * (one zero-value OP_RETURN, exact match); without it any OP_RETURN is refused (`unexpected_output`).
 * @param {string} input
 * @param {string} chain
 * @param {string[]} expect_to
 * @param {string[]} change
 * @param {number | null | undefined} chain_id
 * @param {string} max_fee
 * @param {boolean} allow_warnings
 * @param {boolean | null} [allow_value_with_token]
 * @param {string | null} [call_json]
 * @param {string | null} [expected_memo]
 * @returns {string}
 */
module.exports.verifyTx = function(input, chain, expect_to, change, chain_id, max_fee, allow_warnings, allow_value_with_token, call_json, expected_memo) {
    let deferred9_0;
    let deferred9_1;
    try {
        const ptr0 = passStringToWasm0(input, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(chain, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passArrayJsValueToWasm0(expect_to, wasm.__wbindgen_malloc);
        const len2 = WASM_VECTOR_LEN;
        const ptr3 = passArrayJsValueToWasm0(change, wasm.__wbindgen_malloc);
        const len3 = WASM_VECTOR_LEN;
        const ptr4 = passStringToWasm0(max_fee, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len4 = WASM_VECTOR_LEN;
        var ptr5 = isLikeNone(call_json) ? 0 : passStringToWasm0(call_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        var len5 = WASM_VECTOR_LEN;
        var ptr6 = isLikeNone(expected_memo) ? 0 : passStringToWasm0(expected_memo, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        var len6 = WASM_VECTOR_LEN;
        const ret = wasm.verifyTx(ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, isLikeNone(chain_id) ? 0x100000001 : (chain_id) >>> 0, ptr4, len4, allow_warnings, isLikeNone(allow_value_with_token) ? 0xFFFFFF : allow_value_with_token ? 1 : 0, ptr5, len5, ptr6, len6);
        var ptr8 = ret[0];
        var len8 = ret[1];
        if (ret[3]) {
            ptr8 = 0; len8 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred9_0 = ptr8;
        deferred9_1 = len8;
        return getStringFromWasm0(ptr8, len8);
    } finally {
        wasm.__wbindgen_free(deferred9_0, deferred9_1, 1);
    }
};

/**
 * Unsigned sweep of all `utxos` (JSON lines {txid,vout,amount,address[,prev_tx]}) to `to`:
 * JSON {chain,tx_format,psbt,unsigned_tx,inputs,amount,fee}. Legacy, legacy-sha256 and forkid
 * formats; pos-ntime chains need `buildUnsignedSweepAt` (a tx timestamp).
 * @param {string} chain
 * @param {string} utxos
 * @param {string} to
 * @param {number} fee_rate
 * @returns {string}
 */
module.exports.buildUnsignedSweep = function(chain, utxos, to, fee_rate) {
    let deferred5_0;
    let deferred5_1;
    try {
        const ptr0 = passStringToWasm0(chain, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(utxos, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(to, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len2 = WASM_VECTOR_LEN;
        const ret = wasm.buildUnsignedSweep(ptr0, len0, ptr1, len1, ptr2, len2, fee_rate);
        var ptr4 = ret[0];
        var len4 = ret[1];
        if (ret[3]) {
            ptr4 = 0; len4 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred5_0 = ptr4;
        deferred5_1 = len4;
        return getStringFromWasm0(ptr4, len4);
    } finally {
        wasm.__wbindgen_free(deferred5_0, deferred5_1, 1);
    }
};

/**
 * Legacy base58 BCH address -> CashAddr with `prefix` ("" = bitcoincash).
 * @param {string} addr
 * @param {string} prefix
 * @returns {string}
 */
module.exports.legacyToCashAddr = function(addr, prefix) {
    let deferred4_0;
    let deferred4_1;
    try {
        const ptr0 = passStringToWasm0(addr, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(prefix, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.legacyToCashAddr(ptr0, len0, ptr1, len1);
        var ptr3 = ret[0];
        var len3 = ret[1];
        if (ret[3]) {
            ptr3 = 0; len3 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred4_0 = ptr3;
        deferred4_1 = len3;
        return getStringFromWasm0(ptr3, len3);
    } finally {
        wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
    }
};

/**
 * Additive to detectAddress (whose shape is unchanged): JSON {candidates:[{chain,kind}], ambiguous, kinds_agree}.
 * `ambiguous` = more than one chain; `kinds_agree` = every candidate has the same script kind.
 * @param {string} addr
 * @returns {string}
 */
module.exports.detectAddressInfo = function(addr) {
    let deferred2_0;
    let deferred2_1;
    try {
        const ptr0 = passStringToWasm0(addr, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.detectAddressInfo(ptr0, len0);
        deferred2_0 = ret[0];
        deferred2_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
    }
};

/**
 * Tron txID (hex) = sha256(raw_data). Input is raw_data hex (tronweb raw_data_hex).
 * @param {string} raw_data_hex
 * @returns {string}
 */
module.exports.tronTxId = function(raw_data_hex) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(raw_data_hex, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.tronTxId(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
};

/**
 * true if a base58 Solana pubkey is an ed25519 curve point (wallet), false if off-curve (PDA); throws on bad input.
 * @param {string} addr
 * @returns {boolean}
 */
module.exports.solIsOnCurve = function(addr) {
    const ptr0 = passStringToWasm0(addr, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.solIsOnCurve(ptr0, len0);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return ret[0] !== 0;
};

/**
 * The verifier's allowlists: standard sigs/owner slots, pinned contracts, MultiSend, deadline cap.
 * @returns {string}
 */
module.exports.recoveryTables = function() {
    let deferred1_0;
    let deferred1_1;
    try {
        const ret = wasm.recoveryTables();
        deferred1_0 = ret[0];
        deferred1_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
    }
};

/**
 * As convertAddress with the source chain stated.
 * @param {string} from
 * @param {string} addr
 * @param {string} to
 * @returns {string}
 */
module.exports.convertAddressFrom = function(from, addr, to) {
    let deferred5_0;
    let deferred5_1;
    try {
        const ptr0 = passStringToWasm0(from, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(addr, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(to, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len2 = WASM_VECTOR_LEN;
        const ret = wasm.convertAddressFrom(ptr0, len0, ptr1, len1, ptr2, len2);
        var ptr4 = ret[0];
        var len4 = ret[1];
        if (ret[3]) {
            ptr4 = 0; len4 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred5_0 = ptr4;
        deferred5_1 = len4;
        return getStringFromWasm0(ptr4, len4);
    } finally {
        wasm.__wbindgen_free(deferred5_0, deferred5_1, 1);
    }
};

module.exports.__wbindgen_error_new = function(arg0, arg1) {
    const ret = new Error(getStringFromWasm0(arg0, arg1));
    return ret;
};

module.exports.__wbindgen_init_externref_table = function() {
    const table = wasm.__wbindgen_export_0;
    const offset = table.grow(4);
    table.set(0, undefined);
    table.set(offset + 0, undefined);
    table.set(offset + 1, null);
    table.set(offset + 2, true);
    table.set(offset + 3, false);
    ;
};

module.exports.__wbindgen_string_get = function(arg0, arg1) {
    const obj = arg1;
    const ret = typeof(obj) === 'string' ? obj : undefined;
    var ptr1 = isLikeNone(ret) ? 0 : passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    var len1 = WASM_VECTOR_LEN;
    getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
    getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
};

module.exports.__wbindgen_throw = function(arg0, arg1) {
    throw new Error(getStringFromWasm0(arg0, arg1));
};

const path = require('path').join(__dirname, 'blocktools_wasm_bg.wasm');
const bytes = require('fs').readFileSync(path);

const wasmModule = new WebAssembly.Module(bytes);
const wasmInstance = new WebAssembly.Instance(wasmModule, imports);
wasm = wasmInstance.exports;
module.exports.__wasm = wasm;

wasm.__wbindgen_start();

