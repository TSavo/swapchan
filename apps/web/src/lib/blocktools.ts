/** Client-safe blocktools hub data. Every fact is from the TSavo/blocktools README at 657458a. */
/** The one place the release version, tarball name and its SHA256 live. v0.4.0 is not tagged yet: TODO_V040_SHA256 must be replaced with the SHA256 of the v0.4.0 release asset (from its SHA256SUMS) before deploy. */
export const BT_VERSION = "v0.4.0";
export const BT_TARBALL_DIR = `blocktools-${BT_VERSION}-linux-x86_64`;
export const BT_TARBALL = `${BT_TARBALL_DIR}.tar.gz`;
export const BT_TARBALL_SHA256 = "TODO_V040_SHA256";
export const BT_INSTALL = [
  `gh release download ${BT_VERSION} -R TSavo/blocktools`,
  "sha256sum -c SHA256SUMS",
  `tar xzf ${BT_TARBALL}`,
  `cd ${BT_TARBALL_DIR}`,
  "export PATH=$PWD/bin:$PATH MANPATH=$PWD/share/man:",
  "man blocktools",
].join("\n");
export const BT_SOURCE_BUILD = [
  "git clone https://github.com/TSavo/blocktools && cd blocktools",
  "cargo build --locked --release --workspace",
  "./blocktools build",
].join("\n");

export type BtExample = {
  slug: string;
  title: string;
  description: string;
  input: string;
  cmds: string[];
  expect: string[];
  recipe: string;
};

/** README "Worked examples (public test fixtures only)": each command is run as written by CI. */
export const BT_EXAMPLES: BtExample[] = [
  {
    slug: "seed-phrase-to-addresses",
    title: "Seed phrase to Bitcoin and Ethereum addresses",
    description:
      "blocktools example: repair a 12-word BIP39 phrase with typos, then derive its first Bitcoin and Ethereum address in a sealed, offline run.",
    input:
      'in/seed.txt = the 12-word "abandon … about" BIP39 test vector. CI\'s copy has two typos, which seed-repair fixes before seed-to-master sees it.',
    cmds: [
      "./blocktools run 'seed-repair < /in/seed.txt | seed-to-master | derive --chain btc --count 1'",
      "./blocktools run 'seed-repair < /in/seed.txt | seed-to-master | derive --chain eth --count 1'",
    ],
    expect: [
      "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu",
      '"wif":"[REDACTED]"',
      "0x9858EfFD232B4033E47d90003D41EC34EcaEda94",
    ],
    recipe: "input-seed-phrase",
  },
  {
    slug: "bitcoin-core-wallet-dat",
    title: "Bitcoin Core wallet.dat to addresses",
    description:
      "blocktools example: open btcrecover's Bitcoin Core wallet.dat test file offline with dat-read and list its Bitcoin addresses.",
    input: "btcrecover's bitcoincore-wallet.dat (BDB) in ./in, its password in ./secrets.",
    cmds: [
      "./blocktools run 'read-file /secrets/multibit.pw /in/old-client-wallet.dat | dat-read | key-to-addresses --chain btc'",
    ],
    expect: ["1Ak4Z3NsRigsn9wpwZNoRobNzy9jokxQxx"],
    recipe: "input-wallet-dat",
  },
  {
    slug: "ethereum-keystore",
    title: "Ethereum keystore JSON to address",
    description:
      "blocktools example: decrypt the Web3 Secret Storage test keystore with keystore-open in a sealed run and print its Ethereum address.",
    input: "The Web3 Secret Storage test vector keystore, password testpassword.",
    cmds: ["./blocktools run 'read-file /secrets/keystore.pw /in/keystore.json | keystore-open'"],
    expect: ["0x008AeEda4D805471dF9b2A5B0f38A0C3bCBA786b"],
    recipe: "input-keystore",
  },
  {
    slug: "electrum-wallet",
    title: "Electrum wallet file to addresses",
    description:
      "blocktools example: read btcrecover's Electrum 4.4.3 test wallet with electrum-read and derive its first Bitcoin address offline.",
    input: "btcrecover's Electrum 4.4.3 wallet.",
    cmds: [
      "./blocktools run 'read-file /secrets/electrum.pw /in/electrum-wallet | electrum-read | seed-to-master | derive --chain btc --count 1'",
    ],
    expect: ["bc1qsz0dhew357cj6eznmcawgyf44jzpgcax2lvfvm"],
    recipe: "input-electrum",
  },
  {
    slug: "multibit-classic",
    title: "MultiBit Classic .key to addresses",
    description:
      "blocktools example: open a MultiBit Classic .key export with multibit-read and list its Bitcoin addresses offline.",
    input: "A MultiBit Classic .key export (btcrecover fixture).",
    cmds: [
      "./blocktools run 'read-file /secrets/multibit.pw /in/multibit.key | multibit-read | key-to-addresses --chain btc'",
    ],
    expect: ["166UVSG9WX81Pkp9f8o4htYV9M3KBqXHdV"],
    recipe: "input-multibit",
  },
  {
    slug: "armory-wallet",
    title: "Armory .wallet to addresses",
    description:
      "blocktools example: open an Armory .wallet file with armory-read and list its Bitcoin addresses in a sealed run.",
    input: "An Armory .wallet (btcrecover fixture).",
    cmds: [
      "./blocktools run 'read-file /secrets/armory.pw /in/armory.wallet | armory-read | key-to-addresses --chain btc'",
    ],
    expect: ["1H29eJEsQCtwCRc737gZyD7HtpxxdQNQzv"],
    recipe: "input-armory",
  },
  {
    slug: "classify-unknown-file",
    title: "Identify an unknown wallet file",
    description:
      "blocktools example: not sure what a file is? classify names it, and recipes/recover.sh picks the pipeline for you.",
    input: "Any wallet file in ./in (here btcrecover's old-client wallet.dat).",
    cmds: [
      "./blocktools run 'classify /in/old-client-wallet.dat'",
      "recipes/recover.sh FILE - --goal addresses",
    ],
    expect: ['"class":"wallet_dat"'],
    recipe: "input-unknown",
  },
];

/** SwapChan web tools built on the blocktools wasm (lib/devTools.ts), keyed by man-page tool. */
export const BT_ON_SWAPCHAN: { tool: string; href: string; label: string }[] = [
  { tool: "xpub-addresses", href: "/tools/xpub-addresses", label: "Xpub to addresses" },
  { tool: "create-address", href: "/tools/create-address", label: "CREATE / CREATE2 address" },
  {
    tool: "bytecode-inspect",
    href: "/tools/bytecode-inspect",
    label: "Contract bytecode inspector",
  },
  { tool: "typed-data-verify", href: "/tools/typed-data-verify", label: "EIP-712 typed data" },
  { tool: "abi-decode", href: "/tools/evm-abi", label: "ABI decoder" },
  { tool: "sol-tron-tx", href: "/tools/tron-tx", label: "Tron raw_data decoder" },
  { tool: "chain-table", href: "/tools/chain-params", label: "Chain parameters table" },
];

/** Man(1) pages grouped by job: a subset of the 58 in v0.4.0, including blocktools and recover.sh. */
export const BT_GROUPS: { id: string; label: string; blurb: string; tools: string[] }[] = [
  {
    id: "recover",
    label: "Read wallets and derive addresses",
    blurb: "Old wallet files and seed phrases in, public addresses out.",
    tools: [
      "classify",
      "recover.sh",
      "seed-repair",
      "seed-to-master",
      "derive",
      "key-to-addresses",
      "xpub-addresses",
      "keystore-open",
      "dat-read",
      "electrum-read",
      "armory-read",
      "multibit-read",
      "blockchain-read",
      "bip38-open",
      "phrase-to-key",
      "pw-candidates",
      "xmr-keys",
      "zec-sapling",
    ],
  },
  {
    id: "tx",
    label: "Build, check, sign and send transactions",
    blurb:
      "Unsigned transactions are built offline; a human types a code before signing and before broadcast.",
    tools: [
      "utxo-fetch",
      "tx-build",
      "tx-decode",
      "tx-verify",
      "tx-envelope",
      "tx-sign",
      "tx-broadcast",
      "acct-tx",
      "sol-tron-tx",
      "xrp-tx",
      "xmr-wallet",
    ],
  },
  {
    id: "contracts",
    label: "Contracts, ABI and messages",
    blurb: "Offline EVM helpers and message signatures.",
    tools: [
      "abi-encode",
      "abi-decode",
      "abi-inspect",
      "sig-hash",
      "create-address",
      "bytecode-inspect",
      "typed-data-verify",
      "msg-verify",
      "msg-sign",
      "siwe",
    ],
  },
  {
    id: "plumbing",
    label: "Chains, RPC and the sealed boundary",
    blurb: "The chain registry, node RPC, and the tools that keep secrets inside the sealed run.",
    tools: ["chain-table", "rpc", "blocktools", "sealed-run", "redact", "read-file"],
  },
];
