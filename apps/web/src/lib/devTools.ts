/**
 * Developer & chain tools (/tools/<slug>): pure functions on PUBLIC input, computed by the
 * blocktools wasm behind POST /tools/:fn. Never keys, seeds, signing or recovery.
 * SEO copy (titles, meta, H1) follows audits/tools-directory-plan.md §4.
 */
// counts derived from the chain table (blocktools chainTable() + zec, as listChains() does); see @swapchan/shared chains.ts
import { CHAIN_COUNT, UTXO_CHAIN_COUNT } from "@swapchan/shared";

export { CHAIN_COUNT, UTXO_CHAIN_COUNT };
export const POWERED_BY = "Powered by blocktools";
/** Public repo (made public 2026-10-26). The footer links here. */
export const BLOCKTOOLS_URL = "https://github.com/TSavo/blocktools";

export type Field = {
  name: string;
  label: string;
  /** block: multi-line text sent as one string (JSON, ABI, bytecode); lines: whitespace-split list */
  kind?: "text" | "number" | "lines" | "select" | "block";
  max?: number;
  options?: string[];
  placeholder?: string;
  optional?: boolean;
};
export type Mode = { id: string; label: string; fn: string; op?: string; fields: Field[] };
export type Example = { label: string; mode: string; values: Record<string, string> };
export type DevTool = {
  slug: string;
  name: string;
  emoji: string;
  mcp: string;
  title: string;
  description: string;
  h1: string;
  intro: string;
  body: string[];
  keywords: string[];
  faq: { q: string; a: string }[];
  modes: Mode[];
  examples: Example[];
  warning?: string;
  related: string[];
};

const chain = (optional = false): Field => ({
  name: "chain",
  label: "Chain (ticker, e.g. btc, ltc, doge)",
  placeholder: "btc",
  optional,
});
const address: Field = { name: "address", label: "Address", placeholder: "Paste an address" };
const SAFE_A =
  "Yes. It only reads public data you paste. Nothing is stored or logged, and you never need a private key or seed phrase here.";

export const DEV_TOOLS: DevTool[] = [
  {
    slug: "validate-address",
    name: "Address validator & chain detector",
    emoji: "✅",
    mcp: "address_tool",
    title: `Crypto Address Validator & Chain Detector, ${CHAIN_COUNT} chains | SwapChan`,
    description: "Check an address is valid and which chains it belongs to.",
    h1: "Validate any crypto address",
    intro: `Paste an address to see which of ${CHAIN_COUNT} chains and formats it fits, or check it against one chain. Address checking only: a match does not mean SwapChan can sign or recover on that chain.`,
    body: [
      "Many coins share address formats. A Bitcoin legacy address starting with 1 is byte-for-byte the same shape as addresses on several forks, and some prefixes overlap between chains. Detect mode lists every chain and address kind (P2PKH, P2SH, SegWit, Taproot and so on) that the string decodes as, so you can see when an address is ambiguous instead of guessing.",
      "Validate mode checks the address against one chain you pick and tells you the kind, or why it fails: wrong checksum, wrong version byte, wrong bech32 prefix. Use it before you send funds or paste an address into a sweep.",
    ],
    keywords: ["validate crypto address", "which blockchain is this address"],
    faq: [
      {
        q: "What does the address validator check?",
        a: "The checksum, the version byte or bech32 prefix, and the payload length for the chain you pick. Detect mode tries every supported chain.",
      },
      { q: "Is it safe to paste my address?", a: SAFE_A },
      {
        q: "Why does one address match several chains?",
        a: "Forks often reuse Bitcoin's version bytes, so the same string is a valid address on more than one chain. The detector shows all of them; the right one is the chain your wallet uses.",
      },
      {
        q: "Which formats are supported?",
        a: `Base58Check (P2PKH, P2SH), bech32 and bech32m (SegWit v0 and Taproot) and CashAddr on the ${UTXO_CHAIN_COUNT} Bitcoin-family chains, plus the native formats of the other ${CHAIN_COUNT - UTXO_CHAIN_COUNT} (Ethereum, Solana, Polkadot SS58 and others): ${CHAIN_COUNT} chains in all.`,
      },
    ],
    modes: [
      { id: "detect", label: "Detect chain", fn: "detect-address", fields: [address] },
      {
        id: "validate",
        label: "Validate for a chain",
        fn: "validate-address",
        fields: [address, chain()],
      },
    ],
    examples: [
      {
        label: "Bitcoin genesis address",
        mode: "detect",
        values: { address: "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa" },
      },
      {
        label: "Validate on Bitcoin",
        mode: "validate",
        values: { address: "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa", chain: "btc" },
      },
    ],
    related: ["convert-address", "cashaddr", "chain-params"],
  },
  {
    slug: "convert-address",
    name: "Address converter",
    emoji: "🔁",
    mcp: "address_tool",
    title: "Convert Addresses Between Bitcoin-Family Chains | SwapChan",
    description: "Re-encode the same key hash for another chain.",
    h1: "Address converter",
    intro:
      "Re-encode the same key hash as an address on another Bitcoin-family chain, for example Litecoin 3… to M… or Bitcoin to Dogecoin.",
    body: [
      "Bitcoin-family addresses are a key or script hash wrapped in a chain-specific version byte or bech32 prefix. Converting keeps the hash and swaps the wrapper, so the result is controlled by the same key on the other chain.",
      "This is useful when Litecoin moved P2SH addresses from 3… to M…, when you need to see where a forked coin landed for a Bitcoin address, or when a tool only accepts one format. Converting an address does not move any coins.",
    ],
    keywords: ["convert litecoin address 3 to M", "dogecoin address converter"],
    faq: [
      {
        q: "Does converting an address move my coins?",
        a: "No. It only re-encodes the same hash. Coins stay where they are.",
      },
      { q: "Is it safe?", a: SAFE_A },
      {
        q: "Why convert a Litecoin 3 address to M?",
        a: "Litecoin introduced the M prefix for P2SH so it would not be confused with Bitcoin's 3 addresses. Both encode the same script hash.",
      },
      {
        q: "Which chains can I convert between?",
        a: `Any of the ${CHAIN_COUNT} chains in the chain parameters table that support the address kind.`,
      },
    ],
    modes: [
      {
        id: "convert",
        label: "Convert",
        fn: "convert-address",
        fields: [
          address,
          { name: "to", label: "To chain", placeholder: "ltc" },
          { name: "from", label: "From chain (if ambiguous)", placeholder: "btc", optional: true },
        ],
      },
    ],
    examples: [
      {
        label: "Bitcoin → Litecoin",
        mode: "convert",
        values: { address: "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa", to: "ltc" },
      },
      {
        label: "Bitcoin → Dogecoin",
        mode: "convert",
        values: { address: "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa", to: "doge" },
      },
    ],
    related: ["validate-address", "cashaddr", "chain-params"],
  },
  {
    slug: "cashaddr",
    name: "Bitcoin Cash address converter",
    emoji: "🟩",
    mcp: "address_tool",
    title: "CashAddr to Legacy Converter (Bitcoin Cash) | SwapChan",
    description: "Convert BCH addresses between CashAddr and legacy formats instantly.",
    h1: "Bitcoin Cash address converter",
    intro:
      "Convert Bitcoin Cash addresses between CashAddr (bitcoincash:q…) and legacy (1…/3…) formats, or decode a CashAddr.",
    body: [
      "Bitcoin Cash adopted the CashAddr format so BCH addresses could not be confused with Bitcoin ones. Old wallets, exchanges and paper wallets still show the legacy format. Both encode the same hash, so converting between them is safe and lossless.",
      "Decode mode shows the prefix, the type (P2PKH or P2SH) and the hash inside a CashAddr.",
    ],
    keywords: ["convert cashaddr to legacy", "bitcoin cash address converter"],
    faq: [
      {
        q: "Are CashAddr and legacy addresses the same wallet?",
        a: "Yes. They encode the same key or script hash; only the text format differs.",
      },
      { q: "Is it safe?", a: SAFE_A },
      {
        q: "Do I need the bitcoincash: prefix?",
        a: "No. The converter accepts CashAddr with or without the prefix and adds it in the output.",
      },
    ],
    modes: [
      {
        id: "to_legacy",
        label: "CashAddr → legacy",
        fn: "cashaddr",
        op: "to_legacy",
        fields: [address],
      },
      {
        id: "to_cashaddr",
        label: "Legacy → CashAddr",
        fn: "cashaddr",
        op: "to_cashaddr",
        fields: [address],
      },
      { id: "decode", label: "Decode CashAddr", fn: "cashaddr", op: "decode", fields: [address] },
      {
        id: "encode",
        label: "Hash → CashAddr",
        fn: "cashaddr",
        op: "encode",
        fields: [
          { name: "kind", label: "Type", kind: "select", options: ["p2pkh", "p2sh"] },
          { name: "hash", label: "Hash (hex, 20 bytes)", placeholder: "76a04053…" },
          { name: "prefix", label: "Prefix", placeholder: "bitcoincash", optional: true },
        ],
      },
    ],
    examples: [
      {
        label: "BCH genesis address → CashAddr",
        mode: "to_cashaddr",
        values: { address: "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa" },
      },
      {
        label: "CashAddr → legacy",
        mode: "to_legacy",
        values: { address: "bitcoincash:qp3wjpa3tjlj042z2wv7hahsldgwhwy0rq9sywjpyy" },
      },
    ],
    related: ["validate-address", "convert-address", "xpub-addresses"],
  },
  {
    slug: "xpub-addresses",
    name: "Xpub to addresses",
    emoji: "🌳",
    mcp: "xpub_addresses",
    title: "Xpub to Addresses: Derive Receive Addresses | SwapChan",
    description: "Public xpub only, never paste an xprv.",
    h1: "Derive addresses from an xpub",
    intro:
      "List the receive or change addresses behind an extended public key (xpub, ypub, zpub). Public keys only: private keys and seed phrases are refused.",
    warning:
      "Never paste an xprv or a seed phrase anywhere online. An xpub cannot spend, but it does reveal every address in the wallet, so treat it as private.",
    body: [
      "An extended public key derives a whole tree of addresses. Branch 0 holds receive addresses and branch 1 holds change. This tool derives up to 20 at a time for legacy (P2PKH), nested SegWit (P2SH-P2WPKH), native SegWit (P2WPKH) or Taproot (P2TR).",
      "Use it to find which addresses a hardware or watch-only wallet controls, to check a balance by address, or to confirm an xpub belongs to the wallet you think it does.",
    ],
    keywords: ["xpub to address", "derive addresses from xpub"],
    faq: [
      {
        q: "Is it safe to paste an xpub?",
        a: "An xpub cannot spend funds, but it reveals all of the wallet's addresses and history. Nothing is stored or logged here. Private keys (xprv, yprv, zprv, tprv) and seed phrases are rejected.",
      },
      {
        q: "Which address types are supported?",
        a: "P2PKH (1…), P2SH-P2WPKH (3…), P2WPKH (bc1q…) and P2TR (bc1p…), on Bitcoin-family chains.",
      },
      {
        q: "What are branch 0 and branch 1?",
        a: "Branch 0 is the external chain of receive addresses; branch 1 is internal change addresses.",
      },
      {
        q: "Why don't the addresses match my wallet?",
        a: "Check the address type. A zpub normally means native SegWit and a ypub nested SegWit; some wallets also use a different account path.",
      },
    ],
    modes: [
      {
        id: "derive",
        label: "Derive",
        fn: "xpub-addresses",
        fields: [
          { name: "xpub", label: "Extended public key (xpub / ypub / zpub)", placeholder: "xpub…" },
          chain(),
          {
            name: "kind",
            label: "Address type",
            kind: "select",
            options: ["p2pkh", "p2wpkh", "p2sh-p2wpkh", "p2tr"],
          },
          {
            name: "branch",
            label: "Branch (0 receive, 1 change)",
            kind: "select",
            options: ["0", "1"],
          },
          { name: "start", label: "Start index", kind: "number", placeholder: "0", optional: true },
          {
            name: "count",
            label: "How many (max 20)",
            kind: "number",
            placeholder: "10",
            optional: true,
          },
        ],
      },
    ],
    examples: [
      {
        label: "BIP32 test vector 1",
        mode: "derive",
        values: {
          xpub: "xpub661MyMwAqRbcFtXgS5sYJABqqG9YLmC4Q1Rdap9gSE8NqtwybGhePY2gZ29ESFjqJoCu1Rupje8YtGqsefD265TMg7usUDFdp6W1EGMcet8",
          chain: "btc",
          kind: "p2pkh",
          branch: "0",
          count: "5",
        },
      },
    ],
    related: ["validate-address", "convert-address", "chain-params"],
  },
  {
    slug: "ss58",
    name: "SS58 address converter",
    emoji: "🔴",
    mcp: "substrate_tool",
    title: "SS58 Address Converter (Polkadot/Kusama) | SwapChan",
    description: "Decode or re-encode Substrate addresses for any network prefix.",
    h1: "SS58 address converter",
    intro:
      "Decode a Polkadot, Kusama or other Substrate address to its public key and network prefix, or re-encode it for another network.",
    body: [
      "Substrate chains share one account key format and show it with a network-specific SS58 prefix: 0 for Polkadot, 2 for Kusama, 42 for generic Substrate and test networks. The same account looks different on each chain.",
      "Convert mode re-encodes an address for another prefix, so you can match a Polkadot address to its Kusama or parachain form. Encode mode builds an address from a 32-byte public key.",
    ],
    keywords: ["ss58 address converter", "polkadot address converter"],
    faq: [
      {
        q: "Is a Polkadot address the same account on Kusama?",
        a: "The public key is the same; only the SS58 prefix (and so the text) changes. Whether funds exist there depends on the chain.",
      },
      { q: "Is it safe?", a: SAFE_A },
      {
        q: "Which prefix do I need?",
        a: "0 is Polkadot, 2 is Kusama, 42 is generic Substrate. Parachains publish their own prefixes.",
      },
    ],
    modes: [
      {
        id: "convert",
        label: "Convert prefix",
        fn: "ss58",
        op: "convert",
        fields: [
          address,
          {
            name: "prefix",
            label: "Target prefix (0 Polkadot, 2 Kusama, 42 Substrate)",
            kind: "number",
            placeholder: "0",
          },
        ],
      },
      { id: "decode", label: "Decode", fn: "ss58", op: "decode", fields: [address] },
      {
        id: "encode",
        label: "Encode public key",
        fn: "ss58",
        op: "encode",
        fields: [
          { name: "account", label: "Public key (32-byte hex)", placeholder: "0x…" },
          { name: "prefix", label: "Prefix", kind: "number", placeholder: "0" },
        ],
      },
    ],
    examples: [
      {
        label: "Alice (dev) → Polkadot",
        mode: "convert",
        values: { address: "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY", prefix: "0" },
      },
      {
        label: "Decode Alice",
        mode: "decode",
        values: { address: "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY" },
      },
    ],
    related: ["validate-address", "solana-pda", "chain-params"],
  },
  {
    slug: "solana-pda",
    name: "Solana PDA & ATA calculator",
    emoji: "🟣",
    mcp: "solana_address",
    title: "Solana PDA & ATA Calculator | SwapChan",
    description: "Compute program-derived and associated token addresses.",
    h1: "Solana PDA calculator",
    intro:
      "Compute a program-derived address (PDA) and bump from seeds, find the associated token account (ATA) for a wallet and mint, or check whether an address is on the ed25519 curve.",
    body: [
      "Solana programs own accounts at program-derived addresses: a hash of seeds and the program id pushed off the ed25519 curve, so no private key exists for them. The bump is the first value that lands off-curve.",
      "An associated token account is a PDA of the Associated Token program over the owner, the token program and the mint. Use this to find where a wallet's tokens live, to debug a program, or to check a PDA your code expects.",
    ],
    keywords: ["solana pda calculator", "find associated token account"],
    faq: [
      {
        q: "What format do seeds use?",
        a: 'One seed per line, as hex bytes (for example 6d65746164617461 for the text "metadata"). Up to 16 seeds of 32 bytes each, as on-chain.',
      },
      { q: "Is it safe?", a: SAFE_A },
      {
        q: "What does on-curve mean?",
        a: "An on-curve address is a normal ed25519 public key that has a private key. PDAs are off-curve by design.",
      },
      {
        q: "Which token program does the ATA use?",
        a: "The classic SPL Token program by default. Pass the Token-2022 program id for Token-2022 mints.",
      },
    ],
    modes: [
      {
        id: "pda",
        label: "PDA from seeds",
        fn: "solana-pda",
        fields: [
          { name: "program", label: "Program id" },
          { name: "seeds", label: "Seeds (hex, one per line)", kind: "lines" },
        ],
      },
      {
        id: "ata",
        label: "Associated token account",
        fn: "solana-ata",
        fields: [
          { name: "owner", label: "Owner wallet" },
          { name: "mint", label: "Token mint" },
          { name: "token_program", label: "Token program (optional)", optional: true },
        ],
      },
      { id: "on_curve", label: "On-curve check", fn: "solana-on-curve", fields: [address] },
    ],
    examples: [
      {
        label: "USDC ATA",
        mode: "ata",
        values: {
          owner: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
          mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        },
      },
      {
        label: "Metadata PDA seeds",
        mode: "pda",
        values: {
          program: "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s",
          seeds: "6d65746164617461",
        },
      },
    ],
    related: ["ss58", "validate-address", "chain-params"],
  },
  {
    slug: "address-script",
    name: "Address to scriptPubKey converter",
    emoji: "📜",
    mcp: "address_tool",
    title: "Address to scriptPubKey (and back) Converter | SwapChan",
    description:
      "Turn a Bitcoin-family address into its output script hex, or a script back into an address.",
    h1: "Address ↔ scriptPubKey",
    intro: `Convert an address into the scriptPubKey hex that locks coins to it, or decode a script back to an address, on ${UTXO_CHAIN_COUNT} Bitcoin-family chains.`,
    body: [
      "Every Bitcoin-family output is locked by a script. A legacy address becomes OP_DUP OP_HASH160 <hash> OP_EQUALVERIFY OP_CHECKSIG, a SegWit address becomes a version byte plus a program. Wallets, explorers and indexers match outputs by this script, not by the address text.",
      "Use it to check what an address really pays to, to compare the same hash across forks, or to read the address behind a raw script from a decoded transaction. Uppercase bech32 and Zcash t-addresses are supported.",
    ],
    keywords: ["address to scriptpubkey", "scriptpubkey to address", "output script hex"],
    faq: [
      {
        q: "What is a scriptPubKey?",
        a: "The locking script in a transaction output. Whoever can satisfy it can spend the coins; the address is just a human-friendly encoding of it.",
      },
      {
        q: "Why do two chains give the same script?",
        a: "Forks share script formats, so the same public key hash gives the same script on Bitcoin, Litecoin, Zcash and others. Only the address encoding differs.",
      },
      { q: "Is it safe?", a: SAFE_A },
    ],
    modes: [
      {
        id: "to_script",
        label: "Address → script",
        fn: "address-script",
        op: "to_script",
        fields: [chain(), address],
      },
      {
        id: "from_script",
        label: "Script → address",
        fn: "address-script",
        op: "from_script",
        fields: [
          chain(),
          { name: "script", label: "scriptPubKey hex", placeholder: "76a914…88ac" },
        ],
      },
    ],
    examples: [
      {
        label: "Bitcoin genesis address",
        mode: "to_script",
        values: { chain: "btc", address: "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa" },
      },
      {
        label: "Uppercase bech32",
        mode: "to_script",
        values: { chain: "btc", address: "BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4" },
      },
      {
        label: "Script on Zcash",
        mode: "from_script",
        values: { chain: "zec", script: "76a91477bff20c60e522dfaa3350c39b030a5d004e839a88ac" },
      },
    ],
    related: ["validate-address", "convert-address", "chain-params"],
  },
  {
    slug: "hash-tools",
    name: "BLAKE2b, xxHash (twox128) & Base58",
    emoji: "#️⃣",
    mcp: "hash_tool",
    title: "BLAKE2b, twox128 & Base58 Online Calculator | SwapChan",
    description:
      "Hash hex data with BLAKE2b, text with xxHash twox128, or Base58-encode and decode bytes.",
    h1: "Blockchain hash tools",
    intro:
      "BLAKE2b with any output length and optional personalization, Substrate's twox128, and plain Base58 encode/decode, in one place.",
    body: [
      "BLAKE2b is used by Zcash, Polkadot, Cardano and others; the output length and personalization string change the result, so both are adjustable. twox128 is the xxHash variant Substrate uses to build storage keys from pallet and item names.",
      "Base58 is the alphabet behind Bitcoin and Solana addresses, without the checksum. Use it to turn raw bytes into a Solana-style key or to see the bytes behind one.",
    ],
    keywords: ["blake2b online", "twox128 hash", "base58 decode online"],
    faq: [
      {
        q: "What input does BLAKE2b take?",
        a: "Hex bytes (0x optional). Output length is 1 to 64 bytes; 32 is the common choice.",
      },
      {
        q: "Is Base58 here the same as Base58Check?",
        a: "No. This is plain Base58 with no version byte or checksum, as used for Solana keys.",
      },
      { q: "Is it safe?", a: SAFE_A },
    ],
    modes: [
      {
        id: "blake2b",
        label: "BLAKE2b",
        fn: "blake2b",
        fields: [
          { name: "data", label: "Data (hex)", placeholder: "0x68656c6c6f" },
          {
            name: "out_len",
            label: "Output bytes (1-64)",
            kind: "number",
            placeholder: "32",
            optional: true,
          },
          { name: "personal", label: "Personalization (optional)", optional: true },
        ],
      },
      {
        id: "twox128",
        label: "twox128",
        fn: "twox128",
        fields: [{ name: "text", label: "Text", placeholder: "System" }],
      },
      {
        id: "b58enc",
        label: "Base58 encode",
        fn: "base58",
        op: "encode",
        fields: [{ name: "data", label: "Data (hex)" }],
      },
      {
        id: "b58dec",
        label: "Base58 decode",
        fn: "base58",
        op: "decode",
        fields: [{ name: "data", label: "Base58 text" }],
      },
    ],
    examples: [
      {
        label: "BLAKE2b-256 of hello",
        mode: "blake2b",
        values: { data: "68656c6c6f", out_len: "32" },
      },
      { label: "twox128(System)", mode: "twox128", values: { text: "System" } },
    ],
    related: ["polkadot-storage-key", "ss58", "anchor-discriminator"],
  },
  {
    slug: "polkadot-storage-key",
    name: "Polkadot System.Account storage key",
    emoji: "🗝️",
    mcp: "substrate_tool",
    title: "Polkadot Account Storage Key Generator & AccountInfo Decoder | SwapChan",
    description:
      "Build the System.Account storage key for a Polkadot address and decode the AccountInfo it returns.",
    h1: "Polkadot storage key for an account",
    intro:
      "Get the System.Account storage key for any SS58 address, ready for state_getStorage, and decode the SCALE AccountInfo hex the node sends back.",
    body: [
      'A Substrate account\'s balance lives under twox128("System") + twox128("Account") + blake2_128_concat(account id). This page builds that key from an address, so you can query a node directly with state_getStorage.',
      "Paste the hex the node returns to decode the nonce and free, reserved and frozen balances.",
    ],
    keywords: ["polkadot storage key", "system account storage key", "decode accountinfo"],
    faq: [
      {
        q: "Which networks does it work for?",
        a: "Any Substrate chain using the standard System pallet: Polkadot, Kusama and most parachains. The key depends on the account id, not the SS58 prefix.",
      },
      {
        q: "Where do I use the key?",
        a: "In a state_getStorage RPC call to any node. The result is the SCALE-encoded AccountInfo you can decode here.",
      },
      { q: "Is it safe?", a: SAFE_A },
    ],
    modes: [
      {
        id: "key",
        label: "Storage key",
        fn: "polkadot-storage-key",
        fields: [{ name: "account", label: "SS58 address", placeholder: "1…" }],
      },
      {
        id: "decode",
        label: "Decode AccountInfo",
        fn: "decode-account-info",
        fields: [{ name: "hex", label: "AccountInfo hex" }],
      },
    ],
    examples: [
      {
        label: "Alice",
        mode: "key",
        values: { account: "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY" },
      },
    ],
    related: ["ss58", "hash-tools", "validate-address"],
  },
  {
    slug: "anchor-discriminator",
    name: "Anchor instruction discriminator",
    emoji: "⚓",
    mcp: "solana_address",
    title: "Anchor Instruction Discriminator Calculator (Solana) | SwapChan",
    description: "Compute the 8-byte Anchor discriminator for a Solana instruction name.",
    h1: "Anchor discriminator calculator",
    intro:
      'Type an Anchor instruction name to get its 8-byte discriminator: the first 8 bytes of sha256("global:<name>").',
    body: [
      "Anchor programs route instructions by an 8-byte prefix on the instruction data. Matching that prefix tells you which instruction a transaction calls, which is how explorers and decoders label Anchor calls.",
      "Use the snake_case name from the program's IDL, for example initialize or claim_rewards.",
    ],
    keywords: ["anchor discriminator", "solana instruction discriminator"],
    faq: [
      {
        q: "How is it computed?",
        a: 'sha256("global:" + name), first 8 bytes. Names are the snake_case Rust function names.',
      },
      {
        q: "Does it work for account discriminators?",
        a: "This computes instruction discriminators (global: namespace). Account discriminators use the account: namespace and the struct name.",
      },
      { q: "Is it safe?", a: SAFE_A },
    ],
    modes: [
      {
        id: "disc",
        label: "Discriminator",
        fn: "anchor-discriminator",
        fields: [{ name: "name", label: "Instruction name", placeholder: "initialize" }],
      },
    ],
    examples: [{ label: "initialize", mode: "disc", values: { name: "initialize" } }],
    related: ["solana-pda", "hash-tools"],
  },
  {
    slug: "chain-params",
    name: "Chain parameters table",
    emoji: "📋",
    mcp: "chain_params",
    title: `Crypto Chain Parameters: Address Version Bytes & Prefixes | SwapChan`,
    description: `Address version bytes, bech32 prefixes and WIF bytes for ${UTXO_CHAIN_COUNT} Bitcoin-family chains; SLIP-44 and checksum types for all ${CHAIN_COUNT}.`,
    h1: "Chain parameters table",
    intro: `Address version bytes, bech32 prefixes and WIF bytes for the ${UTXO_CHAIN_COUNT} Bitcoin-family chains, and SLIP-44 coin types and checksum types for all ${CHAIN_COUNT} chains, in one table.`,
    body: [
      "Every Bitcoin-family chain picks its own version bytes for P2PKH and P2SH addresses, its own bech32 human-readable part and its own WIF byte; other chains record their checksum and transaction format. These parameters are what the validator, converter and xpub tools on this site use.",
      "Look up one chain by ticker, or show the whole table.",
    ],
    keywords: ["address version bytes", "bech32 prefix"],
    faq: [
      {
        q: "What is a version byte?",
        a: "The first byte of a Base58Check address. It decides the leading character, for example 0 gives Bitcoin's 1… and 48 gives Litecoin's L….",
      },
      {
        q: "Where does the data come from?",
        a: "From the same parameter table the address tools use, so the page and the tools always agree.",
      },
      { q: "Is it safe?", a: "Yes. It shows public constants only." },
    ],
    modes: [{ id: "show", label: "Show", fn: "chain-params", fields: [chain(true)] }],
    examples: [
      { label: "Bitcoin", mode: "show", values: { chain: "btc" } },
      { label: "All chains", mode: "show", values: {} },
    ],
    related: ["validate-address", "convert-address", "xpub-addresses"],
  },
  {
    slug: "tron-tx",
    name: "Tron raw_data decoder & txid",
    emoji: "🔺",
    mcp: "tron_tx",
    title: "Tron Transaction Decoder & TXID Calculator (raw_data hex) | SwapChan",
    description:
      "Decode an unsigned Tron raw_data hex into readable contracts and compute its transaction ID.",
    h1: "Tron raw_data decoder and txid calculator",
    intro:
      "Paste an unsigned Tron raw_data hex (tronweb raw_data_hex) to see who sends what to whom, the expiry and fee limit, and the txid it will have.",
    body: [
      "A Tron transaction ID is the sha256 of its raw_data, so you can know the txid before anything is signed or broadcast. Decoding shows each contract (TRX transfer, TRC-20 call), the owner and recipient addresses, amounts in sun, the reference block, expiry and fee limit.",
      "Only unsigned raw_data is accepted. A transaction that already carries signatures is refused, because signed bytes should stay in your wallet until you broadcast them.",
    ],
    keywords: ["tron transaction decoder", "tron txid", "raw_data_hex decode"],
    faq: [
      {
        q: "How is the txid computed?",
        a: "It is the sha256 hash of the raw_data bytes. Signatures are not part of it, so the txid is fixed before signing.",
      },
      {
        q: "Why is my signed transaction refused?",
        a: "This page only takes unsigned raw_data. Signed transactions can be broadcast by anyone holding them, so keep them in your wallet.",
      },
      { q: "Is it safe?", a: SAFE_A },
    ],
    modes: [
      {
        id: "decode",
        label: "Decode",
        fn: "tron-tx",
        op: "decode",
        fields: [{ name: "hex", label: "raw_data hex", placeholder: "0a02…" }],
      },
      {
        id: "txid",
        label: "TXID",
        fn: "tron-tx",
        op: "txid",
        fields: [{ name: "hex", label: "raw_data hex", placeholder: "0a02…" }],
      },
    ],
    examples: [
      {
        label: "1 TRX transfer",
        mode: "decode",
        values: {
          hex: "0a02ab122208001122334455667740e0a499ffbc315a67080112630a2d747970652e676f6f676c65617069732e636f6d2f70726f746f636f6c2e5472616e73666572436f6e747261637412320a154174472e7d35395a6b5add427eecb7f4b62ad2b071121541a614f803b6fd780986a42c78ec9c7f77e6ded13c18c0843d7080d095ffbc31",
        },
      },
    ],
    related: ["validate-address", "convert-address", "chain-params"],
  },
  {
    slug: "evm-abi",
    name: "ABI encoder, decoder & inspector",
    emoji: "🧩",
    mcp: "evm_abi",
    title: "Ethereum ABI Encoder & Calldata Decoder (+ ABI Inspector) | SwapChan",
    description:
      "Encode Solidity function calls to calldata, decode calldata, return data and reverts, and inspect an ABI for selectors and interfaces.",
    h1: "Ethereum ABI encoder, calldata decoder and ABI inspector",
    intro:
      "Turn a function signature and arguments into calldata, decode calldata back into readable arguments, or paste an ABI to list its selectors and the standards it implements.",
    body: [
      "Encoding takes a signature like transfer(address,uint256) and a JSON list of arguments, and gives the 4-byte selector plus the full calldata. Decoding takes calldata (or return data with a type list such as (uint256,address)) and a signature or ABI, and shows each argument with its type.",
      "The inspector lists every function, event and error with its selector or topic, flags selector collisions, and checks the ERC-165, ERC-20, ERC-721 and ERC-1155 interfaces. The decoder is strict: non-canonical encodings are refused rather than guessed.",
    ],
    keywords: ["abi encoder", "calldata decoder", "function selector", "abi decode online"],
    faq: [
      {
        q: "What format do arguments use?",
        a: "A JSON list. Numbers can be decimal or 0x hex strings, addresses can be checksummed or one case, and arrays and tuples are nested JSON lists.",
      },
      {
        q: "Can it decode a revert?",
        a: "Yes. Paste the revert data with the error signature or ABI. Panic codes are explained.",
      },
      {
        q: "What does a selector collision mean?",
        a: "Two different functions in the ABI share the same 4-byte selector, so a call could reach the wrong one. It is rare but worth knowing about.",
      },
      { q: "Is it safe?", a: SAFE_A },
    ],
    modes: [
      {
        id: "encode",
        label: "Encode",
        fn: "evm-abi",
        op: "encode",
        fields: [
          { name: "sig", label: "Function signature", placeholder: "transfer(address,uint256)" },
          {
            name: "args",
            label: "Arguments (JSON list)",
            kind: "block",
            placeholder: '["0x…", "1000"]',
          },
        ],
      },
      {
        id: "decode",
        label: "Decode",
        fn: "evm-abi",
        op: "decode",
        fields: [
          {
            name: "input",
            label: "Calldata / return data (hex)",
            kind: "block",
            placeholder: "0xa9059cbb…",
          },
          {
            name: "sig",
            label: "Signature",
            placeholder: "transfer(address,uint256)",
            optional: true,
          },
          {
            name: "abi",
            label: "ABI (JSON or one signature per line)",
            kind: "block",
            optional: true,
          },
          {
            name: "types",
            label: "Return types",
            placeholder: "(uint256,address)",
            optional: true,
          },
        ],
      },
      {
        id: "inspect",
        label: "Inspect ABI",
        fn: "evm-abi",
        op: "inspect",
        fields: [{ name: "abi", label: "ABI (JSON or one signature per line)", kind: "block" }],
      },
    ],
    examples: [
      {
        label: "ERC-20 transfer",
        mode: "encode",
        values: {
          sig: "transfer(address,uint256)",
          args: '["0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB", "1000000000000000000"]',
        },
      },
      {
        label: "Decode transfer",
        mode: "decode",
        values: {
          input:
            "0xa9059cbb000000000000000000000000bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb0000000000000000000000000000000000000000000000000de0b6b3a7640000",
          sig: "transfer(address,uint256)",
        },
      },
      {
        label: "ERC-165",
        mode: "inspect",
        values: { abi: "function supportsInterface(bytes4) view returns (bool)" },
      },
    ],
    related: ["bytecode-inspect", "create-address", "typed-data-verify"],
  },
  {
    slug: "create-address",
    name: "CREATE / CREATE2 address calculator",
    emoji: "🏗️",
    mcp: "create_address",
    title: "CREATE & CREATE2 Contract Address Calculator | SwapChan",
    description:
      "Compute the address a contract will be deployed at, from the deployer and nonce (CREATE) or salt and init code (CREATE2).",
    h1: "Contract address calculator (CREATE and CREATE2)",
    intro:
      "Find out where a contract will land before it is deployed: from a deployer and its nonce, or from a factory, a salt and the init code or its hash.",
    body: [
      "A plain CREATE address depends only on the deployer and its nonce, so you can predict every contract an account will deploy. CREATE2 (EIP-1014) uses the factory address, a 32-byte salt and the keccak-256 of the init code instead, which is how counterfactual wallets and deterministic deployments work.",
      "Give either the init code or its hash for CREATE2. Results are EIP-55 checksummed.",
    ],
    keywords: [
      "create2 address calculator",
      "contract address from nonce",
      "predict contract address",
    ],
    faq: [
      {
        q: "Which nonce do I use?",
        a: "The deployer's transaction count at the time of the deploy. For a contract deployer, it is the contract's own nonce, which starts at 1.",
      },
      {
        q: "Do I need the full init code for CREATE2?",
        a: "No. The keccak-256 hash of the init code is enough.",
      },
      { q: "Is it safe?", a: SAFE_A },
    ],
    modes: [
      {
        id: "create",
        label: "CREATE",
        fn: "create-address",
        fields: [
          { name: "deployer", label: "Deployer address", placeholder: "0x…" },
          { name: "nonce", label: "Nonce", placeholder: "0" },
        ],
      },
      {
        id: "create2",
        label: "CREATE2",
        fn: "create-address",
        fields: [
          { name: "deployer", label: "Factory address", placeholder: "0x…" },
          { name: "salt", label: "Salt (32 bytes hex)", placeholder: "0x00…" },
          { name: "init_code_hash", label: "Init code hash", placeholder: "0x…", optional: true },
          { name: "init_code", label: "Init code (hex)", kind: "block", optional: true },
        ],
      },
    ],
    examples: [
      {
        label: "Nonce 0",
        mode: "create",
        values: { deployer: "0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826", nonce: "0" },
      },
      {
        label: "CREATE2",
        mode: "create2",
        values: {
          deployer: "0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826",
          salt: "0x1111111111111111111111111111111111111111111111111111111111111111",
          init_code: "0x6080604052348015600f57600080fd5b50",
        },
      },
    ],
    related: ["bytecode-inspect", "evm-abi", "validate-address"],
  },
  {
    slug: "bytecode-inspect",
    name: "Contract bytecode inspector",
    emoji: "🔬",
    mcp: "bytecode_inspect",
    title: "EVM Bytecode Inspector: Proxy, 7702, EOF, Solidity Metadata | SwapChan",
    description:
      "Paste contract runtime bytecode to see if it is a minimal proxy, an EIP-7702 delegation or EOF, its size limit status, Solidity metadata and likely selectors.",
    h1: "EVM bytecode inspector",
    intro:
      "Paste the runtime code of a contract (eth_getCode) to see what kind of code it is, where a proxy or delegation points, and what is inside.",
    body: [
      "It recognises EIP-1167 minimal proxies (and their implementation), EIP-7702 account delegations (and the delegate), and EOF containers. It reports the code size against the EIP-170 limit of 24,576 bytes and the code's keccak-256 hash.",
      "For ordinary contracts it reads the Solidity metadata trailer (compiler version and IPFS hash), counts notable opcodes like DELEGATECALL, CREATE2 and SELFDESTRUCT, and lists 4-byte values that look like function selectors. The selector list is a heuristic, not a guarantee.",
    ],
    keywords: ["bytecode decoder", "minimal proxy detector", "eip-7702 delegation check"],
    faq: [
      {
        q: "Where do I get the bytecode?",
        a: "From a block explorer's contract page, or eth_getCode on any RPC. Use the deployed runtime code, not the creation code.",
      },
      {
        q: "Why does it say selector candidates?",
        a: "Selectors are guessed from the code's dispatch pattern. Most are real, but compilers can produce look-alikes.",
      },
      {
        q: "What is an EIP-7702 delegation?",
        a: "Code that makes an ordinary account run another contract's code. The page shows which contract it points to.",
      },
      { q: "Is it safe?", a: SAFE_A },
    ],
    modes: [
      {
        id: "inspect",
        label: "Inspect",
        fn: "bytecode-inspect",
        fields: [
          {
            name: "code",
            label: "Runtime bytecode (hex)",
            kind: "block",
            max: 59000,
            placeholder: "0x6080…",
          },
        ],
      },
    ],
    examples: [
      {
        label: "Minimal proxy",
        mode: "inspect",
        values: {
          code: "0x363d3d373d3d3d363d73bebebebebebebebebebebebebebebebebebebebe5af43d82803e903d91602b57fd5bf3",
        },
      },
    ],
    related: ["evm-abi", "create-address", "validate-address"],
  },
  {
    slug: "typed-data-verify",
    name: "EIP-712 typed data hash & signature checker",
    emoji: "🖋️",
    mcp: "typed_data_verify",
    title: "EIP-712 Typed Data Hash & Signature Checker | SwapChan",
    description:
      "Compute the EIP-712 digest of typed data and check who signed it: domain separator, message hash and the recovered signer address.",
    h1: "EIP-712 typed data hash and signature checker",
    intro:
      "Paste typed data (the JSON a wallet shows for signTypedData), and optionally a signature and the address you expect, to see the hashes and whether that address really signed it.",
    body: [
      "The page computes the encoded type, domain separator, message hash and final digest exactly as wallets do. With a signature it recovers the signer's address; with an expected address it tells you if they match.",
      "This checks signatures that already exist. It never signs anything and never needs a private key. Both 65-byte and EIP-2098 compact signatures are accepted.",
      "Optionally give the chain id and contract you expect. If the domain names a different chain the status is chain_id_mismatch; a different verifyingContract gives verifying_contract_mismatch.",
      "For a signed permit (EIP-2612, DAI, Permit2) the page shows who is being approved and for how much. Give the spender you expect and any other address gives spender_not_expected, even when the amount is below the usual unlimited threshold.",
      "For a Seaport 1.5 or 1.6 order (OrderComponents or BulkOrder) the page shows what the signer receives. An order that returns nothing to the signer gives seaport_no_consideration, an unrecognised Seaport address gives seaport_unknown_deployment, and a shape it cannot read gives seaport_not_checkable. Give the minimum you expect to receive (smallest units, for example native:975000000000000000) and anything less gives seaport_dust_consideration.",
    ],
    keywords: ["eip712 hash", "verify typed data signature", "signTypedData decoder"],
    faq: [
      {
        q: "What can I use this for?",
        a: "Checking a permit, an order or a login message before you trust it: see what the digest commits to and which address signed it.",
      },
      {
        q: "Does it need my key?",
        a: "No. It only reads the typed data and a signature that already exists. Never paste a private key or seed phrase.",
      },
      {
        q: "What does low_s mean?",
        a: "Whether the signature uses the canonical low-s form most wallets and contracts require. A high-s signature can still recover an address but many contracts reject it.",
      },
      { q: "Is it safe?", a: SAFE_A },
    ],
    modes: [
      {
        id: "verify",
        label: "Check",
        fn: "typed-data-verify",
        fields: [
          { name: "typed_data", label: "Typed data (JSON)", kind: "block", max: 15000 },
          { name: "signature", label: "Signature (hex)", placeholder: "0x…", optional: true },
          { name: "signer", label: "Expected signer", placeholder: "0x…", optional: true },
          {
            name: "expect_chain_id",
            label: "Expected chain id",
            placeholder: "1",
            optional: true,
          },
          {
            name: "expect_verifying_contract",
            label: "Expected verifying contract",
            placeholder: "0x…",
            optional: true,
          },
          {
            name: "expect_spender",
            label: "Expected permit spender",
            placeholder: "0x…",
            optional: true,
          },
          {
            name: "expect_amount",
            label: "Expected permit amount (integer)",
            placeholder: "1000000",
            optional: true,
          },
          {
            name: "expect_min_consideration",
            label: "Expected Seaport minimum received (smallest units)",
            placeholder: "native:975000000000000000",
            optional: true,
          },
        ],
      },
    ],
    examples: [
      {
        label: "EIP-712 Mail example",
        mode: "verify",
        values: {
          typed_data:
            '{"types":{"EIP712Domain":[{"name":"name","type":"string"},{"name":"version","type":"string"},{"name":"chainId","type":"uint256"},{"name":"verifyingContract","type":"address"}],"Person":[{"name":"name","type":"string"},{"name":"wallet","type":"address"}],"Mail":[{"name":"from","type":"Person"},{"name":"to","type":"Person"},{"name":"contents","type":"string"}]},"primaryType":"Mail","domain":{"name":"Ether Mail","version":"1","chainId":1,"verifyingContract":"0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC"},"message":{"from":{"name":"Cow","wallet":"0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826"},"to":{"name":"Bob","wallet":"0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB"},"contents":"Hello, Bob!"}}',
          signature:
            "0x4355c47d63924e8a72e509b65029052eb6c299d53a04e167c5775fd466751c9d07299936d304c153f6443dfa05f40ff007d72911b6f72307f996231605b915621c",
          signer: "0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826",
        },
      },
    ],
    related: ["evm-abi", "bytecode-inspect", "create-address"],
  },
  {
    slug: "supported-chains",
    name: "Supported chains list",
    emoji: "🌐",
    mcp: "supported_chains",
    title: "Supported Crypto Chains: Verified Explorers & SLIP-44 Coin Types | SwapChan",
    description:
      "Every chain the address tools know, with ticker, SLIP-44 coin type, verification status and the explorer it was checked against.",
    h1: "Supported chains",
    intro:
      "The list of chains the address, xpub and script tools support, which are verified against a live explorer, and which are known but not yet verified.",
    body: [
      "A chain is marked verified once its address format and balances have been checked against a public explorer; each entry lists that explorer and the date it was checked. Unverified chains are known but not supported by the other tools yet.",
      "Look up one chain by name or ticker, or show the full list.",
    ],
    keywords: ["supported crypto chains", "slip44 coin type list"],
    faq: [
      {
        q: "What does verified mean?",
        a: "The chain's addresses and balances were checked against the listed public explorer on the listed date.",
      },
      {
        q: "Can I use an unverified chain?",
        a: "Not with the other tools. Unverified chains are listed so you can see what is coming, not used.",
      },
      { q: "Is it safe?", a: "Yes. It shows public constants only." },
    ],
    modes: [{ id: "show", label: "Show", fn: "supported-chains", fields: [chain(true)] }],
    examples: [
      { label: "Bitcoin", mode: "show", values: { chain: "btc" } },
      { label: "All chains", mode: "show", values: {} },
    ],
    related: ["chain-params", "validate-address", "convert-address"],
  },
];

export const devTool = (slug: string): DevTool | undefined =>
  DEV_TOOLS.find((t) => t.slug === slug);

/** Request body for one run: only declared fields, typed; seeds split per line. */
export function buildInput(mode: Mode, values: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = mode.op ? { op: mode.op } : {};
  for (const f of mode.fields) {
    const v = (values[f.name] ?? "").trim();
    if (!v) continue;
    if (f.kind === "number" || (f.kind === "select" && f.name === "branch"))
      out[f.name] = Number(v);
    else if (f.kind === "lines") out[f.name] = v.split(/\s+/).filter(Boolean);
    else out[f.name] = v;
  }
  return out;
}

/** Same rule as the API: never send private extended keys or seed phrases. */
export function looksSecret(values: Record<string, string>): boolean {
  return Object.values(values).some(
    (v) =>
      /\b[xtyzuvYZUV]prv[1-9A-HJ-NP-Za-km-z]{20,}/.test(v) ||
      /^([a-z]{3,8}\s+){11,23}[a-z]{3,8}$/.test(v.trim()),
  );
}

/** JSON-LD for one tool page: SoftwareApplication + FAQPage + BreadcrumbList. */
export function devToolLd(t: DevTool, site = "https://swapchan.com") {
  const url = `${site}/tools/${t.slug}`;
  return [
    {
      "@context": "https://schema.org",
      "@type": "SoftwareApplication",
      name: t.h1,
      url,
      applicationCategory: "DeveloperApplication",
      operatingSystem: "Any",
      offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
      description: t.description,
    },
    {
      "@context": "https://schema.org",
      "@type": "FAQPage",
      mainEntity: t.faq.map((f) => ({
        "@type": "Question",
        name: f.q,
        acceptedAnswer: { "@type": "Answer", text: f.a },
      })),
    },
    {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "Tools", item: `${site}/tools` },
        { "@type": "ListItem", position: 2, name: t.name, item: url },
      ],
    },
  ];
}

/** Which /tools pages to link from a result page (find_money, wallet history, recover). Slugs only from DEV_TOOLS. */
export const RELATED_FOR = {
  find_money: ["validate-address", "xpub-addresses", "convert-address", "chain-params"],
  wallet: ["validate-address", "convert-address", "ss58", "solana-pda"],
  recover: ["xpub-addresses", "address-script", "validate-address", "cashaddr"],
} as const;
export function relatedTools(ctx: keyof typeof RELATED_FOR): { href: string; name: string }[] {
  return RELATED_FOR[ctx].flatMap((s) => {
    const t = devTool(s);
    return t ? [{ href: `/tools/${t.slug}`, name: t.name }] : [];
  });
}
